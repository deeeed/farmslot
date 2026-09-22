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

export interface AssessmentChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence?: number;
}

export interface AssessmentScoreAnswer {
  type: 'score';
  score: number;
  probabilities: Record<string, number>;
  confidence?: number;
  legend?: Record<string, string>;
}

export interface AssessmentBooleanAnswer {
  type: 'boolean';
  probability: number;
}

export type AssessmentAnswer =
  | AssessmentChoiceAnswer
  | AssessmentScoreAnswer
  | AssessmentBooleanAnswer;

export interface AssessmentUsage {
  provider: string;
  requestedModel: string;
  returnedModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs: number;
  requestId?: string;
}

export type AssessmentStatus = 'disabled' | 'skipped' | 'unavailable' | 'completed';

export interface AssessmentResult {
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
  consumer: 'review-intake' | 'smoke-test';
  subject: AssessmentSubject;
  startedAt: string;
  completedAt?: string;
  status: 'started' | 'interrupted' | AssessmentStatus;
  result?: AssessmentResult;
  recommendation?: ReviewIntakeAdvisory;
  policyVersion: string;
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
  /** Freeze the PR/head/model cohort containing this completed assessment. */
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
    totalTokenDelta?: number;
    elapsedDeltaMs?: number;
  };
  limitations: string[];
}
