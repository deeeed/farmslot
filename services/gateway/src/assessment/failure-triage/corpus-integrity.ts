/** Audit of the frozen v1 corpus. Never repair this record by editing old observations. */
export const CORPUS_INTEGRITY = {
  version: 1,
  corpusHash: '359d970de22283865cc4d171fac735a819e93cdb7feb42248833c1887de361d4',
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

export function corpusIntegrityPassed(hash: string): boolean {
  return corpusIntegrity(hash)?.passed === true;
}

/** Independent methodology audit before any v2 candidate inference. */
const V2_INTEGRITY = {
  version: 2,
  corpusHash: 'f678519daa6c014922e1f89a046ec22e4985cb2d1a2155047674e781c3d13d62',
  status: 'reviewed' as const,
  passed: true,
  scope: 'Synthetic diagnosis given fault-time source, state and explicit contracts only',
  audit: 'scripts/failure-triage/corpus-v2-audit.md',
  decision: 'evaluate' as const,
  limitations: [
    '21 held-out cases represent 16 families; external_service and unclear each have one family.',
    'Virtual component faults do not establish production-log accuracy or workflow efficiency.',
    'The immutable draft retains methodologyStatus=unreviewed; this hash-bound audit records the later review.',
  ],
};

export function corpusIntegrity(hash: string) {
  if (hash === CORPUS_INTEGRITY.corpusHash) return CORPUS_INTEGRITY;
  if (hash === V2_INTEGRITY.corpusHash) return V2_INTEGRITY;
  return { corpusHash: hash, status: 'unreviewed' as const, passed: false };
}
