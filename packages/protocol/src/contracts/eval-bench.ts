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
