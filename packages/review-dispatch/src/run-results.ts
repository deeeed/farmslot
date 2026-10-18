/**
 * The run results view model that Command Center and Companion share: the
 * results card for a run's retained output (a QA run's report among them) and
 * the acceptance tally above its per-AC and per-case rows. Each client only
 * renders these; neither recomputes a label, count or copy line.
 */

import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import {
  type AcceptanceCriterionRef,
  type AcceptanceStatusLedger,
  isHeldForResultDecision,
  type OutputReviewPayload,
  type Run,
  type RunDecision,
  type RunStep,
  summarizeAcceptanceStatus,
} from '@farmslot/protocol';

export type OutputReviewDecision = RunDecision & { payload: OutputReviewPayload };

function isPendingOutputReview(decision: RunDecision): decision is OutputReviewDecision {
  return !decision.resolvedAt && decision.payload?.kind === 'output-review';
}

/** The run's open output review, whose report snapshot run detail checks the retained report against. */
export function pendingOutputReview(
  run: Pick<Run, 'decisions'> | null | undefined,
): OutputReviewDecision | undefined {
  return run?.decisions.find(isPendingOutputReview);
}

export interface AcceptancePanelPresentation {
  /** Assessment progress stays distinct from how many criteria are proven. */
  counts: string;
  /** Long-form tally for the header tooltip or accessibility label, including the zero buckets. */
  countsTooltip: string;
  /** The panel opens by default once a criterion is assessed and not all are proven.
   * While nothing is assessed, the counts line is the whole view and the list opens on demand. */
  defaultOpen: boolean;
}

export function acceptancePanelPresentation(
  ledger: AcceptanceStatusLedger,
  criteria: ReadonlyArray<AcceptanceCriterionRef> = ledger.criteria,
  model?: EvidenceReviewModel,
): AcceptancePanelPresentation {
  const summary = model?.summary ?? summarizeAcceptanceStatus(ledger, criteria);
  const assessed = summary.total - summary.unrecorded;
  return {
    counts: `${assessed}/${summary.total} assessed${assessed ? ` · ${summary.proven} proven` : ''}`,
    countsTooltip:
      `proven ${summary.proven} · weak ${summary.weak} · missing ${summary.missing} · ` +
      `untestable ${summary.untestable} · not assessed ${summary.unrecorded}`,
    defaultOpen: assessed > 0 && summary.proven + summary.untestable < summary.total,
  };
}

export interface RunResultsSummary {
  shouldRender: boolean;
  completeStep: RunStep | undefined;
  title: string;
  badge: string;
  status: RunStep['status'];
  copy: string;
  showEvalPackageHint: boolean;
  emptyMessage: string;
}

/** The results card for a run, given how many output artifacts the client collected. */
export function runResultsSummary(run: Run, artifactCount: number): RunResultsSummary {
  const isReplay =
    run.lane === 'comparison' || Boolean(run.startRef) || Boolean(run.engineState?.evalExperiment);
  const completeStep = run.steps.find((step) => step.name === 'complete');
  const sourceRef = run.startRef?.resolvedSha ?? run.startRef?.requestedRef;
  const hasOutput = Boolean(run.output);
  return {
    // A review-workspace run shows its review process instead of a results card.
    shouldRender:
      !run.reviewWorkspaceTarget &&
      (hasOutput || run.completionPolicy === 'artifact-only' || isReplay || artifactCount > 0),
    completeStep,
    title: isReplay ? 'Replay evidence' : 'Run results',
    badge: isReplay ? 'comparison · artifact-only' : (run.metrics.outcome ?? run.status),
    status:
      completeStep?.status ??
      (run.status === 'done' ? 'done' : run.status === 'failed' ? 'failed' : 'pending'),
    copy:
      run.resultDecisionReceipt?.action === 'accept-result'
        ? `Accepted without publishing${run.resultDecisionReceipt.reason ? `: ${run.resultDecisionReceipt.reason}` : '.'}`
        : run.output?.closedAt
          ? `Execution closed. The recorded result remains ${run.metrics.outcome ?? 'unknown'}; closing is not validation or release approval.`
          : isHeldForResultDecision(run)
            ? 'The worker delivered this result. It waits for a decision.'
            : run.output?.workerFinished
              ? 'The worker has finished. Read its findings and coverage gaps before reviewing the output. Reviewing does not change the verdict or publish anything.'
              : hasOutput
                ? 'Files retained from the worker. Execution is still in progress.'
                : run.startRef
                  ? `This replay started from ${sourceRef ?? 'the selected ref'} and stopped at artifacts. Prior-run replay comparisons are represented by eval Reference and Candidate packages, not run parentage; no PR was published.`
                  : isReplay
                    ? 'This comparison run stops at artifacts instead of publishing a PR. Use these captured files as the run output evidence.'
                    : 'Final artifacts captured by the worker.',
    showEvalPackageHint: Boolean(run.startRef),
    emptyMessage: run.output?.captureError
      ? `Could not retrieve worker files: ${run.output.captureError}`
      : 'No output files have been retrieved yet.',
  };
}
