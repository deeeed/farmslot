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
  const allApplied = result.applied.length > 0 && result.validationPassed;
  // Emit resolution events so the UI removes the decision and updates run state
  if (allApplied) {
    emit('run.decision.resolved', { runId: params.runId, decisionId: params.decisionId });
  }
  // Always emit run.updated with the full run object so subscribers get the latest state
  const updatedRun = getRun(params.runId);
  if (updatedRun) {
    emit('run.updated', { run: updatedRun });
  }
  return result;
}
