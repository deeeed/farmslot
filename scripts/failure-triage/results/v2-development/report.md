# Failure-triage evaluation

Revision: 913a77829b3af5a5a8c06f1ea725fb2b1fdbd5de; checkout dirty: false. Source snapshot: 5aeff86098344c0bf333c1f28216a3333c69a631572ffc5f748d5abb1d955f59.
Corpus: f678519daa6c014922e1f89a046ec22e4985cb2d1a2155047674e781c3d13d62. Selected families: 7.
Rubric: failure-triage-v1; baselines: failure-triage-baselines-v1.

Decision: **hold**. Live status: completed. Efficiency: not_established.

| Measure | Existing baseline | Diagnostic cues | Candidate |
| --- | --- | --- | --- |
| Correct / cases | 3/9 | 4/9 | 6/9 |
| Macro-F1 | 0.07142857142857142 | 0.22077922077922077 | 0.4880952380952381 |

Attempts: 9; reserved USD: 0.024772608; known estimated USD: 0.000453768; unknown charges: 0.
Batch time: 3674ms.

- PASS: corpus-integrity-reviewed
- HOLD: complete-live-held-out
- PASS: no-data-secret-authority-violations
- PASS: unclear-cases-abstain
- HOLD: definite-precision-0.85
- PASS: definite-coverage-0.60
- PASS: macro-f1-gain-0.05
- PASS: within-budget

- Synthetic known-cause classification and next-check accuracy are proxies, not measured operator time savings.
- Twenty-one held-out cases cannot establish broad accuracy. Family counts describe correlation; case-level confidence intervals are unavailable when families repeat.
- V2 uses compact virtual fixtures with explicit contracts and component ownership, not sparse production logs. External-service and unclear each have only one held-out family.
- The cue sheet was designed against v1 and frozen before v2; it is not an independently authored blind comparator. Historical v1 arithmetic is documented separately and cannot repair its integrity failure.
- Next-check references are derived from cause labels; nextCheckCorrect is not an independent measure of diagnostic utility.
- The v1 live run had two unattributed invalid-response failures; controlled sub-reasons were added only afterward.
- Rubric v1 additionally rejects a definite cause with evidence:none. This rule is now explicit; it was not documented before the frozen run.
- No run, slot, recovery, publication or dispatch action is available to this evaluator.
- The v1 corpus is quarantined: repair commentary overlaps its reference rationale and HTTP-family variants cross splits. Its numbers cannot establish comparative effectiveness.
- Reserved cost covers unknown charges conservatively; reported monetary values are estimates from a price snapshot, not invoices.
