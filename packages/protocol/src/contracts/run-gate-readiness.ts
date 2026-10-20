import { isRecord } from '../recipe/common.js';

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

export type EvidenceAttestationAuthority =
  | { credentialId: string; personSessionId?: never }
  | { credentialId?: never; personSessionId: string };

export type EvidenceAttestationApprover = EvidenceAttestationAuthority & {
  principalId: string;
  displayName: string;
};

/** Retain credential-backed historical receipts and explicitly identify current person devices. */
export function isEvidenceAttestationApprover(
  value: unknown,
): value is EvidenceAttestationApprover {
  return (
    isRecord(value) &&
    typeof value.principalId === 'string' &&
    Boolean(value.principalId.trim()) &&
    typeof value.displayName === 'string' &&
    Boolean(value.displayName.trim()) &&
    ((typeof value.credentialId === 'string' &&
      Boolean(value.credentialId.trim()) &&
      value.personSessionId === undefined) ||
      (typeof value.personSessionId === 'string' &&
        Boolean(value.personSessionId.trim()) &&
        value.credentialId === undefined))
  );
}

export function sameEvidenceAttestationApprover(
  left: EvidenceAttestationApprover,
  right: EvidenceAttestationApprover,
): boolean {
  return (
    left.principalId === right.principalId &&
    left.credentialId === right.credentialId &&
    left.personSessionId === right.personSessionId
  );
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

/** An open finding at the package head, as its review's structured result recorded it. */
export interface GateReviewFinding {
  reviewId: string;
  file: string;
  line?: number;
  description: string;
}

export interface RunGateReadiness {
  state: 'collecting' | 'not-ready' | 'ready';
  identity: RunGateInputIdentity;
  reasons: RunGatePrerequisiteReason[];
  /**
   * The head's open findings, present only when every review reporting one returned a
   * valid structured result. Accepting them echoes `findingsDigest` (ADR-065 Amendment 8).
   */
  findings?: GateReviewFinding[];
  findingsDigest?: string;
}

/** Gate payloads whose advancing actions require the shared prerequisite evaluation. */
export function isPrerequisiteGatePayload(
  payload?: RunDecisionPayload,
): payload is ReadyGatePayload | ReviewGatePayload | NoChangeGatePayload {
  return payload?.kind === 'ready' || payload?.kind === 'review' || payload?.kind === 'no-change';
}
