import type { PRStatus } from '@farmslot/protocol';

import type { GlobalFilters } from '../store/filters';

export type PRDashboardSortMode = 'group' | 'date';

export interface PRDashboardGroup {
  id: string;
  label: string;
  recommendation: PRStatus['recommendation'];
}

export type PRDashboardRow =
  | { kind: 'group'; group: PRDashboardGroup; count: number }
  | { kind: 'pr'; pr: PRStatus };

export interface PRDashboardScope {
  visibleOwned: number;
  ownedTotal: number;
  gatewayTotal: number;
  hiddenByScope: number;
  reviewOnly: number;
  scopeLabel: string;
  summary: string;
}

export const PR_DASHBOARD_GROUPS: PRDashboardGroup[] = [
  { id: 'working', label: 'Working', recommendation: 'WORKING' },
  { id: 'needs-attention', label: 'Needs Attention', recommendation: 'NEEDS_ATTENTION' },
  { id: 'in-review', label: 'In Review', recommendation: 'IN_REVIEW' },
  { id: 'ready', label: 'Ready to Merge', recommendation: 'READY' },
  { id: 'waiting-for-merge', label: 'Waiting for Merge', recommendation: 'WAITING_FOR_MERGE' },
  { id: 'merged', label: 'Merged', recommendation: 'MERGED' },
  {
    id: 'closed-without-merge',
    label: 'Closed w/o Merge',
    recommendation: 'CLOSED_WITHOUT_MERGE',
  },
];

const PR_DASHBOARD_GROUP_RANK = new Map(
  PR_DASHBOARD_GROUPS.map((group, index) => [group.recommendation, index]),
);

function slotMatchesMachine(slot: string | null | undefined, machine: string): boolean {
  const normalized = slot?.trim();
  return Boolean(normalized && (normalized === machine || normalized.startsWith(`${machine}-`)));
}

export function filterDashboardPRs(prs: PRStatus[], filters: GlobalFilters): PRStatus[] {
  return prs.filter((pr) => {
    if (pr.ownedFamily !== true) return false;
    if (filters.projects.length > 0 && !filters.projects.includes(pr.project)) return false;
    if (filters.machines.length > 0) {
      if (!filters.machines.some((machine) => slotMatchesMachine(pr.slot, machine))) return false;
    }
    return true;
  });
}

export function buildPRDashboardScope(prs: PRStatus[], filters: GlobalFilters): PRDashboardScope {
  const ownedTotal = prs.filter((pr) => pr.ownedFamily === true).length;
  const visibleOwned = filterDashboardPRs(prs, filters).length;
  const gatewayTotal = prs.length;
  const hiddenByScope = Math.max(0, ownedTotal - visibleOwned);
  const reviewOnly = Math.max(0, gatewayTotal - ownedTotal);
  const activeScope = [...filters.projects, ...filters.machines];
  const scopeLabel = activeScope.length > 0 ? activeScope.join(', ') : 'all projects/machines';
  const hiddenParts = [
    hiddenByScope > 0 ? `${hiddenByScope} hidden by scope` : null,
    reviewOnly > 0 ? `${reviewOnly} review-only` : null,
  ].filter((part): part is string => Boolean(part));
  const hidden = hiddenParts.length > 0 ? ` · ${hiddenParts.join(' · ')}` : '';
  return {
    visibleOwned,
    ownedTotal,
    gatewayTotal,
    hiddenByScope,
    reviewOnly,
    scopeLabel,
    summary: `${visibleOwned}/${ownedTotal} owned visible · ${gatewayTotal} gateway · ${scopeLabel}${hidden}`,
  };
}

export function latestPRActivityTs(pr: PRStatus): number {
  if (pr.botComments?.length) {
    const newest = pr.botComments.reduce(
      (max, comment) => Math.max(max, Date.parse(comment.createdAt) || 0),
      0,
    );
    if (newest > 0) return newest;
  }
  // Match command-center's PR board fallback: higher PR number is the
  // strongest stable proxy available when GitHub comment timestamps are absent.
  return pr.pr;
}

export function sortDashboardPRs(prs: PRStatus[], mode: PRDashboardSortMode): PRStatus[] {
  if (mode === 'date') {
    return [...prs].sort((a, b) => latestPRActivityTs(b) - latestPRActivityTs(a));
  }
  return [...prs].sort(
    (a, b) =>
      (PR_DASHBOARD_GROUP_RANK.get(a.recommendation) ?? Number.MAX_SAFE_INTEGER) -
      (PR_DASHBOARD_GROUP_RANK.get(b.recommendation) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function buildPRDashboardRows(prs: PRStatus[], mode: PRDashboardSortMode): PRDashboardRow[] {
  if (mode === 'date') return sortDashboardPRs(prs, mode).map((pr) => ({ kind: 'pr', pr }));

  const rows: PRDashboardRow[] = [];
  for (const group of PR_DASHBOARD_GROUPS) {
    const groupPRs = prs.filter((pr) => pr.recommendation === group.recommendation);
    if (groupPRs.length === 0) continue;
    rows.push({ kind: 'group', group, count: groupPRs.length });
    rows.push(...groupPRs.map((pr) => ({ kind: 'pr' as const, pr })));
  }
  const unknown = prs.filter((pr) => !PR_DASHBOARD_GROUP_RANK.has(pr.recommendation));
  if (unknown.length > 0) {
    rows.push({
      kind: 'group',
      group: { id: 'other', label: 'Other', recommendation: unknown[0].recommendation },
      count: unknown.length,
    });
    rows.push(...unknown.map((pr) => ({ kind: 'pr' as const, pr })));
  }
  return rows;
}
