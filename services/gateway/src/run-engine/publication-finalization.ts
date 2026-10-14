import { PUBLICATION_ADOPTION_ACTION, type Run } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { isPublishedStatus, publicationStatusForRun } from '../run-completion/orchestrator.js';

import { latestResolvedHumanGateDecision } from './decision-replay.js';
import {
  CLOSE_AS_SHIPPED_ACTION,
  hasValidPrNumber,
  isPublishApprovalAction,
} from './gate-policy.js';
import { requiresPublicationApproval } from './publication-policy.js';

/** Review requests and continuations resolve a decision without fulfilling publication. */
export function publicationFinalizationAction(run: Run): string | undefined {
  if (run.engineState?.publishGate?.humanPublicationAdoption) return PUBLICATION_ADOPTION_ACTION;
  if (
    run.decisions.some((decision) => decision.type === 'engine_human_gate' && !decision.resolvedAt)
  )
    return undefined;
  const action = latestResolvedHumanGateDecision(run.decisions)?.resolvedAction;
  return isPublishApprovalAction(action) || action === CLOSE_AS_SHIPPED_ACTION ? action : undefined;
}

export function assertPublicationFinalization(run: Run, phase: 'finalize' | 'complete'): void {
  if (!requiresPublicationApproval(run)) return;
  const action = publicationFinalizationAction(run);
  const publicationStatus = publicationStatusForRun(run);
  const missingApproval = !action;
  if (
    missingApproval ||
    (phase === 'complete' &&
      action !== CLOSE_AS_SHIPPED_ACTION &&
      (!isPublishedStatus(publicationStatus) || !hasValidPrNumber(run)))
  ) {
    throw new GatewayMethodError(
      'RUN_GATE_NOT_READY',
      missingApproval
        ? 'Local-first publication requires approve-publish before finalize'
        : 'Local-first publication has not completed before run settlement',
      {
        details: { publicationStatus, phase, publicationApprovalMissing: missingApproval },
        userAction:
          'Replay the human-gate step after the worker finishes and resolve its publication approval.',
      },
    );
  }
}
