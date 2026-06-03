/**
 * Pure helpers for the dispatch wizard's in-wizard comparison entry. Extracted so
 * the variant-collision and prior-runs grouping logic stays unit-testable without
 * standing up a DOM environment for the wizard component.
 */
import type { Run } from '@farmslot/protocol';
import { buildComparisonVariant, nextFreeComparisonVariant } from '@farmslot/protocol';

/** Group prior runs by familyId; root runs without a familyId fall back to their own id
 *  so the banner still shows them under a stable bucket. Each group is sorted newest-first. */
export function groupPriorRunsByFamily(runs: ReadonlyArray<Run>): Map<string, Run[]> {
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const key = r.familyId || r.id;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return groups;
}

/** Filter runs to those whose ticketOrPr exactly matches the operator-typed input or its
 *  server-normalized form. `run.list({ search })` is a substring match against ticketOrPr
 *  OR summary, so the banner narrows post-response to avoid surfacing unrelated families
 *  whose summary happens to mention the typed key. */
export function filterRunsByExactTicket(
  runs: ReadonlyArray<Run>,
  ticket: string,
  normalizedTicket: string,
): Run[] {
  const candidate = ticket.trim();
  if (!candidate) return [];
  return runs.filter(
    (r) => r.ticketOrPr === candidate || (!!normalizedTicket && r.ticketOrPr === normalizedTicket),
  );
}

export interface VariantCollisionState {
  collides: boolean;
  /** Suggested next-free variant when a collision exists; empty string otherwise. */
  suggested: string;
}

/** Determine whether the default `<runner>-<safe(model)>` variant tag would collide with
 *  an existing sibling in the family. When it does, returns a suggested next-free suffix
 *  the wizard can pre-fill into the variant input. */
export function detectVariantCollision(
  familyRuns: ReadonlyArray<Run>,
  runner: string | null | undefined,
  model: string | null | undefined,
): VariantCollisionState {
  const base = buildComparisonVariant(runner, model);
  if (!base) return { collides: false, suggested: '' };
  const taken = new Set(familyRuns.map((r) => r.variant ?? '').filter(Boolean));
  if (!taken.has(base)) return { collides: false, suggested: '' };
  return {
    collides: true,
    suggested: nextFreeComparisonVariant(familyRuns, runner, model),
  };
}

/** Return true when a comparison-mode dispatch should be blocked because the operator-supplied
 *  variant input is empty or duplicates an existing sibling within the family. */
export function isVariantInputBlocked(
  familyRuns: ReadonlyArray<Run>,
  variantInput: string,
  collides: boolean,
): boolean {
  if (!collides) return false;
  const value = variantInput.trim();
  if (!value) return true;
  return familyRuns.some((r) => (r.variant ?? '') === value);
}
