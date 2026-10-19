export const ACCEPTANCE_STATUS_ARTIFACT: 'artifacts/acceptance-status.json';
export const INHERITED_ACCEPTANCE_INPUT: 'inputs/inherited-acceptance.json';
export const ACCEPTANCE_VERDICTS: readonly [
  'proven',
  'weak',
  'missing',
  'untestable',
  'failed',
  'awaiting-review',
];
export const ACCEPTANCE_PROOF_MODES: readonly ['state', 'visual', 'mixed', 'review'];
export const ACCEPTANCE_CRITERION_ID_PATTERN: RegExp;
export function acceptanceCriterionId(index: number): string;
export function registeredAcceptanceCriteria(
  criteria: readonly unknown[],
): Array<{ id: string; text: string }>;
export function acceptanceCriteriaMatch(
  expected: readonly unknown[],
  actual: readonly unknown[],
): boolean;
export function acceptanceRowExecution(
  ledger: { recipeRunId?: string },
  row: { recipeRunId?: string },
): string | undefined;
export function acceptanceVerdictLabel(status: { verdict: string; proofMode?: string }): string;
export function validateAcceptanceStatusLedger(value: unknown): string[];
export function acceptanceCriteriaView(criteria: readonly unknown[], ledger: unknown): unknown[];
export function summarizeAcceptanceStatus(ledger: unknown, criteria?: readonly unknown[]): unknown;
export function renderAcceptanceCoverage(ledger: unknown, criteria?: readonly unknown[]): string;
