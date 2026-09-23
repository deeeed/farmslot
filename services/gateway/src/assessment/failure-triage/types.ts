import type { AssessmentQuestions, AssessmentUsage } from '@farmslot/protocol';

export const LABELS = [
  'environment',
  'dependencies',
  'implementation',
  'test_harness',
  'missing_evidence',
  'external_service',
  'unclear',
] as const;
export type TriageLabel = (typeof LABELS)[number];
export const CHECKS = [
  'inspect_prepare',
  'inspect_dependency_resolution',
  'inspect_failed_assertion',
  'inspect_test_fixture',
  'inspect_evidence',
  'inspect_external_response',
  'inspect_more_context',
  'none',
] as const;
export type TriageCheck = (typeof CHECKS)[number];
export const CHECK_FOR_LABEL: Record<TriageLabel, TriageCheck> = {
  environment: 'inspect_prepare',
  dependencies: 'inspect_dependency_resolution',
  implementation: 'inspect_failed_assertion',
  test_harness: 'inspect_test_fixture',
  missing_evidence: 'inspect_evidence',
  external_service: 'inspect_external_response',
  unclear: 'inspect_more_context',
};
export interface TriageEvidence {
  id: string;
  text: string;
  digest: string;
  required: boolean;
}
export interface TriagePacket {
  version: 1;
  caseId: string;
  failure: { runId: string; status: 'failed'; step: string };
  evidence: TriageEvidence[];
}
export interface TriageCase {
  id: string;
  group: string;
  split: 'development' | 'held-out';
  origin: { kind: 'synthetic'; generator: string };
  packet: TriagePacket;
  reference: { label: TriageLabel; nextCheck: TriageCheck; rationale: string; observation: string };
}
export interface TriageCorpus {
  version: 1;
  generatorVersion: string;
  cases: TriageCase[];
}
export interface PreparedTriage {
  packet: TriagePacket;
  packetHash: string;
  questionHash: string;
  questions: AssessmentQuestions;
  omissions: Array<{ id: string; reason: 'byte-limit' }>;
}
export interface TriagePrediction {
  label: TriageLabel;
  nextCheck: TriageCheck;
  evidenceIds: string[];
  confidence?: number;
}
export interface TriageResult {
  caseId: string;
  status: 'completed' | 'skipped' | 'unavailable' | 'started';
  reason?: string;
  prediction?: TriagePrediction;
  provider?: string;
  requestedModel?: string;
  returnedModel?: string;
  packetHash?: string;
  questionHash?: string;
  omissions?: PreparedTriage['omissions'];
  usage?: AssessmentUsage;
  /** Safe HTTP status, when a provider response was received. Never includes provider body text. */
  httpStatus?: number;
  durationMs: number;
  reservedUsd: number;
  estimatedUsd?: number;
}
export interface TriagePrice {
  version: 1;
  provider: string;
  model: string;
  verifiedAt: string;
  source: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  maxRequestTokens: number;
}
