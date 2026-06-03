import type { PRStatus } from '@farmslot/protocol';

import { buildHash, parseHashRoute } from '../../utils/url-state.js';

export type PRLayout = 'board' | 'list';

/** Repo-qualified PR identity. PR numbers are per-repo so a bare number can collide across repos. */
export interface PRKey {
  repo: string;
  pr: number;
}

export interface PRBoardUrlState {
  layout?: PRLayout;
  selectedPr: PRKey | null;
  modalPr: PRKey | null;
}

export interface PRDispatchCompleteDetail {
  pr: number;
  repo?: string;
  project?: string;
}

export function prKeyEqual(a: PRKey | null, b: PRKey | null): boolean {
  if (!a || !b) return a === b;
  return a.pr === b.pr && a.repo === b.repo;
}

export function matchesPrKey(pr: PRStatus, key: PRKey | null): boolean {
  return !!key && pr.pr === key.pr && pr.repo === key.repo;
}

export function prBoardUrlStateFromHash(
  prs: readonly PRStatus[],
  hash: string = location.hash,
): PRBoardUrlState | null {
  const { route, params } = parseHashRoute(hash);
  if (route !== 'prs') return null;
  const prStr = params.get('pr');
  const repoParam = params.get('repo');
  const view = params.get('view');
  const layoutParam = params.get('layout');
  const prNum = prStr ? Number.parseInt(prStr, 10) : NaN;
  let selectedPr: PRKey | null = null;
  if (Number.isFinite(prNum)) {
    if (repoParam) {
      selectedPr = { repo: repoParam, pr: prNum };
    } else {
      // Legacy URLs with bare pr= are resolved only when the number is unique.
      const hits = prs.filter((pr) => pr.pr === prNum);
      if (hits.length === 1) selectedPr = { repo: hits[0].repo, pr: prNum };
    }
  }
  return {
    layout: layoutParam === 'list' || layoutParam === 'board' ? layoutParam : undefined,
    selectedPr,
    modalPr: selectedPr && view === 'modal' ? selectedPr : null,
  };
}

export function prBoardUrlStateHash(
  state: { selectedPr: PRKey | null; modalPr: PRKey | null; layout: PRLayout },
  hash: string = location.hash,
): string | null {
  const { route, params } = parseHashRoute(hash);
  if (route !== 'prs') return null;
  const key = state.modalPr ?? state.selectedPr;
  if (key) {
    params.set('pr', String(key.pr));
    params.set('repo', key.repo);
    params.set('view', state.modalPr ? 'modal' : 'detail');
  } else {
    params.delete('pr');
    params.delete('repo');
    params.delete('view');
  }
  if (state.layout === 'list') {
    params.set('layout', 'list');
  } else {
    params.delete('layout');
  }
  return buildHash('prs', params);
}

export function prCompleteDispatchHash(
  detail: PRDispatchCompleteDetail,
  hash: string = location.hash,
): string {
  const ticket = detail.repo ? `${detail.repo}#${detail.pr}` : String(detail.pr);
  const params = new URLSearchParams();
  params.set('flow', 'pr-complete');
  params.set('ticket', ticket);
  if (detail.project) params.set('project', detail.project);

  const { params: existing } = parseHashRoute(hash);
  for (const key of ['projects', 'machines']) {
    const value = existing.get(key);
    if (value) params.set(key, value);
  }
  return buildHash('dispatch', params);
}
