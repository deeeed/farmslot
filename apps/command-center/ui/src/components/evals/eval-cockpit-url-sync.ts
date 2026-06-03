import { sanitizeCandidateRows, sanitizeSelectedCases } from './eval-cockpit-model.js';
import {
  type CandidateRow,
  type EvalCockpitUrlState,
  evalCockpitUrlStateFromHash,
  evalCockpitUrlStateHash,
  parseEvalCockpitUrlParts,
} from './eval-cockpit-url-state.js';
import type {
  EvalCaseFilterKind,
  EvalCaseFilterTaskProfile,
  EvalCaseSortDirection,
  EvalCaseSortKey,
  EvalSelectedCase,
} from './eval-suite-helpers.js';

const URL_STATE_FIELDS = [
  '_caseQuery',
  '_caseKindFilter',
  '_caseProjectFilter',
  '_caseTaskProfileFilter',
  '_caseStatusFilter',
  '_previewCaseId',
  '_referencePickerOpen',
  '_caseSortKey',
  '_caseSortDirection',
  '_selectedCases',
  '_candidateRows',
  '_manualEntryOpen',
  '_advancedStrategyOpen',
];

export interface EvalCockpitUrlViewState {
  caseQuery: string;
  caseKindFilter: EvalCaseFilterKind;
  caseProjectFilter: string;
  caseTaskProfileFilter: EvalCaseFilterTaskProfile;
  caseStatusFilter: string;
  previewCaseId: string;
  referencePickerOpen: boolean;
  caseSortKey: EvalCaseSortKey;
  caseSortDirection: EvalCaseSortDirection;
  selectedCases: EvalSelectedCase[];
  candidateRows: CandidateRow[];
  manualEntryOpen: boolean;
  advancedStrategyOpen: boolean;
}

export interface EvalCockpitRestoredUrlState {
  encoded: string;
  state: EvalCockpitUrlViewState;
}

function validCaseKind(value: unknown): value is EvalCaseFilterKind {
  return (
    value === 'all' ||
    value === 'merged-pr' ||
    value === 'prior-run' ||
    value === 'package' ||
    value === 'git-ref'
  );
}

function validTaskProfile(value: unknown): value is EvalCaseFilterTaskProfile {
  return value === 'all' || value === 'fix-bug' || value === 'dev';
}

function validSortKey(value: unknown): value is EvalCaseSortKey {
  return (
    value === 'date' ||
    value === 'title' ||
    value === 'kind' ||
    value === 'project' ||
    value === 'profile' ||
    value === 'status'
  );
}

function validSortDirection(value: unknown): value is EvalCaseSortDirection {
  return value === 'asc' || value === 'desc';
}

export function restoreEvalCockpitUrlViewState(
  lastUrlState: string,
): EvalCockpitRestoredUrlState | null {
  const parsed = evalCockpitUrlStateFromHash();
  if (!parsed) return null;
  const { encoded, state } = parsed;
  if (!encoded || encoded === lastUrlState) return null;
  if (!state) return null;
  return {
    encoded,
    state: {
      caseQuery: typeof state.q === 'string' ? state.q : '',
      caseKindFilter: validCaseKind(state.kind) ? state.kind : 'all',
      caseProjectFilter: typeof state.project === 'string' ? state.project : 'all',
      caseTaskProfileFilter: validTaskProfile(state.profile) ? state.profile : 'all',
      caseStatusFilter: typeof state.status === 'string' ? state.status : 'all',
      previewCaseId: typeof state.preview === 'string' ? state.preview : '',
      referencePickerOpen: state.picker === true,
      caseSortKey: validSortKey(state.sort) ? state.sort : 'date',
      caseSortDirection: validSortDirection(state.dir) ? state.dir : 'desc',
      selectedCases: sanitizeSelectedCases(state.selected),
      candidateRows: sanitizeCandidateRows(state.candidates),
      manualEntryOpen: state.manual === true,
      advancedStrategyOpen: state.advanced === true,
    },
  };
}

export function evalCockpitUrlStateChanged(
  urlRestoring: boolean,
  changed: Map<string, unknown>,
): boolean {
  if (urlRestoring) return false;
  return URL_STATE_FIELDS.some((key) => changed.has(key));
}

export function writeEvalCockpitUrlViewState(
  state: EvalCockpitUrlViewState,
  lastUrlState: string,
): string {
  const parts = parseEvalCockpitUrlParts();
  if (!parts) return lastUrlState;
  const nextState: EvalCockpitUrlState = {
    q: state.caseQuery || undefined,
    kind: state.caseKindFilter,
    project: state.caseProjectFilter,
    profile: state.caseTaskProfileFilter,
    status: state.caseStatusFilter,
    preview: state.previewCaseId || undefined,
    picker: state.referencePickerOpen || undefined,
    sort: state.caseSortKey,
    dir: state.caseSortDirection,
    selected: state.selectedCases,
    candidates: state.candidateRows,
    manual: state.manualEntryOpen || undefined,
    advanced: state.advancedStrategyOpen || undefined,
  };
  const nextUrlState = evalCockpitUrlStateHash(nextState);
  if (!nextUrlState) return lastUrlState;
  const { encoded, hash: next } = nextUrlState;
  if (encoded === lastUrlState && parts.params.get('state') === encoded) return lastUrlState;
  if (location.hash !== next) history.replaceState(null, '', next);
  return encoded;
}
