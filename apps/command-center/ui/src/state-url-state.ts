import { buildHash, parseHashRoute } from './utils/url-state.js';

export interface GlobalFilters {
  projects: string[];
  machines: string[];
}

export interface RunsHashState {
  tab?: string;
  status?: string;
  flow?: string;
  lane?: string;
  sort?: string;
  q?: string;
  tag?: string;
  family?: string;
}

const RUNS_HASH_KEYS: (keyof RunsHashState)[] = [
  'tab',
  'status',
  'flow',
  'lane',
  'sort',
  'q',
  'tag',
  'family',
];

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
  for (const key of RUNS_HASH_KEYS) {
    const value = next[key];
    if (value && value !== '') params.set(key, value);
    else params.delete(key);
  }
  return buildHash(route, params);
}

export function writeRunsHashState(next: RunsHashState): void {
  if (typeof location === 'undefined') return;
  const nextHash = runsHashWithState(next);
  if (!nextHash) return;
  if (location.hash === nextHash) return;
  // replaceState avoids both flooding browser history with one entry per
  // keystroke (when the search box persists on every input event) and the
  // hashchange listener re-applying our own write back into state — replaceState
  // does not fire `hashchange`.
  history.replaceState(null, '', nextHash);
}
