import type { Command, CommandSource } from '../command/types.js';
import { normalizeSearchText } from './tokenize.js';

export const SEARCH_FIELD_SCORE_WEIGHTS = {
  title: 0.3,
  subtitle: 0.2,
  keywords: 0.1,
  'empty-query': 0,
} as const;

export const SEARCH_RANKING_BOOSTS = {
  exactTitle: 0.4,
  pinned: 0.35,
  recent: 0.25,
  historyScale: 0.08,
  maxHistory: 0.3,
} as const;

export const SEARCH_SOURCE_SCORE_WEIGHTS: Record<CommandSource, number> = {
  system: 0.16,
  app: 0.14,
  url: 0.1,
  file: 0.06,
  plugin: 0.04,
};

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SCORE_PRECISION = 1_000_000;

export type SearchMatchField = keyof typeof SEARCH_FIELD_SCORE_WEIGHTS;

export interface SearchMatchedBy {
  field: SearchMatchField;
  indices: ReadonlyArray<readonly [number, number]>;
  value?: string;
  refIndex?: number;
}

export interface SearchRankingHistoryEntry {
  executionCount?: number;
  lastUsedAt?: Date | string | number;
  executedAt?: Date | string | number;
}

export interface SearchRankingContext {
  pinnedCommandIds?: readonly string[] | ReadonlySet<string>;
  history?:
    | Readonly<Record<string, SearchRankingHistoryEntry>>
    | ReadonlyMap<string, SearchRankingHistoryEntry>;
  sourceWeights?: Readonly<Partial<Record<CommandSource, number>>>;
  now?: Date | string | number;
}

export interface SearchRankingInput {
  command: Command;
  query: string;
  /**
   * Raw Fuse.js score. Lower values are better, with 0 representing an exact match.
   */
  fuseScore: number;
  matchedBy: readonly SearchMatchedBy[];
  context?: SearchRankingContext | undefined;
}

export interface SearchRankingComponents {
  /**
   * Fuse score converted to CommandCabin's higher-is-better direction.
   */
  fuzzy: number;
  /**
   * Matched-field contribution from title/subtitle/keyword matches.
   */
  field: number;
  /**
   * Command-source contribution. Defaults prefer system/app commands over lower-frequency sources.
   */
  source: number;
  history: number;
  pinned: number;
  recent: number;
  exactTitle: number;
}

export interface SearchRankingExplanation {
  components: SearchRankingComponents;
  normalizedQuery: string;
  normalizedTitle: string;
  matchedFields: SearchMatchField[];
  history?: {
    executionCount: number;
    lastUsedAt?: string;
  };
}

export interface SearchRankingResult {
  /**
   * Final CommandCabin ranking score. Higher values sort first.
   */
  score: number;
  explanation: SearchRankingExplanation;
}

function roundScore(value: number): number {
  return Math.round(value * SCORE_PRECISION) / SCORE_PRECISION;
}

function normalizeFuseScore(fuseScore: number): number {
  if (!Number.isFinite(fuseScore)) {
    return 0;
  }

  return Math.max(0, Math.min(1, 1 - fuseScore));
}

function getUniqueMatchedFields(matchedBy: readonly SearchMatchedBy[]): SearchMatchField[] {
  const fields = new Set<SearchMatchField>();

  for (const match of matchedBy) {
    fields.add(match.field);
  }

  return Array.from(fields);
}

function scoreMatchedFields(matchedBy: readonly SearchMatchedBy[]): number {
  return getUniqueMatchedFields(matchedBy).reduce(
    (score, field) => score + SEARCH_FIELD_SCORE_WEIGHTS[field],
    0,
  );
}

function normalizeScoreWeight(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, value);
}

function scoreCommandSource(command: Command, context: SearchRankingContext | undefined): number {
  return normalizeScoreWeight(
    context?.sourceWeights?.[command.source],
    SEARCH_SOURCE_SCORE_WEIGHTS[command.source],
  );
}

function hasPinnedCommand(context: SearchRankingContext | undefined, commandId: string): boolean {
  const pinnedCommandIds = context?.pinnedCommandIds;

  if (!pinnedCommandIds) {
    return false;
  }

  if (Array.isArray(pinnedCommandIds)) {
    return (pinnedCommandIds as readonly string[]).includes(commandId);
  }

  return (pinnedCommandIds as ReadonlySet<string>).has(commandId);
}

function getHistoryEntry(
  context: SearchRankingContext | undefined,
  commandId: string,
): SearchRankingHistoryEntry | undefined {
  const history = context?.history;

  if (!history) {
    return undefined;
  }

  return history instanceof Map
    ? history.get(commandId)
    : (history as Readonly<Record<string, SearchRankingHistoryEntry>>)[commandId];
}

function normalizeExecutionCount(executionCount: number | undefined): number {
  if (typeof executionCount !== 'number' || !Number.isFinite(executionCount)) {
    return 0;
  }

  return Math.max(0, Math.floor(executionCount));
}

function scoreHistory(executionCount: number): number {
  return Math.min(
    SEARCH_RANKING_BOOSTS.maxHistory,
    Math.log1p(executionCount) * SEARCH_RANKING_BOOSTS.historyScale,
  );
}

function toTimestamp(value: Date | string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();

  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function scoreRecentUse(
  historyEntry: SearchRankingHistoryEntry | undefined,
  context: SearchRankingContext | undefined,
): number {
  const nowTimestamp = toTimestamp(context?.now);
  const lastUsedTimestamp = toTimestamp(historyEntry?.lastUsedAt ?? historyEntry?.executedAt);

  if (nowTimestamp === undefined || lastUsedTimestamp === undefined) {
    return 0;
  }

  const ageMs = Math.max(0, nowTimestamp - lastUsedTimestamp);

  if (ageMs >= RECENT_WINDOW_MS) {
    return 0;
  }

  return SEARCH_RANKING_BOOSTS.recent * (1 - ageMs / RECENT_WINDOW_MS);
}

function getHistoryDebug(
  historyEntry: SearchRankingHistoryEntry | undefined,
): SearchRankingExplanation['history'] {
  if (!historyEntry) {
    return undefined;
  }

  const executionCount = normalizeExecutionCount(historyEntry.executionCount);
  const lastUsedAt = historyEntry.lastUsedAt ?? historyEntry.executedAt;
  const lastUsedTimestamp = toTimestamp(lastUsedAt);

  if (lastUsedTimestamp === undefined) {
    return {
      executionCount,
    };
  }

  return {
    executionCount,
    lastUsedAt: new Date(lastUsedTimestamp).toISOString(),
  };
}

export function rankSearchCandidate(input: SearchRankingInput): SearchRankingResult {
  const normalizedQuery = normalizeSearchText(input.query);
  const normalizedTitle = normalizeSearchText(input.command.title);
  const historyEntry = getHistoryEntry(input.context, input.command.id);
  const executionCount = normalizeExecutionCount(historyEntry?.executionCount);
  const components: SearchRankingComponents = {
    fuzzy: roundScore(normalizeFuseScore(input.fuseScore)),
    field: roundScore(scoreMatchedFields(input.matchedBy)),
    source: roundScore(scoreCommandSource(input.command, input.context)),
    history: roundScore(scoreHistory(executionCount)),
    pinned: hasPinnedCommand(input.context, input.command.id) ? SEARCH_RANKING_BOOSTS.pinned : 0,
    recent: roundScore(scoreRecentUse(historyEntry, input.context)),
    exactTitle:
      normalizedQuery.length > 0 && normalizedQuery === normalizedTitle
        ? SEARCH_RANKING_BOOSTS.exactTitle
        : 0,
  };
  const score = roundScore(
    components.fuzzy +
      components.field +
      components.source +
      components.history +
      components.pinned +
      components.recent +
      components.exactTitle,
  );
  const historyDebug = getHistoryDebug(historyEntry);
  const explanation: SearchRankingExplanation = {
    components,
    normalizedQuery,
    normalizedTitle,
    matchedFields: getUniqueMatchedFields(input.matchedBy),
  };

  if (historyDebug) {
    explanation.history = historyDebug;
  }

  return {
    score,
    explanation,
  };
}
