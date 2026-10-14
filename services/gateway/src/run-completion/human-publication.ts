import {
  isGateParkInFlightOrFreed,
  type Run,
  type RunGatePrerequisiteReason,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { readSlotField } from '../core/state.js';
import { collectRunGateReadiness } from '../run-engine/gate-prerequisites.js';
import { isRunArchiving } from '../run-lifecycle/archive-fence.js';
import { withRunSources } from '../sources/runtime.js';

/** The publication exception never proves execution, idle, sources, or resource ownership. */
export async function adoptedPublicationContinuationRefusals(
  run: Run,
): Promise<RunGatePrerequisiteReason[]> {
  const reasons = (await collectRunGateReadiness(run, null, {}, 'post-publication')).reasons;
  if (isRunArchiving(run.id) || isGateParkInFlightOrFreed(run))
    reasons.push({
      code: 'publication-continuation-parked',
      prerequisite: 'lifecycle',
      message: 'Restore the run through its resource owner before continuing.',
    });
  if (!run.slotId || (await readSlotField(run.slotId, 'current_run_id')) !== run.id)
    reasons.push({
      code: 'publication-continuation-not-owner',
      prerequisite: 'lifecycle',
      message: 'The run does not own its continuation slot.',
    });
  if (run.decisions.some((decision) => !decision.resolvedAt))
    reasons.push({
      code: 'publication-continuation-waiting',
      prerequisite: 'lifecycle',
      message: 'Another run decision still requires resolution.',
    });
  try {
    await withRunSources(run, async () => {}, { planning: true });
  } catch (error) {
    reasons.push({
      code: 'publication-continuation-sources-unavailable',
      prerequisite: 'lifecycle',
      message: `Run sources cannot be verified: ${(error as Error).message}`,
    });
  }
  return reasons;
}

export async function assertAdoptedPublicationContinuation(run: Run): Promise<void> {
  const reasons = await adoptedPublicationContinuationRefusals(run);
  if (reasons.length)
    throw new GatewayMethodError(
      'RUN_GATE_NOT_READY',
      reasons.map((reason) => reason.message).join(' '),
      {
        details: { reasons },
        userAction: 'Resolve the continuation prerequisites; the adopted PR remains linked.',
      },
    );
}
