import type {
  EvidenceAttestationApprover,
  RunGatePrerequisiteReason,
} from './run-gate-readiness.js';
import type { PublicationStatus, Run } from './runs.js';

/** A human attests this revision, never a newer observed PR head or the prior package. */
export interface HumanPublicationAdoptionReceipt {
  schemaVersion: 1;
  id: string;
  runId: string;
  generation: number;
  approver: EvidenceAttestationApprover;
  reason: string;
  adoptedAt: string;
  repository: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
  observedHeadSha: string;
  observedBranch: string;
  observedDraft: boolean;
  observedState: 'open' | 'closed' | 'merged';
  publicationStatus: Extract<PublicationStatus, 'published_draft' | 'published_ready'>;
  priorGate?: {
    decisionId?: string;
    packageId?: string;
    packageHash?: string;
    headSha?: string | null;
    unmetPrerequisites: RunGatePrerequisiteReason[];
  };
}

export const PUBLICATION_ADOPTION_ACTION = 'superseded-by-publication-adoption';

/** The durable receipt owns the target even if project config subsequently changes. */
export function adoptedPublicationTarget(
  run: Pick<Run, 'engineState'>,
): { repository: string; prNumber: number } | undefined {
  const receipt = run.engineState?.publishGate?.humanPublicationAdoption;
  return receipt && { repository: receipt.repository, prNumber: receipt.prNumber };
}
