// methods/terminal-worker.ts — terminal-compatible worker-ref tmux control

import type {
  TerminalWorkerInputParams,
  TerminalWorkerResizeParams,
  TerminalWorkerSnapshotParams,
  TerminalWorkerSnapshotResult,
  TerminalWorkerSubscribeParams,
  TmuxWorkerRef,
} from '@farmslot/protocol';

import { isLocal } from '../core/exec.js';
import { loadPoolConfigs } from '../fleet/state.js';
import {
  hasPty,
  type PtyDataHandler,
  resizePty,
  subscribePty,
  writePty,
} from '../runtime/pty-stream.js';
import {
  captureWorkerTerminal,
  resizeWorkerTerminal,
  sendWorkerTerminalInput,
} from '../runtime/worker-terminal-stream.js';

import { assertTmuxWorkerControlAllowed } from './tmux-workers.js';

type EventEmitter = (event: string, payload: unknown) => void;

export function terminalWorkerSubscriptionKey(params: {
  worker: { nodeId: string; target: string };
}): string {
  return `${params.worker.nodeId}:${params.worker.target}`;
}

async function resolveWorkerPtyOptions(worker: TmuxWorkerRef): Promise<{ sshTarget?: string }> {
  const pools = await loadPoolConfigs();
  const pool = pools.find((candidate) => candidate.machine === worker.nodeId);
  if (!pool) throw new Error(`pool config for tmux worker node ${worker.nodeId} was not found`);
  if (isLocal(pool.host, pool.machine)) return {};
  return { sshTarget: `${pool.sshUser}@${pool.host}` };
}

export async function terminalWorkerSubscribe(
  params: TerminalWorkerSubscribeParams,
  emit: EventEmitter,
): Promise<{ key: string; ptyHandler: PtyDataHandler }> {
  await assertTmuxWorkerControlAllowed(params.worker);
  const key = terminalWorkerSubscriptionKey(params);
  const ptyOptions = await resolveWorkerPtyOptions(params.worker);
  const ptyHandler: PtyDataHandler = (data: string) => {
    emit('terminal.data', { worker: params.worker, data, timestamp: Date.now() });
  };
  subscribePty(key, params.worker.session, ptyHandler, params.cols, params.rows, {
    ...ptyOptions,
    selectTarget: params.worker.target,
  });
  emit('terminal.mode', { worker: params.worker, mode: 'pty' });
  return { key, ptyHandler };
}

export function terminalWorkerUnsubscribeKey(params: {
  worker: { nodeId: string; target: string };
}): string {
  return terminalWorkerSubscriptionKey(params);
}

export async function terminalWorkerInput(params: TerminalWorkerInputParams): Promise<void> {
  await assertTmuxWorkerControlAllowed(params.worker);
  const key = terminalWorkerSubscriptionKey(params);
  if (hasPty(key)) {
    writePty(key, params.data);
    return;
  }
  await sendWorkerTerminalInput(params.worker, params.data);
}

export async function terminalWorkerResize(params: TerminalWorkerResizeParams): Promise<void> {
  await assertTmuxWorkerControlAllowed(params.worker);
  const key = terminalWorkerSubscriptionKey(params);
  if (hasPty(key)) {
    resizePty(key, params.cols, params.rows);
    return;
  }
  await resizeWorkerTerminal(params.worker, params.cols, params.rows);
}

export async function terminalWorkerSnapshot(
  params: TerminalWorkerSnapshotParams,
): Promise<TerminalWorkerSnapshotResult> {
  await assertTmuxWorkerControlAllowed(params.worker);
  return {
    worker: params.worker,
    lines: await captureWorkerTerminal(params.worker, params.lines ?? 200),
    timestamp: Date.now(),
  };
}

export type { PtyDataHandler as WorkerTerminalPtyHandler } from '../runtime/pty-stream.js';
export { unsubscribePty as unsubscribeWorkerTerminalPty } from '../runtime/pty-stream.js';
