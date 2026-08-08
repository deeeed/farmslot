// methods/improvement.ts — WS method handlers for improvement decisions

import type {
  ImprovementApplyParams,
  ImprovementApplyResult,
  ImprovementChatParams,
  ImprovementChatResult,
} from '@farmslot/protocol';

import { applyImprovement, chatRefine } from '../intelligence/improvement-engine.js';
import { getRun } from '../runs/store.js';

type EmitFn = (event: string, payload: unknown) => void;

export async function improvementChat(
  params: ImprovementChatParams,
  emit: EmitFn,
): Promise<ImprovementChatResult> {
  const result = await chatRefine(params.runId, params.decisionId, params.message, (delta) =>
    emit('improvement.chat.delta', {
      runId: params.runId,
      decisionId: params.decisionId,
      delta,
    }),
  );
  return result;
}

export async function improvementApply(
  params: ImprovementApplyParams,
  emit: EmitFn,
): Promise<ImprovementApplyResult> {
  const result = await applyImprovement(params.runId, params.decisionId);
  // Emit resolution only when the ENGINE resolved the card (all files applied
  // + validation passed). `applied.length > 0` alone covers partial applies,
  // where the card deliberately stays pending — emitting resolved for those
  // made the UI drop a card the store still considers open.
  const resolved =
    getRun(params.runId)?.decisions?.find((d) => d.id === params.decisionId)?.resolvedAction ===
    'applied';
  if (resolved) {
    emit('run.decision.resolved', { runId: params.runId, decisionId: params.decisionId });
  }
  // Always emit run.updated with the full run object so subscribers get the latest state
  const updatedRun = getRun(params.runId);
  if (updatedRun) {
    emit('run.updated', { run: updatedRun });
  }
  return result;
}
