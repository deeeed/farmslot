import type { PRStatus } from '@farmslot/protocol';

import type { GlobalFilters } from '../../state.js';

export interface PRDashboardScopeSummary {
  visibleOwned: number;
  ownedTotal: number;
  gatewayTotal: number;
  hiddenByScope: number;
  reviewOnly: number;
  scopeLabel: string;
  summary: string;
}

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

export function buildPRDashboardScopeSummary(
  prs: PRStatus[],
  filters: GlobalFilters,
): PRDashboardScopeSummary {
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
