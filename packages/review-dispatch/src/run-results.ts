/**
 * The run results view model that Command Center and Companion share: the
 * results card for a run's retained output (a QA run's report among them) and
 * the acceptance tally above its per-AC and per-case rows. Each client only
 * renders these; neither recomputes a label, count or copy line.
 */

import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import {
  type AcceptanceCriterionRef,
  type AcceptanceRegistration,
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

export interface AcceptanceRegistrationPresentation {
  revision: number;
  pending: string[];
  exclusions: Array<{ sourceId: string; label: string; reason: string; url?: string }>;
}

export interface AcceptancePanelPresentation {
  registration?: AcceptanceRegistrationPresentation;
  unassessed: number;
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
  registration?: AcceptanceRegistration,
): AcceptancePanelPresentation {
  const summary = registration
    ? summarizeAcceptanceStatus(ledger, [...registration.original, ...registration.derived])
    : (model?.summary ?? summarizeAcceptanceStatus(ledger, criteria));
  const assessed = summary.total - summary.unrecorded;
  const pending = registration?.units.filter(({ result }) => !result) ?? [];
  // A replaced recording's verdicts are not a tally of the current evidence.
  const replaced = Boolean(model?.recording?.replacedBy);
  return {
    unassessed: summary.unrecorded,
    counts: replaced
      ? `${summary.total} criteria · evidence replaced${pending.length ? ' · acceptance update pending' : ''}`
      : `${assessed}/${summary.total} assessed${assessed ? ` · ${summary.proven} proven` : ''}${pending.length ? ' · acceptance update pending' : ''}`,
    countsTooltip:
      `proven ${summary.proven} · weak ${summary.weak} · missing ${summary.missing} · ` +
      `untestable ${summary.untestable} · not assessed ${summary.unrecorded}`,
    defaultOpen:
      pending.length > 0 || (assessed > 0 && summary.proven + summary.untestable < summary.total),
    ...(registration
      ? {
          registration: {
            revision: registration.revision,
            pending: pending.map(
              (unit) =>
                unit.error ??
                (unit.delivery?.status === 'pending'
                  ? 'Instruction delivery is not confirmed.'
                  : 'Sources are awaiting acceptance criteria.'),
            ),
            exclusions: registration.units.flatMap((unit) =>
              (unit.result?.classifications ?? [])
                .filter(({ exclusion }) => Boolean(exclusion))
                .map((row) => {
                  const source = unit.sources.find(({ id }) => id === row.sourceId);
                  return {
                    sourceId: row.sourceId,
                    label:
                      source?.kind === 'review-comment' ? 'Review comment' : 'Operator instruction',
                    reason: row.exclusion!,
                    ...(source?.url && /^https?:\/\//.test(source.url) ? { url: source.url } : {}),
                  };
                }),
            ),
          },
        }
      : {}),
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
