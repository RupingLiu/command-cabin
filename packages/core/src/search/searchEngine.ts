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
import { normalizeSearchText } from './tokenize.js';

const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_RANKING_CANDIDATE_LIMIT = 100;
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
  subtitle?: string;
  normalizedSubtitle?: string;
  keywords: string[];
  normalizedKeywords: string[];
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
  const document: SearchDocument = {
    command: clonedCommand,
    title: clonedCommand.title,
    normalizedTitle: normalizeSearchText(clonedCommand.title),
    keywords: [...clonedCommand.keywords],
    normalizedKeywords: clonedCommand.keywords.map(normalizeSearchText),
  };

  if (clonedCommand.subtitle !== undefined) {
    document.subtitle = clonedCommand.subtitle;
    document.normalizedSubtitle = normalizeSearchText(clonedCommand.subtitle);
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
  normalizedQuery: string,
  refIndex?: number,
): void {
  const startIndex = normalizedValue.indexOf(normalizedQuery);

  if (startIndex < 0) {
    return;
  }

  const match: SearchMatchedBy = {
    field,
    value,
    indices: [[startIndex, startIndex + normalizedQuery.length - 1]],
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

  appendExactMatch(matchedBy, 'title', document.title, document.normalizedTitle, normalizedQuery);

  if (document.subtitle !== undefined && document.normalizedSubtitle !== undefined) {
    appendExactMatch(
      matchedBy,
      'subtitle',
      document.subtitle,
      document.normalizedSubtitle,
      normalizedQuery,
    );
  }

  document.keywords.forEach((keyword, index) => {
    appendExactMatch(
      matchedBy,
      'keywords',
      keyword,
      document.normalizedKeywords[index] ?? '',
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

  const leftTitle = normalizeSearchText(left.document.command.title);
  const rightTitle = normalizeSearchText(right.document.command.title);

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

    const exactResults = this.searchExactQuery(query, normalizedQuery, limit, options.ranking);

    if (exactResults) {
      return exactResults;
    }

    const fuseResults = this.createRankedFuseCandidates(normalizedQuery, limit, options.ranking);

    return this.collectTopSearchResults(fuseResults, limit, (result) =>
      this.createCandidateFromFuseResult(query, result, options.ranking),
    );
  }

  private searchExactQuery(
    query: string,
    normalizedQuery: string,
    limit: number,
    context: SearchRankingContext | undefined,
  ): SearchResult[] | undefined {
    const topCandidates: RankedSearchCandidate[] = [];
    const exactCommandIds = new Set<string>();
    let exactMatchCount = 0;

    for (const document of this.documents) {
      const matchedBy = createExactMatchedBy(document, normalizedQuery);

      if (matchedBy.length === 0) {
        continue;
      }

      exactMatchCount += 1;
      exactCommandIds.add(document.command.id);
      insertTopCandidate(
        topCandidates,
        createRankedSearchCandidate(query, document, 0, matchedBy, context),
        limit,
      );
    }

    if (exactMatchCount < limit) {
      return undefined;
    }

    const boostedDocuments = this.getBoostedDocuments(context).filter(
      (document) => !exactCommandIds.has(document.command.id),
    );

    if (boostedDocuments.length > 0) {
      const boostedFuse = new Fuse(boostedDocuments, createFuseOptions(this.options.threshold));

      for (const result of boostedFuse.search(normalizedQuery)) {
        insertTopCandidate(
          topCandidates,
          this.createCandidateFromFuseResult(query, result, context),
          limit,
        );
      }
    }

    return topCandidates.map(toSearchResult);
  }

  private createRankedFuseCandidates(
    normalizedQuery: string,
    limit: number,
    context: SearchRankingContext | undefined,
  ): FuseResult<SearchDocument>[] {
    const candidateLimit = Math.max(limit, DEFAULT_RANKING_CANDIDATE_LIMIT);
    const fuseResults = this.fuse.search(normalizedQuery, {
      limit: candidateLimit,
    });
    const candidateIds = new Set(fuseResults.map((result) => result.item.command.id));
    const boostedDocuments = this.getBoostedDocuments(context).filter(
      (document) => !candidateIds.has(document.command.id),
    );

    if (boostedDocuments.length === 0) {
      return fuseResults;
    }

    const boostedFuse = new Fuse(boostedDocuments, createFuseOptions(this.options.threshold));
    return [...fuseResults, ...boostedFuse.search(normalizedQuery)];
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

  private createCandidateFromFuseResult(
    query: string,
    result: FuseResult<SearchDocument>,
    context: SearchRankingContext | undefined,
  ): RankedSearchCandidate {
    return createRankedSearchCandidate(
      query,
      result.item,
      result.score ?? 1,
      createMatchedBy(result.matches),
      context,
    );
  }
}

export function createSearchEngine(
  commands: readonly Command[] = [],
  options: SearchEngineOptions = {},
): SearchEngine {
  return new SearchEngine(commands, options);
}
