import { type FlowType, modeForFlow, type Run, type RunCreateParams } from '@farmslot/protocol';

import {
  buildFollowUpClassification,
  buildFollowUpLineage,
} from '../family-observability/context.js';

import { resolveCIWatchChainFlowType } from './dispatch-policy.js';
import { hasValidPrNumber } from './gate-policy.js';

export function buildCIWatchChainedRunParams(
  current: Pick<
    Run,
    | 'project'
    | 'ticketOrPr'
    | 'slotId'
    | 'branch'
    | 'mode'
    | 'prNumber'
    | 'summary'
    | 'metrics'
    | 'id'
    | 'familyId'
    | 'familyRootTicketOrPr'
    | 'parentRunId'
    | 'lane'
    | 'variant'
    | 'safetyTier'
    | 'allowedSlots'
    | 'backlogItemId'
    | 'ticketData'
    | 'effort'
  >,
  dispatchAction: string | null | undefined,
  ciRepo?: string | null,
): {
  flowType: FlowType;
  createParams: RunCreateParams;
  updateFields: Partial<Run>;
  engineFlags: { skipPrepare?: true };
} | null {
  const flowType = resolveCIWatchChainFlowType(dispatchAction);
  if (!flowType) return null;
  // prNumber === 0 is the invalid sentinel (review-input capture rejects it);
  // chaining a pr-complete on owner/repo#0 would dispatch against an invalid PR.
  const validPr = hasValidPrNumber(current);
  const ticketOrPr =
    flowType === 'pr-complete' && validPr && ciRepo
      ? `${ciRepo}#${current.prNumber}`
      : current.ticketOrPr;
  return {
    flowType,
    createParams: {
      flowType,
      project: current.project,
      ticketOrPr,
      slotId: current.slotId ?? undefined,
      branch: current.branch ?? undefined,
      // Chained runs inherit the parent's runner+model unchanged. The parent
      // already validated that combo at runCreate, so propagating it can't
      // produce an impossible runner+model wedge. Flow-specific model
      // preferences (e.g. "merge-main wants the strongest model") belong in
      // project config, not hard-coded constants — see project.json.
      model: current.metrics.model ?? undefined,
      runner: current.metrics.runner ?? undefined,
      effort: current.effort,
      // Headless CI-watch follow-ups (pr-complete / merge-main) always use the
      // flow baseline mode. Interactive belongs on the operator's initial worker
      // (e.g. dev), not on chained fix loops inherited via current.mode.
      mode: modeForFlow(flowType),
      // Chained CI-watch runs inherit parent's safety tier (ADR-023) and
      // the operator's machine/allowed-slot restriction so the chain
      // doesn't leak onto a machine the user filtered out.
      safetyTier: current.safetyTier,
      backlogItemId: current.backlogItemId,
      allowedSlots:
        current.allowedSlots && current.allowedSlots.length > 0
          ? [...current.allowedSlots]
          : undefined,
      ...buildFollowUpLineage(current),
      ...buildFollowUpClassification(current),
    },
    updateFields: {
      ...(validPr ? { prNumber: current.prNumber } : {}),
      ...(current.summary ? { summary: current.summary } : {}),
    },
    // CI-watch follow-ups are intentionally chained onto the just-completed,
    // keep-warm slot. Re-running full PREPARE here tears down that known-good
    // browser/profile and can fail before the follow-up worker even sees the
    // task (for example on Example App unlock actionability flakes). The follow-up
    // should reuse the warm workspace and let DISPATCH launch the worker.
    engineFlags: current.slotId ? { skipPrepare: true } : {},
  };
}
