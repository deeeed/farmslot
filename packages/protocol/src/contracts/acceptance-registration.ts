import * as contract from '../../scripts/acceptance.mjs';

import type { AcceptanceCriterionRef, AcceptanceProofMode } from './acceptance.js';

/** Task transport only. The run record remains the registration authority. */
export const ACCEPTANCE_REGISTRATION_INPUT = contract.ACCEPTANCE_REGISTRATION_INPUT;
export const ACCEPTANCE_DERIVATION_VERSION = 1;
export const ACCEPTANCE_CONTRACT_INPUT = contract.ACCEPTANCE_CONTRACT_INPUT;

export interface AcceptanceExecutionContract {
  schemaVersion: 1;
  runId: string;
  revision: number;
  registrationRevision: number;
  baseContractHash: string;
  proofModes: Array<AcceptanceCriterionRef & { proofMode: AcceptanceProofMode }>;
  inheritedCriterionIds: string[];
  claimReviewGate: boolean;
  publicationReview: boolean;
}

export interface AcceptanceReviewCriterion extends AcceptanceCriterionRef {
  proofMode: 'review';
  definitionHash: string;
}

export interface AcceptanceDerivationSource {
  id: string;
  kind: 'review-comment' | 'instruction';
  body: string;
  version: string;
  url?: string;
  /** Frozen provider resolution state; resolved comments must be excluded. */
  resolved?: boolean;
  author?: string;
  providerKind?: 'issue' | 'review' | 'thread';
  commentId?: string;
  reviewId?: string;
  threadId?: string;
  databaseId?: number;
  path?: string;
  line?: number;
  updatedAt?: string;
}

export interface PRCompletionIntakeIdentity {
  provider: 'github';
  repository: string;
  prNumber: number;
  headSha: string;
  capturedAt: string;
}

export interface AcceptanceObligation {
  text: string;
  proofMode: AcceptanceProofMode;
}

export interface AcceptanceSourceClassification {
  sourceId: string;
  sourceVersion: string;
  obligations: AcceptanceObligation[];
  /** Required when a source contributes no obligations. */
  exclusion?: string;
}

export interface AcceptanceDerivationResult {
  schemaVersion: 1;
  runId: string;
  generation: number;
  registrationRevision: number;
  unitId: string;
  classifications: AcceptanceSourceClassification[];
}

export interface AcceptanceCriterionSource {
  kind: AcceptanceDerivationSource['kind'];
  sourceId: string;
  sourceVersion: string;
  obligationIndex: number;
  url?: string;
}

export interface DerivedAcceptanceCriterion extends AcceptanceCriterionRef {
  proofMode: AcceptanceProofMode;
  source: AcceptanceCriterionSource;
}

export interface AcceptanceDerivationUnit {
  id: string;
  sources: AcceptanceDerivationSource[];
  /** A settled unit is immutable; an interactive steer creates a new unit. */
  result?: AcceptanceDerivationResult;
  /** A refused proposal remains pending with its actionable validation issues. */
  error?: string;
  delivery?: {
    status: 'pending' | 'confirmed';
    principalId: string;
    contextId?: string;
    commandId?: string;
    startedAt?: number;
    acceptedAt?: string;
  };
}

export interface AcceptanceRegistration {
  schemaVersion: 1;
  runId: string;
  /** Increases on every admitted instruction and accepted classification. */
  revision: number;
  intake: PRCompletionIntakeIdentity;
  original: AcceptanceCriterionRef[];
  derived: DerivedAcceptanceCriterion[];
  units: AcceptanceDerivationUnit[];
}
