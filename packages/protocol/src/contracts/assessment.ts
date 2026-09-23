/** A JSON value that can be sent as assessment state. */
export type AssessmentJsonValue =
  | string
  | number
  | boolean
  | null
  | AssessmentJsonValue[]
  | { [key: string]: AssessmentJsonValue };

export type AssessmentQuestion =
  | {
      type: 'choice';
      instructions: string;
      criteria: Record<string, string>;
    }
  | {
      type: 'score';
      instructions: string;
      criteria: string[];
    }
  | {
      type: 'boolean';
      instructions: string;
    };

export type AssessmentQuestions = Record<string, AssessmentQuestion>;

export interface AssessmentRequest {
  /** Explicit per-call opt-in or opt-out, independent of provider selection. */
  enabled?: boolean;
  state: AssessmentJsonValue;
  questions: AssessmentQuestions;
  provider?: string;
  model?: string;
  timeoutMs?: number;
}

export type AssessmentChoiceAnswer = {
  type: 'choice';
  choice: string;
  confidence?: number;
} & (
  | { choices: string[]; probabilities?: Record<string, number> }
  | { choices?: undefined; probabilities: Record<string, number> }
);

export interface AssessmentScoreAnswer {
  type: 'score';
  score: number;
  /** Present only when the provider reports a distribution. */
  probabilities?: Record<string, number>;
  confidence?: number;
  legend?: Record<string, string>;
}

export type AssessmentBooleanAnswer =
  | { type: 'boolean'; value: boolean; probability?: number }
  | { type: 'boolean'; value?: undefined; probability: number };

/** Explicit vocabulary or legacy native probability keys; never synthesize probabilities. */
export function assessmentChoiceOptions(answer: AssessmentChoiceAnswer): string[] {
  return answer.choices ?? Object.keys(answer.probabilities ?? {});
}

/** Preserve the historical threshold for probability-only answers. */
export function assessmentBooleanValue(answer: AssessmentBooleanAnswer, threshold = 0.65): boolean {
  if (answer.value !== undefined) return answer.value;
  return answer.probability >= threshold;
}

export type AssessmentAnswer =
  | AssessmentChoiceAnswer
  | AssessmentScoreAnswer
  | AssessmentBooleanAnswer;

export interface AssessmentUsage {
  provider: string;
  requestedModel: string;
  returnedModel?: string;
  /** Total input tokens, including cache reads/writes when the provider reports them. */
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  costKind?: 'estimated' | 'reported';
  durationMs: number;
  requestId?: string;
}

export type AssessmentStatus = 'disabled' | 'skipped' | 'unavailable' | 'completed';

export interface AssessmentResult {
  /** Provider adapter invoked; absent means historical/unknown, not zero calls. */
  attempted?: boolean;
  assessmentId?: string;
  monitoringError?: string;
  status: AssessmentStatus;
  provider?: string;
  requestedModel?: string;
  returnedModel?: string;
  answers?: Record<string, AssessmentAnswer>;
  usage?: AssessmentUsage;
  questionSchemaHash?: string;
  stateHash?: string;
  error?: string;
}

export interface AssessmentProviderDescriptor {
  id: string;
  defaultModel: string;
  capabilities: Array<'choice' | 'score' | 'boolean'>;
}

export interface AssessmentStatusResult {
  enabled: boolean;
  provider?: string;
  model?: string;
  keyAvailable: boolean;
  providers: AssessmentProviderDescriptor[];
  error?: string;
}

export interface AssessmentTestParams {
  provider?: string;
  model?: string;
}

export type ReviewIntakeRoute =
  | 'standard-review'
  | 'strong-reviewer'
  | 'multimodal-review'
  | 'needs-review';

export interface ReviewIntakeAdvisory {
  assessment: AssessmentResult;
  route: ReviewIntakeRoute;
  visualReviewRequired: boolean;
  reasons: string[];
}

/** Audit-only context. It never enters the model's state. */
export interface AssessmentSubject {
  pr?: { host: string; repo: string; number: number; headSha: string };
  run?: {
    id: string;
    project: string;
    step: string;
    snapshotHash: string;
    /** Admitted source packet, retained with the advice so later review sees what was approved. */
    admission?: { classification: 'public' | 'synthetic'; sourceRef: string };
    criterion?: {
      id: string;
      text: string;
      evidence: Array<{ id: string; text: string }>;
    };
    decision?: {
      id: string;
      type: string;
      description: string;
      actions: Array<{ id: string; label: string; description: string }>;
    };
    sources?: Array<{ id: string; sourceId: string; digest: string }>;
  };
}

export const ASSESSMENT_CONSUMERS = [
  'review-intake',
  'smoke-test',
  'failure-triage',
  'decision-advice',
  'acceptance-evidence',
] as const;

export interface AssessmentReservation {
  /** Stable request identity; pending attempts are never silently replayed. */
  key: string;
  maxUsd: number;
  priceHash: string;
  price?: {
    version: 1;
    provider: string;
    model: string;
    verifiedAt: string;
    source: string;
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
    maxRequestTokens: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
  };
}

export type AssessmentFeedbackVerdict = 'correct' | 'incorrect' | 'insufficient-context';

export interface AssessmentFeedback {
  revision: number;
  recordedAt: string;
  verdict: AssessmentFeedbackVerdict;
  questionId: string;
  /** Operator feedback is observational, not independent reference truth. */
  adviceUsed: boolean;
  adviceShown: boolean;
  evidenceRef: string;
  correctedAnswer?: string | boolean;
}

export interface AssessmentRecord {
  version: 1;
  id: string;
  ownerId: string;
  consumer: (typeof ASSESSMENT_CONSUMERS)[number];
  subject: AssessmentSubject;
  startedAt: string;
  completedAt?: string;
  status: 'started' | 'interrupted' | AssessmentStatus;
  result?: AssessmentResult;
  recommendation?: ReviewIntakeAdvisory;
  policyVersion: string;
  reservation?: AssessmentReservation;
  requestedIdentity?: {
    provider?: string;
    model?: string;
    inputDigest?: string;
    questionSchemaHash?: string;
  };
  feedback: AssessmentFeedback[];
}

export interface AssessmentHistoryParams {
  before?: string;
  limit?: number;
  consumer?: AssessmentRecord['consumer'];
}

export interface AssessmentHistoryResult {
  records: AssessmentRecord[];
  nextCursor?: string;
  retentionDays: number;
  auditHealth: AssessmentAuditHealth;
}

export interface AssessmentFeedbackParams {
  id: string;
  expectedRevision: number;
  questionId: string;
  verdict: AssessmentFeedbackVerdict;
  adviceUsed: boolean;
  adviceShown: boolean;
  evidenceRef: string;
  correctedAnswer?: string | boolean;
}

export interface AssessmentSummary {
  calls: number;
  attemptedCalls?: number;
  unknownAttemptCalls?: number;
  selectedCases?: number;
  completedCases?: number;
  reservedUsd?: number;
  knownEstimatedUsd?: number;
  knownReportedUsd?: number;
  knownUnclassifiedUsd?: number;
  unknownCharges?: number;
  completed: number;
  failed: number;
  skipped: number;
  interrupted: number;
  tokens: number;
  callsWithUsage: number;
  callsWithLatency: number;
  endToEndMedianMs: number | null;
  endToEndP95Ms: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  uniqueCases: number;
  labeledQuestions: number;
  correctQuestions: number;
  incorrectQuestions: number;
  insufficientContextQuestions: number;
  accuracy: number | null;
  unlabeledQuestions: number;
  savings: null;
  groups: Array<{
    consumer?: AssessmentRecord['consumer'];
    provider: string;
    model: string;
    questionSchemaHash: string;
    policyVersion: string;
    questionId: string;
    calls: number;
    correct: number;
    incorrect: number;
    insufficientContext: number;
    unlabeled: number;
  }>;
}

export interface AssessmentAuditHealth {
  status: 'ok' | 'degraded';
  failedWritesSinceStart: number;
}

export interface AssessmentReport {
  version: 1;
  reportId: string;
  createdAt: string;
  scope: 'observational';
  records: AssessmentRecord[];
  summary: AssessmentSummary;
  limitations: string[];
}

export interface AssessmentRecordParams {
  id: string;
}
export interface AssessmentReportParams {
  id?: string;
  /** Freeze the PR/head/requested-model cohort containing this completed assessment. */
  assessmentId?: string;
}

export interface AssessmentReferenceLabel {
  assessmentId: string;
  questionId: string;
  expected: string | boolean;
  evidenceRef: string;
  source: 'human' | 'independent-model';
  /** Explicit declaration by the importer, not proof of independence. */
  blinded: boolean;
}
export interface AssessmentEvaluationParams {
  reportId: string;
  references: AssessmentReferenceLabel[];
  pair?: {
    baseline: import('./evals.js').ResultPackageManifest;
    assisted: import('./evals.js').ResultPackageManifest;
  };
}
export interface AssessmentEvaluation {
  version: 1;
  reportId: string;
  evaluationId: string;
  createdAt: string;
  status: 'inconclusive' | 'scored';
  /** Excluded records, including smoke tests and repeated case/cohort attempts. */
  excluded: number;
  missingReferences: number;
  unusedReferences: number;
  rejectedReferences: number;
  unsupportedQuestions: number;
  questions: Array<{
    cohort: string;
    questionId: string;
    correct: number;
    judged: number;
    /** All representative answers; abstained and unlabeled may overlap. */
    eligible: number;
    unlabeled: number;
    abstained: number;
    falseNegatives: number;
    falsePositives: number;
    accuracy: number | null;
    interval95: [number, number] | null;
  }>;
  comparison: {
    status: 'inconclusive' | 'comparable';
    reason: string;
    baselinePackageHash?: string;
    assistedPackageHash?: string;
    reportedTokenDelta?: number;
    assessmentTokens?: number;
    assessmentTokensStatus?: 'complete' | 'partial';
    assessmentAttemptsMissingUsage?: number;
    totalTokenDelta?: number;
    elapsedDeltaMs?: number;
  };
  limitations: string[];
}
