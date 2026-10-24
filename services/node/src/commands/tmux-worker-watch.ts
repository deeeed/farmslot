import { createHash } from 'node:crypto';

import type { NodeTmuxPane, NodeTmuxWorkerObservation } from '@farmslot/protocol';

import { listPanes } from './tmux.js';

const DEFAULT_INTERVAL_MS = 2_000;
const MIN_INTERVAL_MS = 1_000;
const SIGNAL_FRESH_MS = 120_000;

type EmitChange = (change: NodeTmuxWorkerObservation) => void;

interface WorkerWatch {
  emit: EmitChange;
  running: boolean;
  lastSignature: string;
  unavailable: boolean;
  sample: () => Promise<NodeTmuxPane[]>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let activeWatch: WorkerWatch | null = null;

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

async function sampleAndEmit(watch: WorkerWatch): Promise<void> {
  if (watch.running || activeWatch !== watch) return;
  watch.running = true;
  let change: NodeTmuxWorkerObservation | undefined;
  try {
    const panes = await watch.sample();
    if (activeWatch !== watch) return;
    const observedAt = Date.now();
    const signature = panesSignature(panes, observedAt);
    if (watch.unavailable || signature !== watch.lastSignature) {
      watch.lastSignature = signature;
      watch.unavailable = false;
      change = { status: 'ready', observedAt, panes };
    }
  } catch (error) {
    if (activeWatch !== watch) return;
    // A failed sample revokes observation admission. The same producer remains
    // armed and publishes recovery even when the recovered panes are unchanged.
    if (!watch.unavailable) {
      watch.unavailable = true;
      change = {
        status: 'unavailable',
        observedAt: Date.now(),
        error: {
          code: 'WORKER_SAMPLE_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  } finally {
    watch.running = false;
  }
  // Delivery failures must not be mislabeled as sampler failures.
  if (change && activeWatch === watch) watch.emit(change);
}

export function startTmuxWorkerWatch(
  intervalMs: number | undefined,
  emit: EmitChange,
  sample: () => Promise<NodeTmuxPane[]> = listPanes,
): void {
  stopTmuxWorkerWatch();
  const watch: WorkerWatch = {
    emit,
    running: false,
    lastSignature: '',
    unavailable: false,
    sample,
  };
  activeWatch = watch;
  const effectiveInterval = Math.max(MIN_INTERVAL_MS, intervalMs ?? DEFAULT_INTERVAL_MS);
  void sampleAndEmit(watch);
  timer = setInterval(() => {
    void sampleAndEmit(watch);
  }, effectiveInterval);
  timer.unref();
}

export function stopTmuxWorkerWatch(): void {
  activeWatch = null;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
