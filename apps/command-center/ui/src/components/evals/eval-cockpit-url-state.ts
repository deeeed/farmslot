import { buildHash, parseHashRoute } from '../../utils/url-state.js';

import type {
  EvalCaseFilterKind,
  EvalCaseFilterTaskProfile,
  EvalCaseSortDirection,
  EvalCaseSortKey,
  EvalSelectedCase,
} from './eval-suite-helpers.js';

export interface CandidateRow {
  id: string;
  enabled: boolean;
  label: string;
  templatePath: string;
  templateHash: string;
  promptName: string;
  promptHash: string;
  harnessRef: string;
  baseRecipePath: string;
  baseRecipeHash: string;
  reviewMode: EvalReviewMode;
  reviewName: string;
  reviewVersion: string;
  runner: string;
  model: string;
  repeat: boolean;
}

export type EvalReviewMode = 'none' | 'default' | 'custom';

export interface EvalCockpitUrlState {
  q?: string;
  kind?: EvalCaseFilterKind;
  project?: string;
  profile?: EvalCaseFilterTaskProfile;
  status?: string;
  preview?: string;
  picker?: boolean;
  sort?: EvalCaseSortKey;
  dir?: EvalCaseSortDirection;
  selected?: EvalSelectedCase[];
  candidates?: CandidateRow[];
  manual?: boolean;
  advanced?: boolean;
}

export interface EvalCockpitUrlParts {
  route: string;
  params: URLSearchParams;
}

const STATE_PARAM = 'state';
const EVAL_COCKPIT_ROUTES = new Set(['evals', 'dev/eval-cockpit']);

export function parseEvalCockpitUrlParts(hash: string = location.hash): EvalCockpitUrlParts | null {
  const { route, params } = parseHashRoute(hash);
  if (!EVAL_COCKPIT_ROUTES.has(route)) return null;
  return { route, params };
}

export function encodeEvalCockpitUrlState(state: EvalCockpitUrlState): string {
  const json = JSON.stringify(state);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeEvalCockpitUrlState(value: string): EvalCockpitUrlState | null {
  try {
    const padded =
      value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' ? (parsed as EvalCockpitUrlState) : null;
  } catch (_error) {
    // URL state is user-editable; invalid state is ignored and the next valid interaction rewrites it.
    return null;
  }
}

export function evalCockpitUrlStateFromHash(hash: string = location.hash): {
  encoded: string;
  state: EvalCockpitUrlState | null;
} | null {
  const parts = parseEvalCockpitUrlParts(hash);
  if (!parts) return null;
  const encoded = parts.params.get(STATE_PARAM) ?? '';
  return { encoded, state: encoded ? decodeEvalCockpitUrlState(encoded) : null };
}

export function evalCockpitUrlStateHash(
  state: EvalCockpitUrlState,
  hash: string = location.hash,
): { encoded: string; hash: string } | null {
  const parts = parseEvalCockpitUrlParts(hash);
  if (!parts) return null;
  const encoded = encodeEvalCockpitUrlState(state);
  parts.params.set(STATE_PARAM, encoded);
  return { encoded, hash: buildHash(parts.route, parts.params) };
}
