// worker-terminal-stream.ts — Poll node tmux panes by worker ref and stream terminal.data

import type { TerminalData, TmuxWorkerRef } from '@farmslot/protocol';

import { getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';

export type WorkerTerminalDataHandler = (data: TerminalData) => void;

interface Subscription {
  worker: TmuxWorkerRef;
  handler: WorkerTerminalDataHandler;
  lastContent: string;
}

const subscriptions = new Map<string, Subscription[]>();
let pollInterval: ReturnType<typeof setInterval> | null = null;
const POLL_MS = 500;
const DEFAULT_LINES = 200;

export function workerTerminalKey(worker: TmuxWorkerRef): string {
  return `${worker.nodeId}:${worker.target}`;
}

function requireNode(worker: TmuxWorkerRef) {
  const node = getNode(worker.nodeId);
  if (!node) throw new Error(`node ${worker.nodeId} is not connected`);
  return node;
}

export async function captureWorkerTerminal(
  worker: TmuxWorkerRef,
  lines = DEFAULT_LINES,
): Promise<string[]> {
  const payload = (await sendNodeRequest(
    requireNode(worker),
    'tmux.capture',
    { session: worker.target, lines },
    { timeout: 5_000 },
  )) as { lines?: unknown };
  if (!Array.isArray(payload.lines)) throw new Error('node tmux.capture returned invalid payload');
  return payload.lines.filter((line): line is string => typeof line === 'string');
}

export async function sendWorkerTerminalInput(worker: TmuxWorkerRef, data: string): Promise<void> {
  await sendNodeRequest(
    requireNode(worker),
    'tmux.send',
    { session: worker.target, text: data, enter: false },
    { timeout: 5_000 },
  );
}

export async function resizeWorkerTerminal(
  worker: TmuxWorkerRef,
  cols: number,
  rows: number,
): Promise<void> {
  await sendNodeRequest(
    requireNode(worker),
    'tmux.resize',
    { target: worker.target, cols, rows },
    { timeout: 5_000 },
  );
}

export function subscribeWorkerTerminal(
  worker: TmuxWorkerRef,
  handler: WorkerTerminalDataHandler,
): string {
  const key = workerTerminalKey(worker);
  const existing = subscriptions.get(key) ?? [];
  existing.push({ worker, handler, lastContent: '' });
  subscriptions.set(key, existing);
  if (!pollInterval) startPolling();
  return key;
}

export function unsubscribeWorkerTerminal(key: string, handler: WorkerTerminalDataHandler): void {
  const subs = subscriptions.get(key);
  if (!subs) return;
  const filtered = subs.filter((sub) => sub.handler !== handler);
  if (filtered.length === 0) subscriptions.delete(key);
  else subscriptions.set(key, filtered);
  if (subscriptions.size === 0 && pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function startPolling(): void {
  pollInterval = setInterval(async () => {
    const keys = [...subscriptions.keys()];
    await Promise.all(
      keys.map(async (key) => {
        const subs = subscriptions.get(key);
        if (!subs || subs.length === 0) return;
        const worker = subs[0].worker;
        let content = '';
        try {
          content = (await captureWorkerTerminal(worker)).join('\n');
        } catch (error) {
          console.warn(
            `[worker-terminal] capture failed for ${worker.nodeId} target=${worker.target}: ${(error as Error).message}`,
          );
          return;
        }
        if (!content || content === subs[0].lastContent) return;
        const data: TerminalData = { worker, data: content, timestamp: Date.now() };
        for (const sub of subs) {
          sub.lastContent = content;
          sub.handler(data);
        }
      }),
    );
  }, POLL_MS);
}
