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

export type ReviewIntakeRoute = 'standard-review' | 'strong-reviewer' | 'multimodal-review';

export interface ReviewIntakeAdvisory {
  assessment: AssessmentResult;
  route: ReviewIntakeRoute;
  visualReviewRequired: boolean;
  reasons: string[];
}
