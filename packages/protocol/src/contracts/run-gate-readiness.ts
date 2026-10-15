import type {
  NoChangeGatePayload,
  ReadyGatePayload,
  ReviewGatePayload,
  RunDecisionPayload,
} from './runs.js';

export type RunGatePrerequisite =
  | 'deterministic'
  | 'acceptance'
  | 'evidence'
  | 'review'
  | 'lifecycle';

export interface RunGatePrerequisiteReason {
  code: string;
  prerequisite: RunGatePrerequisite;
  message: string;
  /** Task-relative artifact, registered criterion or declared check reference. */
  reference?: string;
  /** Existing action that can resolve the prerequisite. */
  actionId?: string;
  /** Gateway-derived exceptions whose current input artifacts were verified. */
  allowedReviewOverrides?: string[];
  /** Only these checked claim-policy findings may receive human attestation. */
  evidencePolicy?: 'execution-verdict' | 'claim-verdict' | 'criterion-binding';
}

export interface EvidenceAttestationApprover {
  principalId: string;
  displayName: string;
  credentialId: string;
}

/** Gateway-stamped decision receipt; request callers supply only the reason. */
export interface EvidencePolicyAttestation {
  schemaVersion: 1;
  runId: string;
  decisionId: string;
  packageHash: string;
  selectedEvidenceKeys: string[];
  approver: EvidenceAttestationApprover;
  reason: string;
  approvedAt: string;
  waivedReasons: RunGatePrerequisiteReason[];
}

/** A projection of the current decision's checked inputs, never approval authority. */
export interface RunGateInputIdentity {
  runId: string;
  generation: number;
  headSha?: string | null;
  packageHash?: string | null;
}

export interface RunGateReadiness {
  state: 'collecting' | 'not-ready' | 'ready';
  identity: RunGateInputIdentity;
  reasons: RunGatePrerequisiteReason[];
}

/** Gate payloads whose advancing actions require the shared prerequisite evaluation. */
export function isPrerequisiteGatePayload(
  payload?: RunDecisionPayload,
): payload is ReadyGatePayload | ReviewGatePayload | NoChangeGatePayload {
  return payload?.kind === 'ready' || payload?.kind === 'review' || payload?.kind === 'no-change';
}
