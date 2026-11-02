import { buildRunResolveDecisionParams, Methods, type Run } from '@farmslot/protocol';
import { operatorMessageInput } from '@farmslot/review-dispatch';

import type { PacketActionRequest } from './interactive-operator-packets';
import { assertNativeRunReady } from './run-collections';

/**
 * Sends a packet's terminal message or decision resolution. Run Detail can draw a run.list
 * row while run.get loads, and a row lacks the package fields a resolution carries, so each
 * write first checks the current run.get and is built from the run that check returns.
 */
export async function sendInteractivePacketWrite(
  client: { request(method: string, params: unknown): Promise<unknown> },
  shown: Run,
  request: Extract<PacketActionRequest, { kind: 'terminal.send' | 'decision.resolve' }>,
): Promise<void> {
  const run = assertNativeRunReady(shown.id, shown);
  if (request.kind === 'terminal.send') {
    if (!run.slotId) throw new Error('Run is not attached to a slot.');
    await client.request(Methods.TERMINAL_SEND, {
      slotId: run.slotId,
      runId: run.id,
      ...operatorMessageInput(request.text),
    });
    return;
  }
  const decision = run.decisions.find((candidate) => candidate.id === request.decisionId);
  if (!decision) throw new Error(`Decision ${request.decisionId} is no longer pending.`);
  await client.request(
    Methods.RUN_RESOLVE_DECISION,
    buildRunResolveDecisionParams({ runId: run.id, decision, actionId: request.actionId }),
  );
}
