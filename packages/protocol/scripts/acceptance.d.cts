declare const contract: {
  ACCEPTANCE_STATUS_ARTIFACT: 'artifacts/acceptance-status.json';
  ACCEPTANCE_VERDICTS: readonly [
    'proven',
    'weak',
    'missing',
    'untestable',
    'failed',
    'awaiting-review',
  ];
  ACCEPTANCE_PROOF_MODES: readonly ['state', 'visual', 'mixed'];
  ACCEPTANCE_CRITERION_ID_PATTERN: RegExp;
  acceptanceCriterionId(index: number): string;
  validateAcceptanceStatusLedger(value: unknown): string[];
  acceptanceCriteriaView(criteria: readonly unknown[], ledger: unknown): unknown[];
  summarizeAcceptanceStatus(ledger: unknown, criteria?: readonly unknown[]): unknown;
  renderAcceptanceCoverage(ledger: unknown, criteria?: readonly unknown[]): string;
};
export = contract;
