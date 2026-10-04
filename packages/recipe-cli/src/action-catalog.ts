// Action catalog helpers for host CLIs. A host resolves its own action manifest (its policy decides
// which libraries and actions count) and uses these to look actions up, search, group and compare
// them across platform adapters, so every front door ranks and resolves actions the same way.

import { levenshtein } from './discovery-index.js';

/** The fields lookup and search rank an action on. */
export interface CatalogAction {
  name: string;
  /** Grouping label, e.g. from `actionCategory`. */
  category: string;
  /** Parameter names. */
  fields: string[];
  description: string;
}

export interface ActionCategorySummary {
  name: string;
  count: number;
}

export type ActionSupport = 'available' | 'unavailable';

/** One action across every adapter of a matrix. */
export interface ActionMatrixRow<Adapter extends string = string> {
  name: string;
  category: string;
  description: string;
  fields: string[];
  support: Record<Adapter, ActionSupport>;
  /** Adapters that provide the action, in matrix order. */
  satisfyingAdapters: Adapter[];
}

export interface AdapterActionCatalog<Adapter extends string, Action extends CatalogAction> {
  adapter: Adapter;
  actions: readonly Action[];
}

/** An action the selected adapter lacks, with the adapters that provide it. */
export interface ActionCapabilityRefusal<Adapter extends string = string> {
  capability: string;
  satisfyingAdapters: Adapter[];
}

const GENERIC_OPERATION_TERMS = new Set([
  'assert',
  'call',
  'close',
  'ensure',
  'place',
  'read',
  'start',
  'teardown',
]);

/**
 * Category of an action name. Official actions group by role (runtime, ui, assertion, evidence,
 * control); a name under a vendor namespace (`metamask.perps.open`) groups by its second segment;
 * any other dotted name groups by its first segment.
 */
export function actionCategory(name: string, namespaces: readonly string[] = []): string {
  const segments = name.split('.');
  if (namespaces.includes(segments[0]!) && segments.length > 2) return segments[1] ?? segments[0]!;
  if (segments[0] === 'app' || segments[0] === 'cdp') return 'runtime';
  if (segments[0] === 'ui') return 'ui';
  if (name.startsWith('assert_')) return 'assertion';
  if (name === 'watch_logs' || name === 'index_artifacts') return 'evidence';
  if (name === 'command' || name === 'wait' || name === 'call' || name === 'end') return 'control';
  return segments.length > 1 ? segments[0] || 'utility' : 'utility';
}

/**
 * Actions a name selects, by tier: exact full name, then exact final segment, then final-segment
 * substring. Every match of the first non-empty tier is returned, so a short name that maps to
 * several actions shows them all.
 */
export function fuzzyResolveActions<T extends { name: string }>(entries: T[], query: string): T[] {
  const exactFull = entries.filter((entry) => entry.name === query);
  if (exactFull.length > 0) return exactFull;
  const exactSegment = entries.filter((entry) => finalSegment(entry.name) === query);
  if (exactSegment.length > 0) return exactSegment;
  return entries.filter((entry) => finalSegment(entry.name).includes(query));
}

/** Final segments that name exactly one action, keyed by full name; null when ambiguous. */
export function shortActionNames(names: readonly string[]): Map<string, string | null> {
  const counts = new Map<string, number>();
  for (const name of names) {
    const short = finalSegment(name);
    counts.set(short, (counts.get(short) ?? 0) + 1);
  }
  return new Map(
    names.map((name) => {
      const short = finalSegment(name);
      return [name, counts.get(short) === 1 ? short : null];
    }),
  );
}

/**
 * Rank actions by name, category, parameter names and description; every query term must match.
 * Ties sort by name.
 */
export function searchActions<T extends CatalogAction>(entries: T[], query: string): T[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  return entries
    .map((entry) => {
      const scores = terms.map((term) => catalogTermScore(entry, term));
      return { entry, scores, score: scores.reduce((total, value) => total + value, 0) };
    })
    .filter(({ score, scores }) => score > 0 && scores.every((value) => value > 0))
    .sort(
      (left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name),
    )
    .map(({ entry }) => entry);
}

/** Score of one search term against one entry; 0 means no match. */
export function catalogTermScore(entry: CatalogAction, term: string): number {
  const name = entry.name.toLowerCase();
  const segment = finalSegment(name);
  const nameTerms = searchTerms(name.replaceAll('.', ' ').replaceAll('_', ' '));
  const fields = entry.fields.map((field) => field.toLowerCase());
  const description = entry.description.toLowerCase();
  if (name === term) return 120;
  if (segment === term) return 110;
  if (entry.category === term) return 100;
  if (fields.includes(term)) return 90;
  if (nameTerms.includes(term)) return 80;
  if (name.includes(term)) return 70;
  if (fields.some((field) => field.includes(term))) return 60;
  if (description.includes(term)) return 50;
  if ([...nameTerms, ...fields].some((candidate) => fuzzyTermMatch(term, candidate))) return 40;
  return 0;
}

/** Lowercase alphanumeric search terms. */
export function searchTerms(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
}

/** Up to `limit` other actions in the same category or sharing name terms, closest first. */
export function findRelatedActions<T extends { name: string; category: string }>(
  entries: T[],
  selected: T,
  limit = 5,
): string[] {
  const selectedNameTerms = searchTerms(finalSegment(selected.name).replaceAll('_', ' '));
  return entries
    .filter((entry) => entry.name !== selected.name)
    .map((entry) => {
      const nameTerms = new Set(searchTerms(finalSegment(entry.name).replaceAll('_', ' ')));
      const sharedScore = selectedNameTerms
        .filter((term) => nameTerms.has(term))
        .reduce((score, term) => score + (GENERIC_OPERATION_TERMS.has(term) ? 5 : 30), 0);
      const score = (entry.category === selected.category ? 100 : 0) + sharedScore;
      return { name: entry.name, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map(({ name }) => name);
}

/** Action count per category, sorted by category. */
export function summarizeActionCategories<T extends { category: string }>(
  actions: T[],
): ActionCategorySummary[] {
  const counts = new Map<string, number>();
  for (const action of actions) counts.set(action.category, (counts.get(action.category) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * One row per action across the given adapter catalogs, sorted by name. Category comes from the
 * first catalog that has the action, the description from the first non-empty one, and fields
 * are the sorted union.
 */
export function actionCapabilityMatrix<Adapter extends string, Action extends CatalogAction>(
  catalogs: readonly AdapterActionCatalog<Adapter, Action>[],
): ActionMatrixRow<Adapter>[] {
  const adapters = catalogs.map((catalog) => catalog.adapter);
  const actions = new Map<string, { entries: Action[]; adapters: Set<Adapter> }>();
  for (const catalog of catalogs) {
    for (const action of catalog.actions) {
      const entry = actions.get(action.name) ?? { entries: [], adapters: new Set<Adapter>() };
      entry.entries.push(action);
      entry.adapters.add(catalog.adapter);
      actions.set(action.name, entry);
    }
  }
  return [...actions.entries()]
    .map(([name, entry]) => ({
      name,
      category: entry.entries[0]!.category,
      description: entry.entries.map((action) => action.description).find(Boolean) ?? '',
      fields: [...new Set(entry.entries.flatMap((action) => action.fields))].sort(),
      support: Object.fromEntries(
        adapters.map((adapter) => [
          adapter,
          entry.adapters.has(adapter) ? 'available' : 'unavailable',
        ]),
      ) as Record<Adapter, ActionSupport>,
      satisfyingAdapters: adapters.filter((adapter) => entry.adapters.has(adapter)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Why an action name resolves nowhere for this adapter: it names exactly one matrix action that
 * other adapters provide. Undefined when the name is unknown, ambiguous or already available.
 */
export function resolveActionCapabilityRefusal<Adapter extends string>(
  action: string,
  adapter: Adapter,
  matrix: ActionMatrixRow<Adapter>[],
): ActionCapabilityRefusal<Adapter> | undefined {
  const matches = fuzzyResolveActions(matrix, action);
  if (matches.length !== 1 || matches[0]!.satisfyingAdapters.includes(adapter)) return undefined;
  return { capability: matches[0]!.name, satisfyingAdapters: matches[0]!.satisfyingAdapters };
}

/** Actions from the list that the matrix knows and this adapter lacks, each once. */
export function missingActionCapabilities<Adapter extends string>(
  adapter: Adapter,
  actionNames: readonly string[],
  matrix: ActionMatrixRow<Adapter>[],
): ActionCapabilityRefusal<Adapter>[] {
  return [...new Set(actionNames)].flatMap((action) => {
    const row = matrix.find((entry) => entry.name === action);
    if (!row || row.satisfyingAdapters.includes(adapter)) return [];
    return [{ capability: row.name, satisfyingAdapters: row.satisfyingAdapters }];
  });
}

function fuzzyTermMatch(term: string, candidate: string): boolean {
  if (term.length < 4 || candidate.length < 4) return false;
  const threshold = Math.max(1, Math.floor(Math.max(term.length, candidate.length) / 4));
  return levenshtein(term, candidate) <= threshold;
}

function finalSegment(name: string): string {
  return name.split('.').pop() ?? name;
}
