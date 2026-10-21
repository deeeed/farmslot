import {
  type RecipeVisualJudgmentReceipt,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  recordedVisualJudgments,
  reviewFindingId,
  type ReviewFindingSettlement,
  type ReviewIssue,
  type ReviewStatus,
  type Run,
} from '@farmslot/protocol';
import { reviewFindingEntries } from '@farmslot/review-dispatch';

import { selectedSourceInputs, visualReviewAuthority } from './claim-reviews.js';
import type { RecordedEvidenceSource } from './recorded-evidence-sources.js';

interface ClaimFindingSource {
  input: RecordedEvidencePackageInput;
  artifactPrefix?: string;
}

function capturedSourcePrefix(run: Run, input: RecordedEvidencePackageInput): string {
  const prefixes = new Set(
    (run.agentContexts ?? []).flatMap((context) => {
      const captured = context.pipelineVisualReviewInput;
      const sources = !captured ? [] : 'schemaVersion' in captured ? captured.sources : [captured];
      return sources
        .filter(
          (source) =>
            source.recipeRunId === input.claims?.recipeRunId &&
            source.closureIdentity === recordedEvidenceClosureIdentity(input),
        )
        .map((source) => source.artifactPrefix);
    }),
  );
  return prefixes.size === 1 ? ([...prefixes][0] ?? '') : '';
}

/** A source-code citation is not a visual finding, even when it names the same AC. */
function evidenceFindingClaim(
  issue: ReviewIssue,
  source: RecordedEvidenceSource,
): string | undefined {
  const file = issue.file.replaceAll('\\', '/');
  const relative = file.startsWith('artifacts/')
    ? file
    : file.slice(file.lastIndexOf('/artifacts/') + 1);
  const sourcePath = relative.startsWith(source.artifactPrefix)
    ? relative.slice(source.artifactPrefix.length)
    : undefined;
  const evidenceLocation =
    relative === 'artifacts/evidence-manifest.json' ||
    (sourcePath !== undefined &&
      source.input.artifactPaths?.includes(sourcePath) &&
      /\.(?:png|jpe?g|webp|gif|mp4|mov|webm)$/iu.test(sourcePath));
  if (
    !evidenceLocation ||
    /\b[\w./-]+\.(?:[cm]?[jt]sx?|rs|py|swift|kt|java)\b/iu.test(issue.description)
  )
    return;
  const declared = source.input.claims?.criteria.map((claim) => claim.id) ?? [];
  const tokens = new Set(issue.description.split(/[^\w-]+/u).map((token) => token.toLowerCase()));
  const ids = declared.filter((id) => tokens.has(id.toLowerCase()));
  const foreign = [...tokens].some(
    (token) => /^ac-\d+$/u.test(token) && !declared.some((id) => id.toLowerCase() === token),
  );
  return ids.length === 1 && !foreign ? ids[0] : undefined;
}

/**
 * Qualify one person decision against the original structured review and the
 * independent visual result captured for that same head and evidence closure.
 */
export function projectClaimFindingSettlements(
  run: Run,
  sources: readonly ClaimFindingSource[],
  headSha: string,
  reviews: readonly ReviewStatus[],
  validReviewIds: ReadonlySet<string>,
): { receipts: RecipeVisualJudgmentReceipt[]; reviews: ReviewStatus[] } {
  const raw = reviews.map(({ settledFindings: _settled, ...review }) => review);
  const receipts = (run.visualJudgmentReceipts ?? []).map((receipt) => ({ ...receipt }));
  const settlements: ReviewFindingSettlement[] = [];
  for (const candidate of sources) {
    const source = {
      ...candidate,
      artifactPrefix: candidate.artifactPrefix ?? capturedSourcePrefix(run, candidate.input),
    };
    for (const selected of selectedSourceInputs(source.input)) {
      const input = selected.input;
      const current = new Map(
        recordedVisualJudgments(input, visualReviewAuthority(run, input))
          .filter((judgment) => judgment.kind === 'person-reviewed')
          .map((judgment) => [judgment.claimId, judgment]),
      );
      for (const { review, entry, head } of reviewFindingEntries(raw)) {
        if (head !== headSha || !validReviewIds.has(review.id)) continue;
        for (const issue of entry.issues ?? []) {
          const claimId = evidenceFindingClaim(issue, source);
          if (!claimId || !selected.claimIds.has(claimId)) continue;
          const judgment = current.get(claimId);
          if (judgment?.verdict !== 'confirmed') continue;
          const receipt = receipts.find((candidate) => candidate.id === judgment.receiptId);
          if (!receipt) continue;
          const capturedRejection = run.agentContexts?.some((context) => {
            const captured = context.pipelineVisualReviewResult;
            const binding = context.nativeSession;
            if (
              context.role !== 'review' ||
              context.runId !== run.id ||
              context.reviewId !== review.id ||
              context.runnerSessionId !== review.reviewerSessionId ||
              !captured ||
              !binding ||
              captured.headSha !== headSha ||
              captured.binding.contextId !== context.id ||
              captured.binding.commandId !== binding?.commandId ||
              captured.binding.leaseId !== binding.leaseId ||
              captured.binding.generation !== binding.generation
            )
              return false;
            const results =
              captured.result.schemaVersion === 2 ? captured.result.sources : [captured.result];
            return results.some(
              (result) =>
                result.recipeRunId === receipt.recipeRunId &&
                result.closureIdentity === receipt.closureIdentity &&
                result.judgments.some(
                  (candidate) => candidate.claimId === claimId && candidate.verdict === 'rejected',
                ),
            );
          });
          if (!capturedRejection) continue;
          const reference = {
            findingId: reviewFindingId(review.id, headSha, issue),
            reviewId: review.id,
            headSha,
          };
          receipt.settledReviewFindings = [...(receipt.settledReviewFindings ?? [])];
          if (
            !receipt.settledReviewFindings.some(
              (candidate) => candidate.findingId === reference.findingId,
            )
          )
            receipt.settledReviewFindings.push(reference);
          settlements.push({ ...reference, receiptId: receipt.id, claimId });
        }
      }
    }
  }
  return {
    receipts,
    reviews: raw.map((review) => {
      const unique = new Map(
        settlements
          .filter((entry) => entry.reviewId === review.id)
          .map((entry) => [entry.findingId, entry]),
      );
      return unique.size ? { ...review, settledFindings: [...unique.values()] } : review;
    }),
  };
}
