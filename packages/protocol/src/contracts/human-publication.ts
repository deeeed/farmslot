import type {
  EvidenceAttestationApprover,
  RunGatePrerequisiteReason,
} from './run-gate-readiness.js';
import type { PublicationStatus, Run } from './runs.js';

/** How an adopted PR was matched to the run: by its patch, or by a human-attested head. */
export interface PublicationAdoptionMatch {
  type: 'content-match' | 'attested';
  runBranch: string;
  prBranch: string;
  /** Files whose change differs from the reviewed patch; empty for a content match. */
  differingFiles: string[];
  /** The PR range compared (base...head), pinned to the SHAs read with the PR facts. */
  compared: { baseSha: string; headSha: string };
  /** Why the content could not be compared (attested adoptions only). */
  unavailable?: string;
}

/** A human adopts this revision, never a newer observed PR head or the prior package. */
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
  /** Absent on receipts recorded before content matching (same branch, attested head). */
  match?: PublicationAdoptionMatch;
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

/** The branch the run's published PR lives on: an adopted PR's own branch (it may differ from the
 * run's, for a republished PR), otherwise the run's branch. */
export function publishedBranchOf(run: Pick<Run, 'engineState' | 'branch'>): string | undefined {
  return (
    run.engineState?.publishGate?.humanPublicationAdoption?.observedBranch ??
    run.branch ??
    undefined
  );
}
