export interface ScopeCoverageDefinition {
  kind: 'scope';
  path: string;
}
export interface CriterionCoverageDefinition {
  kind: 'criterion';
  unitId: string;
  stepNumber: number;
  ruleSourceSha256: string;
  label: string;
  family?: string;
}
export type CoverageDefinition = ScopeCoverageDefinition | CriterionCoverageDefinition;
export interface CoverageRowValue {
  scope?: string;
  justification?: string;
  outcome?: 'PASS' | 'FINDING' | 'NOT_APPLICABLE' | 'NOT_CHECKED';
  evidence?: string;
}
export interface CoverageRow {
  key: string;
  definition: CoverageDefinition;
  value: CoverageRowValue;
  sourceHashes: Record<string, string>;
  evidenceHashes: Record<string, string>;
  provenance: {
    runId: string;
    headSha: string;
    reportSha256?: string;
    applicabilityChecked: boolean;
  };
}
export interface CoverageIndex {
  schemaVersion: 1;
  runId: string;
  headSha: string;
  authorizationHash: string;
  ruleHash: string;
  rows: CoverageRow[];
  reportSha256?: string;
  ledgerSha256?: string;
  compositionFingerprint?: string;
}
export interface CoverageBaselineIdentity {
  runId: string;
  headSha: string;
  reportSha256: string;
  indexSha256: string;
  evidenceHashes?: Record<string, string>;
}
export interface CoveragePolicy {
  schemaVersion: 1;
  runId: string;
  repo: string;
  headSha: string;
  authorizationHash: string;
  ruleHash: string;
  scopePaths: string[];
  baseline?: CoverageBaselineIdentity;
}
export interface CoverageInputs {
  runId: string;
  headSha: string;
  authorizationHash: string;
  ruleHash: string;
  definitions: CoverageDefinition[];
  sourceHashes: Record<string, string>;
  evidenceHashes: Record<string, string>;
}
export function sha256(text: string | Uint8Array): string;
export function coverageRowKey(row: CoverageDefinition): string;
export function readCoverageIndex(
  bytes: string | undefined,
  expected?: CoverageBaselineIdentity,
): CoverageIndex | null;
export function reusableCoverageRows(
  index: CoverageIndex | null,
  inputs: CoverageInputs,
): {
  reusable: CoverageRow[];
  invalidated: Array<{ key: string; reason: string }>;
  unavailable?: string;
};
export function composeCoverageRows(
  inputs: CoverageInputs,
  update: unknown,
  baseline: CoverageIndex | null,
): CoverageIndex;
export function renderCoverage(index: CoverageIndex): { scope: string; ledger: string };
export function relativeFile(value: string): string;
export function coverageDefinitions(taskDir: string, policy: CoveragePolicy): CoverageDefinition[];
export function coverageSourceHashes(
  repo: string,
  headSha: string,
  files: string[],
  scopePaths: string[],
): Record<string, string>;
export function parseCoverageSourceHashes(
  output: string,
  files: string[],
  scopePaths: string[],
): Record<string, string>;
export function materializeReviewCoverage(taskDir: string): CoverageIndex | null;
export function readCoveragePolicy(manifest: unknown): CoveragePolicy | undefined;
export function readReviewTaskFile(taskDir: string, file: string): string | undefined;
export function readReviewTaskFile(
  taskDir: string,
  file: string,
  encoding: null,
): Buffer | undefined;
export function reviewCoverageEvidencePaths(update: unknown): string[];
export function reviewCoverageSourcePaths(
  scopePaths: string[],
  baseline: CoverageIndex | null,
  update: unknown,
): string[];
export function composeReviewArtifacts(
  policy: CoveragePolicy,
  definitions: CoverageDefinition[],
  result: { coverage?: unknown; issues?: unknown },
  report: string,
  baseline: CoverageIndex | null,
  sourceHashes: Record<string, string>,
  artifactHashes: Record<string, string>,
  baselineEvidenceHashes?: Record<string, string>,
): { index: CoverageIndex; report: string; ledger: string };
