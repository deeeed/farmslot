import type { AcceptanceStatusLedger } from '@farmslot/protocol';

import type { InheritedAcceptanceSource } from './inherited-acceptance.js';

/** Display only. Both consumers first qualify the retained original authority. */
export function inheritedAcceptanceView(
  source: InheritedAcceptanceSource,
  child: AcceptanceStatusLedger | null,
): AcceptanceStatusLedger | null {
  const ids = new Set(source.acceptance.criteria.map(({ id }) => id));
  const original = source.acceptance.ledger;
  const ledger = child ?? original;
  if (!ledger) return null;
  const rows =
    original?.criteria
      .filter(({ id }) => ids.has(id))
      .map((row) => ({
        ...row,
        recipeRunId: row.recipeRunId ?? original.recipeRunId,
        inheritedFrom: source.provenance,
      })) ?? [];
  return {
    ...ledger,
    criteria: [...rows, ...(child?.criteria.filter(({ id }) => !ids.has(id)) ?? [])],
  };
}
