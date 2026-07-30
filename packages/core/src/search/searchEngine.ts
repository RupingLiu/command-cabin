import Fuse from 'fuse.js';
import type { FuseResult, FuseResultMatch, IFuseOptions } from 'fuse.js';

import { cloneCommand } from '../command/commandJson.js';
import type { Command } from '../command/types.js';
import {
  rankSearchCandidate,
  type SearchMatchedBy,
  type SearchMatchField,
  type SearchRankingContext,
  type SearchRankingExplanation,
} from './ranking.js';
import {
  normalizeSearchText,
  normalizeSearchTextWithMapping,
  type SearchTextSourceRange,
} from './tokenize.js';

const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_RANKING_CANDIDATE_LIMIT = 100;
const MAX_CACHED_FUSE_QUERIES = 32;
const SEARCH_MATCH_FIELD_ORDER: readonly SearchMatchField[] = [
  'title',
  'subtitle',
  'keywords',
  'empty-query',
];

interface SearchDocument {
  command: Command;
  title: string;
  normalizedTitle: string;
  titleSourceRanges: readonly SearchTextSourceRange[];
  subtitle?: string;
  normalizedSubtitle?: string;
  subtitleSourceRanges?: readonly SearchTextSourceRange[];
  keywords: string[];
  normalizedKeywords: string[];
  keywordSourceRanges: ReadonlyArray<readonly SearchTextSourceRange[]>;
}

interface RankedSearchCandidate {
  document: SearchDocument;
  score: number;
  fuseScore: number;
  matchedBy: SearchMatchedBy[];
  ranking: SearchRankingExplanation;
}

export interface SearchEngineOptions {
  limit?: number;
  threshold?: number;
  includeAllOnEmptyQuery?: boolean;
}

export interface SearchOptions {
  limit?: number;
  includeAllOnEmptyQuery?: boolean;
  ranking?: SearchRankingContext;
}

export interface SearchResult {
  command: Command;
  /**
   * Final CommandCabin ranking score. Higher values sort first.
   */
  score: number;
  /**
   * Raw Fuse.js score. Lower values are better, with 0 representing an exact match.
   */
  fuseScore: number;
  matchedBy: SearchMatchedBy[];
  ranking: SearchRankingExplanation;
}

function normalizeLimit(limit: number, label: string): number {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(`${label} must be a safe integer >= 0`);
  }

  return limit;
}

function normalizeThreshold(threshold: number): number {
  if (
    typeof threshold !== 'number' ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    throw new Error('Search threshold must be a finite number between 0 and 1');
  }

  return threshold;
}

function createSearchDocument(command: Command): SearchDocument {
  const clonedCommand = cloneCommand(command);
  const normalizedTitle = normalizeSearchTextWithMapping(clonedCommand.title);
  const normalizedKeywords = clonedCommand.keywords.map(normalizeSearchTextWithMapping);
  const document: SearchDocument = {
    command: clonedCommand,
    title: clonedCommand.title,
    normalizedTitle: normalizedTitle.normalizedText,
    titleSourceRanges: normalizedTitle.sourceRanges,
    keywords: [...clonedCommand.keywords],
    normalizedKeywords: normalizedKeywords.map((keyword) => keyword.normalizedText),
    keywordSourceRanges: normalizedKeywords.map((keyword) => keyword.sourceRanges),
  };

  if (clonedCommand.subtitle !== undefined) {
    const normalizedSubtitle = normalizeSearchTextWithMapping(clonedCommand.subtitle);

    document.subtitle = clonedCommand.subtitle;
    document.normalizedSubtitle = normalizedSubtitle.normalizedText;
    document.subtitleSourceRanges = normalizedSubtitle.sourceRanges;
  }

  return document;
}

function createFuseOptions(threshold: number): IFuseOptions<SearchDocument> {
  return {
    includeScore: true,
    includeMatches: true,
    threshold,
    ignoreLocation: true,
    shouldSort: true,
    keys: [
      { name: 'title', weight: 3 },
      { name: 'subtitle', weight: 2 },
      { name: 'keywords', weight: 1 },
    ],
  };
}

function getSearchMatchField(match: FuseResultMatch): SearchMatchField | undefined {
  if (
    match.key === 'title' ||
    match.key === 'subtitle' ||
    match.key === 'keywords' ||
    match.key === 'empty-query'
  ) {
    return match.key;
  }

  return undefined;
}

function cloneIndices(
  indices: ReadonlyArray<readonly [number, number]>,
): ReadonlyArray<readonly [number, number]> {
  return indices.map(([start, end]) => [start, end] as const);
}

function compareMatchedBy(left: SearchMatchedBy, right: SearchMatchedBy): number {
  const fieldDelta =
    SEARCH_MATCH_FIELD_ORDER.indexOf(left.field) - SEARCH_MATCH_FIELD_ORDER.indexOf(right.field);

  if (fieldDelta !== 0) {
    return fieldDelta;
  }

  if ((left.refIndex ?? -1) !== (right.refIndex ?? -1)) {
    return (left.refIndex ?? -1) - (right.refIndex ?? -1);
  }

  return (left.value ?? '').localeCompare(right.value ?? '');
}

function createMatchedBy(matches: ReadonlyArray<FuseResultMatch> | undefined): SearchMatchedBy[] {
  if (!matches) {
    return [];
  }

  const matchedBy: SearchMatchedBy[] = [];

  for (const match of matches) {
    const field = getSearchMatchField(match);

    if (!field) {
      continue;
    }

    const searchMatch: SearchMatchedBy = {
      field,
      indices: cloneIndices(match.indices),
    };

    if (match.value !== undefined) {
      searchMatch.value = match.value;
    }

    if (match.refIndex !== undefined) {
      searchMatch.refIndex = match.refIndex;
    }

    matchedBy.push(searchMatch);
  }

  return matchedBy.sort(compareMatchedBy);
}

function createEmptyQueryMatchedBy(): SearchMatchedBy[] {
  return [
    {
      field: 'empty-query',
      value: '',
      indices: [],
    },
  ];
}

function appendExactMatch(
  matchedBy: SearchMatchedBy[],
  field: SearchMatchField,
  value: string,
  normalizedValue: string,
  sourceRanges: readonly SearchTextSourceRange[],
  normalizedQuery: string,
  refIndex?: number,
): void {
  const startIndex = normalizedValue.indexOf(normalizedQuery);

  if (startIndex < 0) {
    return;
  }

  const endIndex = startIndex + normalizedQuery.length - 1;
  const startRange = sourceRanges[startIndex];
  const endRange = sourceRanges[endIndex];

  if (startRange === undefined || endRange === undefined) {
    return;
  }

  const match: SearchMatchedBy = {
    field,
    value,
    indices: [[startRange[0], endRange[1]]],
  };

  if (refIndex !== undefined) {
    match.refIndex = refIndex;
  }

  matchedBy.push(match);
}

function createExactMatchedBy(
  document: SearchDocument,
  normalizedQuery: string,
): SearchMatchedBy[] {
  const matchedBy: SearchMatchedBy[] = [];

  appendExactMatch(
    matchedBy,
    'title',
    document.title,
    document.normalizedTitle,
    document.titleSourceRanges,
    normalizedQuery,
  );

  if (
    document.subtitle !== undefined &&
    document.normalizedSubtitle !== undefined &&
    document.subtitleSourceRanges !== undefined
  ) {
    appendExactMatch(
      matchedBy,
      'subtitle',
      document.subtitle,
      document.normalizedSubtitle,
      document.subtitleSourceRanges,
      normalizedQuery,
    );
  }

  document.keywords.forEach((keyword, index) => {
    appendExactMatch(
      matchedBy,
      'keywords',
      keyword,
      document.normalizedKeywords[index] ?? '',
      document.keywordSourceRanges[index] ?? [],
      normalizedQuery,
      index,
    );
  });

  return matchedBy.sort(compareMatchedBy);
}

function compareRankedSearchCandidates(
  left: Pick<RankedSearchCandidate, 'document' | 'score' | 'fuseScore'>,
  right: Pick<RankedSearchCandidate, 'document' | 'score' | 'fuseScore'>,
): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  if (left.fuseScore !== right.fuseScore) {
    return left.fuseScore - right.fuseScore;
  }

  const leftTitle = left.document.normalizedTitle;
  const rightTitle = right.document.normalizedTitle;

  if (leftTitle !== rightTitle) {
    return leftTitle < rightTitle ? -1 : 1;
  }

  return left.document.command.id < right.document.command.id
    ? -1
    : left.document.command.id > right.document.command.id
      ? 1
      : 0;
}

function createRankedSearchCandidate(
  query: string,
  document: SearchDocument,
  fuseScore: number,
  matchedBy: SearchMatchedBy[],
  context: SearchRankingContext | undefined,
): RankedSearchCandidate {
  const rank = rankSearchCandidate({
    command: document.command,
    query,
    fuseScore,
    matchedBy,
    context,
  });

  return {
    document,
    score: rank.score,
    fuseScore,
    matchedBy,
    ranking: rank.explanation,
  };
}

function toSearchResult(candidate: RankedSearchCandidate): SearchResult {
  return {
    command: cloneCommand(candidate.document.command),
    score: candidate.score,
    fuseScore: candidate.fuseScore,
    matchedBy: candidate.matchedBy,
    ranking: candidate.ranking,
  };
}

function insertTopCandidate(
  topCandidates: RankedSearchCandidate[],
  candidate: RankedSearchCandidate,
  limit: number,
): void {
  if (topCandidates.length === limit) {
    const worstCandidate = topCandidates[topCandidates.length - 1];

    if (worstCandidate && compareRankedSearchCandidates(candidate, worstCandidate) >= 0) {
      return;
    }
  }

  const insertIndex = topCandidates.findIndex(
    (existingCandidate) => compareRankedSearchCandidates(candidate, existingCandidate) < 0,
  );

  if (insertIndex === -1) {
    topCandidates.push(candidate);
  } else {
    topCandidates.splice(insertIndex, 0, candidate);
  }

  if (topCandidates.length > limit) {
    topCandidates.pop();
  }
}

export class SearchEngine {
  private documents: SearchDocument[] = [];
  private documentsById = new Map<string, SearchDocument>();
  private fuse: Fuse<SearchDocument>;
  private readonly fuseResultsCache = new Map<string, readonly FuseResult<SearchDocument>[]>();
  private readonly options: Required<SearchEngineOptions>;

  constructor(commands: readonly Command[] = [], options: SearchEngineOptions = {}) {
    this.options = {
      limit: normalizeLimit(options.limit ?? DEFAULT_SEARCH_LIMIT, 'Search limit'),
      threshold: normalizeThreshold(options.threshold ?? 0.4),
      includeAllOnEmptyQuery: options.includeAllOnEmptyQuery ?? true,
    };
    this.fuse = new Fuse<SearchDocument>([], createFuseOptions(this.options.threshold));
    this.update(commands);
  }

  update(commands: readonly Command[]): void {
    this.documents = commands.map(createSearchDocument);
    this.documentsById = new Map(
      this.documents.map((document) => [document.command.id, document] as const),
    );
    this.fuse = new Fuse(this.documents, createFuseOptions(this.options.threshold));
    this.fuseResultsCache.clear();
  }

  upsert(command: Command): void {
    const nextDocuments = this.documents.filter((document) => document.command.id !== command.id);
    nextDocuments.push(createSearchDocument(command));
    this.update(nextDocuments.map((document) => document.command));
  }

  remove(commandId: string): boolean {
    const nextDocuments = this.documents.filter((document) => document.command.id !== commandId);
    const removed = nextDocuments.length !== this.documents.length;

    if (removed) {
      this.update(nextDocuments.map((document) => document.command));
    }

    return removed;
  }

  clear(): void {
    this.update([]);
  }

  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const normalizedQuery = normalizeSearchText(query);
    const limit = normalizeLimit(options.limit ?? this.options.limit, 'Search limit');

    if (limit === 0) {
      return [];
    }

    if (normalizedQuery.length === 0) {
      return this.searchEmptyQuery(query, limit, options);
    }

    return this.searchRankedQuery(query, normalizedQuery, limit, options.ranking);
  }

  private searchRankedQuery(
    query: string,
    normalizedQuery: string,
    limit: number,
    context: SearchRankingContext | undefined,
  ): SearchResult[] {
    const topCandidates: RankedSearchCandidate[] = [];
    const exactDocuments = new Set<SearchDocument>();

    for (const document of this.documents) {
      const exactMatchedBy = createExactMatchedBy(document, normalizedQuery);

      if (exactMatchedBy.length === 0) {
        continue;
      }

      exactDocuments.add(document);
      insertTopCandidate(
        topCandidates,
        createRankedSearchCandidate(query, document, 0, exactMatchedBy, context),
        limit,
      );
    }

    if (exactDocuments.size === this.documents.length) {
      return topCandidates.map(toSearchResult);
    }

    const fuseCandidateDocuments = new Set<SearchDocument>();
    const fuseCandidateLimit = Math.max(limit, DEFAULT_RANKING_CANDIDATE_LIMIT);

    for (const result of this.searchFuse(normalizedQuery, fuseCandidateLimit)) {
      fuseCandidateDocuments.add(result.item);

      if (exactDocuments.has(result.item)) {
        continue;
      }

      insertTopCandidate(
        topCandidates,
        createRankedSearchCandidate(
          query,
          result.item,
          result.score ?? 1,
          createMatchedBy(result.matches),
          context,
        ),
        limit,
      );
    }

    const boostedDocuments = this.getBoostedDocuments(context).filter(
      (document) => !exactDocuments.has(document) && !fuseCandidateDocuments.has(document),
    );

    if (boostedDocuments.length > 0) {
      const boostedFuse = new Fuse(boostedDocuments, createFuseOptions(this.options.threshold));

      for (const result of boostedFuse.search(normalizedQuery)) {
        insertTopCandidate(
          topCandidates,
          createRankedSearchCandidate(
            query,
            result.item,
            result.score ?? 1,
            createMatchedBy(result.matches),
            context,
          ),
          limit,
        );
      }
    }

    return topCandidates.map(toSearchResult);
  }

  private searchFuse(
    normalizedQuery: string,
    candidateLimit: number,
  ): readonly FuseResult<SearchDocument>[] {
    const cacheKey = `${candidateLimit}\u0000${normalizedQuery}`;
    const cachedResults = this.fuseResultsCache.get(cacheKey);

    if (cachedResults !== undefined) {
      this.fuseResultsCache.delete(cacheKey);
      this.fuseResultsCache.set(cacheKey, cachedResults);
      return cachedResults;
    }

    const results = this.fuse.search(normalizedQuery, { limit: candidateLimit });
    this.fuseResultsCache.set(cacheKey, results);

    if (this.fuseResultsCache.size > MAX_CACHED_FUSE_QUERIES) {
      const oldestCacheKey = this.fuseResultsCache.keys().next().value;

      if (oldestCacheKey !== undefined) {
        this.fuseResultsCache.delete(oldestCacheKey);
      }
    }

    return results;
  }

  private getBoostedDocuments(context: SearchRankingContext | undefined): SearchDocument[] {
    const boostedCommandIds = new Set<string>();

    if (context?.pinnedCommandIds) {
      for (const commandId of context.pinnedCommandIds) {
        boostedCommandIds.add(commandId);
      }
    }

    if (context?.history instanceof Map) {
      for (const commandId of context.history.keys()) {
        boostedCommandIds.add(commandId);
      }
    } else if (context?.history) {
      for (const commandId of Object.keys(context.history)) {
        boostedCommandIds.add(commandId);
      }
    }

    return Array.from(boostedCommandIds, (commandId) => this.documentsById.get(commandId)).filter(
      (document): document is SearchDocument => document !== undefined,
    );
  }

  private searchEmptyQuery(query: string, limit: number, options: SearchOptions): SearchResult[] {
    const includeAllOnEmptyQuery =
      options.includeAllOnEmptyQuery ?? this.options.includeAllOnEmptyQuery;

    if (!includeAllOnEmptyQuery) {
      return [];
    }

    return this.collectTopSearchResults(this.documents, limit, (document) =>
      createRankedSearchCandidate(query, document, 1, createEmptyQueryMatchedBy(), options.ranking),
    );
  }

  private collectTopSearchResults<T>(
    values: Iterable<T>,
    limit: number,
    createCandidate: (value: T) => RankedSearchCandidate,
  ): SearchResult[] {
    const topCandidates: RankedSearchCandidate[] = [];

    for (const value of values) {
      insertTopCandidate(topCandidates, createCandidate(value), limit);
    }

    return topCandidates.map(toSearchResult);
  }
}

export function createSearchEngine(
  commands: readonly Command[] = [],
  options: SearchEngineOptions = {},
): SearchEngine {
  return new SearchEngine(commands, options);
}
