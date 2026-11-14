/** Read-only imported benchmark data. Scores remain the source judge's verdicts. */
export interface EvalBenchUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  costNote: string | null;
  turns: number | null;
  wallMinutes: number | null;
}

export interface EvalBenchOriginal {
  repo: string;
  head: string;
  runId: string;
  model: string;
  scope: string;
  startedAt: string;
  completedAt: string;
  sourceSha256: string;
  usage: EvalBenchUsage;
}

export interface EvalBenchTrial {
  runId: string;
  sourceSha256: string;
  dataset: string;
  item: string;
  problemType: string;
  area: string;
  sizeClass: string;
  model: string;
  modelId: string;
  route: string;
  effort: string;
  reference: { repo: string; base: string; head: string; pr: number | null };
  verdict: string | null;
  verdictVsMerged: string | null;
  mergeable: string | null;
  unscored: string | null;
  usage: EvalBenchUsage;
  original: EvalBenchOriginal | null;
}

export interface EvalBenchRollup {
  problemType: string;
  model: string;
  modelId: string;
  route: string;
  effort: string;
  trials: number;
  cases: number;
  scored: number;
  solved: number;
  mergeable: number;
  mergeabilityKnown: number;
  unscored: number;
  costUsd: number;
  pricedTrials: number;
  turns: number;
  measuredTurnTrials: number;
}

export interface EvalBenchResult {
  configured: boolean;
  dataset: string | null;
  trials: EvalBenchTrial[];
  rollups: EvalBenchRollup[];
  infraFailures: Array<{ runId: string; item: string; failedStep: string; error: string }>;
}

export interface EvalBenchDiffFile {
  path: string;
  additions: number;
  deletions: number;
  kind: 'code' | 'test' | 'other';
  text: string;
}

export interface EvalBenchPatchTotals {
  additions: number;
  deletions: number;
  codeLines: number;
  testLines: number;
  otherLines: number;
}

export interface EvalBenchPatch {
  text: string | null;
  sha256: string | null;
  files: EvalBenchDiffFile[];
  totals: EvalBenchPatchTotals | null;
  missingReason: string | null;
}

export interface EvalBenchFinding {
  severity: string;
  text: string;
  cause: string | null;
  evidence: string | null;
  sharedWithOriginal: boolean | null;
}

export interface EvalBenchCriterion {
  id: string;
  text: string;
  verdict: string;
  evidence: string[];
  proofMode: string | null;
  timing: string | null;
}

export interface EvalBenchFileComparison {
  path: string;
  diffOfDiffs: string | null;
  note: string | null;
}

export interface EvalBenchTrialDetail {
  trial: EvalBenchTrial;
  patch: EvalBenchPatch;
  candidateBase: string | null;
  diffOfDiffs: string | null;
  fileComparisons: EvalBenchFileComparison[];
  comparisonNote: string | null;
  extraFiles: string[];
  missingFiles: string[];
  criteria: EvalBenchCriterion[];
  coverageNote: string | null;
  acClaim: string | null;
  template: string | null;
  originalGaps: string[];
  aheadOfOriginal: string[];
  mergedGaps: string[];
  fixedByOriginalReview: string[];
  findings: EvalBenchFinding[];
  driftNotes: string[];
  gate: string | null;
  redFirst: { tests: boolean | null; recipe: boolean | null; how: string | null } | null;
}

export interface EvalBenchComparison {
  capturedAt: string;
  dataset: string;
  item: string;
  reference: EvalBenchTrial['reference'];
  original: EvalBenchOriginal | null;
  originalPatch: EvalBenchPatch;
  trials: EvalBenchTrialDetail[];
}
