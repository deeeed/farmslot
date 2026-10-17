/**
 * Resource identities for gateway change notifications (proposed ADR-071).
 * Sources is the pilot slice (ADR-069 Amendment 1): only its key family is defined.
 */
export type ResourceKey = { family: 'sources'; scope: 'farm' };

/** Nonnegative safe integer that only increases per key within one gateway epoch. */
export type ResourceRevision = number;
