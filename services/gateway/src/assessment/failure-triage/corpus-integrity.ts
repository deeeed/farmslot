import { CORPUS_HASH } from './corpus-lock.js';

/** Audit of the frozen v1 corpus. Never repair this record by editing old observations. */
export const CORPUS_INTEGRITY = {
  version: 1,
  corpusHash: CORPUS_HASH,
  status: 'quarantined' as const,
  passed: false,
  findings: [
    {
      id: 'evaluator-comment-leakage',
      detail:
        'Definite-case packets contain the authored repair explanation also used in the reference rationale.',
    },
    {
      id: 'incident-family-overlap',
      detail:
        'HTTP response variants share a fixture family but were assigned row-based groups across development and held-out splits.',
    },
    {
      id: 'corpus-visible-cue-sheet',
      detail:
        'The diagnostic cue sheet was authored with visibility of the case design. It is an optimistic corpus-visible comparator, not an independent blind baseline.',
    },
  ],
  decision: 'hold' as const,
  next: 'Preserve v1 and its live artifacts. A separately versioned corpus with raw incident observations and reviewed family-disjoint provenance is required before new live evaluation.',
};
