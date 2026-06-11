import { createHash } from 'node:crypto';

import type { NodeTmuxPane } from '@farmslot/protocol';

import { listPanes } from './tmux.js';

const DEFAULT_INTERVAL_MS = 2_000;
const MIN_INTERVAL_MS = 1_000;
const SIGNAL_FRESH_MS = 120_000;

export interface TmuxWorkerWatchChange {
  observedAt: number;
  panes: NodeTmuxPane[];
}

type EmitChange = (change: TmuxWorkerWatchChange) => void;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastSignature = '';

function signalFreshnessBucket(observedAt: number | undefined, now: number): string | undefined {
  if (observedAt == null) return undefined;
  return now - observedAt <= SIGNAL_FRESH_MS ? 'fresh' : 'stale';
}

function signalSignature(
  signal: NodeTmuxPane['signals'] | undefined,
  now: number,
): Record<string, unknown> | undefined {
  if (!signal) return undefined;
  return {
    hook: signal.hook
      ? {
          event: signal.hook.event,
          label: signal.hook.label,
          freshness: signalFreshnessBucket(signal.hook.observedAt, now),
        }
      : undefined,
    statusline: signal.statusline
      ? {
          label: signal.statusline.label,
          busy: signal.statusline.busy,
          model: signal.statusline.model,
          ctxPct: signal.statusline.ctxPct,
          freshness: signalFreshnessBucket(signal.statusline.observedAt, now),
        }
      : undefined,
    taskFile: signal.taskFile
      ? {
          label: signal.taskFile.label,
          status: signal.taskFile.status,
          phase: signal.taskFile.phase,
          freshness: signalFreshnessBucket(signal.taskFile.observedAt, now),
        }
      : undefined,
    process: signal.process
      ? {
          active: signal.process.active,
          freshness: signalFreshnessBucket(signal.process.observedAt, now),
        }
      : undefined,
  };
}

export function panesSignature(panes: NodeTmuxPane[], now = Date.now()): string {
  const stable = panes
    .map((pane) => ({
      session: pane.session,
      window: pane.window,
      windowName: pane.windowName,
      pane: pane.pane,
      paneId: pane.paneId,
      target: pane.target,
      cwd: pane.cwd,
      command: pane.command,
      pid: pane.pid,
      branch: pane.branch,
      lastChangedAt: pane.lastChangedAt,
      signals: signalSignature(pane.signals, now),
    }))
    .sort((a, b) => `${a.session}:${a.target}`.localeCompare(`${b.session}:${b.target}`));
  return createHash('sha1').update(JSON.stringify(stable)).digest('hex');
}

async function sampleAndEmit(emit: EmitChange): Promise<void> {
  if (running) return;
  running = true;
  try {
    const observedAt = Date.now();
    const panes = await listPanes();
    const signature = panesSignature(panes, observedAt);
    if (signature !== lastSignature) {
      lastSignature = signature;
      emit({ observedAt, panes });
    }
  } catch (error) {
    // The watcher is telemetry-only. Keep it alive after transient tmux/fs errors;
    // request-time tmux.panes still surfaces hard failures to operators.
    console.warn(`[tmux-worker-watch] sample failed: ${(error as Error).message}`);
  } finally {
    running = false;
  }
}

export function startTmuxWorkerWatch(intervalMs: number | undefined, emit: EmitChange): void {
  stopTmuxWorkerWatch();
  lastSignature = '';
  const effectiveInterval = Math.max(MIN_INTERVAL_MS, intervalMs ?? DEFAULT_INTERVAL_MS);
  void sampleAndEmit(emit);
  timer = setInterval(() => {
    void sampleAndEmit(emit);
  }, effectiveInterval);
  timer.unref();
}

export function stopTmuxWorkerWatch(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  running = false;
}
