import { buildHash, parseHashRoute } from './utils/url-state.js';

export interface GlobalFilters {
  projects: string[];
  machines: string[];
}

export interface RunsHashState {
  run?: string;
  tab?: string;
  status?: string;
  flow?: string;
  lane?: string;
  sort?: string;
  q?: string;
  tag?: string;
  family?: string;
}

const RUNS_HASH_KEYS: Exclude<keyof RunsHashState, 'tab'>[] = [
  'run',
  'status',
  'flow',
  'lane',
  'sort',
  'q',
  'tag',
  'family',
];
const RUNS_TAB_PARAM = 'runsTab';
const RUN_DETAIL_PARAMS = [
  'tab',
  'file',
  'modal',
  'diffArtifact',
  'lightboxIndex',
  'lightboxRecipeRunId',
  'evidencePreview',
  'step',
  'artifactRun',
  'artifact',
] as const;

function splitCsv(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseFiltersFromHash(hash: string = location.hash): GlobalFilters | null {
  const { params } = parseHashRoute(hash);
  const pStr = params.get('projects');
  const mStr = params.get('machines');
  if (pStr === null && mStr === null) return null;
  return { projects: splitCsv(pStr), machines: splitCsv(mStr) };
}

export function filtersHash(filters: GlobalFilters, hash: string = location.hash): string {
  const { route, params } = parseHashRoute(hash);
  if (filters.projects.length > 0) params.set('projects', filters.projects.join(','));
  else params.delete('projects');
  if (filters.machines.length > 0) params.set('machines', filters.machines.join(','));
  else params.delete('machines');
  return buildHash(route, params);
}

export function writeFiltersToHash(filters: GlobalFilters): void {
  if (typeof location === 'undefined') return;
  const next = filtersHash(filters);
  if (location.hash === next) return;
  // replaceState does not fire `hashchange`, so the listener in state.ts cannot
  // re-apply our own write back into state — no suppression flag needed.
  history.replaceState(null, '', next);
}

// `#runs` per-page filter state. Keys live alongside the global `projects`/
// `machines` query params (and the existing `family`/`compare` keys) on the
// runs route. Read/write is idempotent: writers no-op when the resulting hash
// matches the current location; readers only return values for keys that are
// actually present, so unknown query params from a future schema are ignored.
export function parseRunsHashState(hash: string = location.hash): RunsHashState {
  const { route, params } = parseHashRoute(hash);
  if (!route.startsWith('runs')) return {};
  const out: RunsHashState = {};
  const tab = params.get(RUNS_TAB_PARAM);
  if (tab) out.tab = tab;
  for (const key of RUNS_HASH_KEYS) {
    const value = params.get(key);
    if (value !== null && value !== '') out[key] = value;
  }
  return out;
}

export function runsHashWithState(
  next: RunsHashState,
  hash: string = location.hash,
): string | null {
  const { route, params } = parseHashRoute(hash);
  if (!route.startsWith('runs')) return null;
  if ((next.run ?? '') !== (params.get('run') ?? '')) {
    for (const key of RUN_DETAIL_PARAMS) params.delete(key);
  }
  for (const key of RUNS_HASH_KEYS) {
    const value = next[key];
    if (value && value !== '') params.set(key, value);
    else params.delete(key);
  }
  if (next.tab) params.set(RUNS_TAB_PARAM, next.tab);
  else params.delete(RUNS_TAB_PARAM);
  return buildHash(route, params);
}

export function writeRunsHashState(
  next: RunsHashState,
  historyMode: 'replace' | 'push' = 'replace',
): void {
  if (typeof location === 'undefined') return;
  const nextHash = runsHashWithState(next);
  if (!nextHash) return;
  if (location.hash === nextHash) return;
  // Filters replace to avoid one history entry per keystroke. Explicit row
  // selection may push so browser Back returns to the inventory.
  history[historyMode === 'push' ? 'pushState' : 'replaceState'](null, '', nextHash);
}
