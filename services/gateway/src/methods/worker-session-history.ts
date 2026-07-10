import {
  type AgentRole,
  Events,
  type Run,
  type WorkerSessionHistoryCursor,
  type WorkerSessionHistoryDeltaPayload,
  type WorkerSessionHistoryGetParams,
  type WorkerSessionHistoryGetResult,
  type WorkerSessionHistorySnapshot,
  type WorkerSessionHistorySubscribeParams,
  type WorkerSessionHistorySubscribeResult,
  type WorkerSessionHistoryUnsubscribeParams,
} from '@farmslot/protocol';

import { selectAgentContext } from '../agents/contexts.js';
import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { loadFleetStatus } from '../fleet/state.js';
import { runnerPersistsSessionFiles } from '../runners/registry.js';
import { resolveRunnerSessionForRun } from '../runners/session-process.js';
import {
  getRunnerSessionHistoryProvider,
  runnerHistorySessionFilePath,
} from '../runners/worker-session-history.js';
import { getRun, listRuns } from '../runs/store.js';

import { resolveBoundTerminalRunForSlot, selectActiveRunForSlot } from './run/context.js';

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 1_000;
const READ_MAX_LINES = 10_000;
const SUBSCRIBE_POLL_MS = 1_000;

type Emit = (event: string, payload: unknown) => void;

interface SessionFileRead {
  path: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  lines: string[];
  truncated: boolean;
}

export type WorkerSessionHistoryUnsubscribe = () => void;

export function workerSessionHistoryEnabled(): boolean {
  return process.env.FARMSLOT_EXPERIMENTAL_WORKER_HISTORY !== '0';
}

function normalizeLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function unavailableSnapshot(
  params: Pick<WorkerSessionHistoryGetParams, 'slotId' | 'runId' | 'role' | 'contextId'>,
  reason: string,
  input?: Partial<WorkerSessionHistorySnapshot>,
): WorkerSessionHistorySnapshot {
  return {
    slotId: input?.slotId ?? params.slotId ?? null,
    runId: params.runId ?? null,
    role: params.role,
    contextId: params.contextId,
    runner: input?.runner ?? null,
    model: input?.model ?? null,
    runnerSessionId: input?.runnerSessionId ?? null,
    runnerSessionPath: input?.runnerSessionPath ?? null,
    source: input?.source ?? 'unavailable',
    messages: [],
    degradedReason: reason,
    generatedAt: new Date().toISOString(),
  };
}

async function resolveTargetRun(params: WorkerSessionHistoryGetParams): Promise<Run | null> {
  if (params.runId) return getRun(params.runId) ?? null;
  if (!params.slotId) return null;
  const { runs: active } = listRuns({ active: true });
  const slot = (await loadFleetStatus()).slots.find(
    (candidate) => candidate.slot === params.slotId,
  );
  return (
    resolveBoundTerminalRunForSlot(slot?.currentRunId) ??
    selectActiveRunForSlot(params.slotId, active, slot?.currentRunId)
  );
}

function selectedRole(params: WorkerSessionHistoryGetParams, run: Run): AgentRole | undefined {
  if (params.role) return params.role;
  return selectAgentContext(run)?.role;
}

async function readSessionFile(params: {
  slotId: string;
  runner: string;
  sessionPath: string;
}): Promise<SessionFileRead> {
  const vars = await loadSlotVars(params.slotId);
  const effectivePath = runnerHistorySessionFilePath(params.sessionPath, params.runner);
  const script = `
python3 - <<'PY'
import json
from collections import deque
from pathlib import Path

path = Path(${JSON.stringify(effectivePath)})
max_lines = ${READ_MAX_LINES}
if not path.exists():
    print(json.dumps({"path": str(path), "exists": False, "size": 0, "mtimeMs": 0, "lines": [], "truncated": False}))
    raise SystemExit(0)
stat = path.stat()
items = deque(maxlen=max_lines)
count = 0
with path.open("r", encoding="utf-8", errors="replace") as handle:
    for line in handle:
        count += 1
        items.append(line.rstrip("\\n"))
print(json.dumps({
    "path": str(path),
    "exists": True,
    "size": stat.st_size,
    "mtimeMs": int(stat.st_mtime * 1000),
    "lines": list(items),
    "truncated": count > max_lines,
}))
PY`;
  const result = await execOnSlot(vars, script, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.exitCode !== 0) {
    throw new Error(`worker history read failed for ${params.slotId}: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as SessionFileRead;
}

export async function workerSessionHistoryGet(
  params: WorkerSessionHistoryGetParams,
): Promise<WorkerSessionHistoryGetResult> {
  if (!workerSessionHistoryEnabled()) {
    return {
      snapshot: unavailableSnapshot(params, 'Experimental worker history is disabled.'),
    };
  }

  const run = await resolveTargetRun(params);
  if (!run) {
    return {
      snapshot: unavailableSnapshot(params, 'No active or linked run is available for this slot.'),
    };
  }
  if (params.runId && params.slotId && run.slotId && run.slotId !== params.slotId) {
    return {
      snapshot: unavailableSnapshot(
        params,
        `Run ${run.id} belongs to slot ${run.slotId}, not ${params.slotId}.`,
        {
          runId: run.id,
        },
      ),
    };
  }

  const ctx = selectAgentContext(run, {
    role: params.role,
    contextId: params.contextId,
  });
  const runner = ctx?.runner ?? run.metrics.runner;
  const model = ctx?.model ?? run.metrics.model ?? null;
  const role = selectedRole(params, run);
  const contextId = params.contextId ?? ctx?.id;
  const slotId = params.slotId ?? run.slotId ?? undefined;
  const runnerSessionId = ctx?.runnerSessionId ?? run.metrics.runnerSessionId ?? null;
  let runnerSessionPath = ctx?.runnerSessionPath ?? run.metrics.runnerSessionPath ?? null;

  const base = { ...params, slotId, runId: run.id, role, contextId };
  if (!slotId) {
    return {
      snapshot: unavailableSnapshot(base, 'Run is not associated with a slot.', {
        runId: run.id,
        runner,
        model,
        runnerSessionId,
        runnerSessionPath,
      }),
    };
  }
  if (!runner) {
    return { snapshot: unavailableSnapshot(base, 'Run has no runner metadata.', { model }) };
  }

  const provider = getRunnerSessionHistoryProvider(runner);
  if (!provider) {
    return {
      snapshot: unavailableSnapshot(base, `${runner} transcript projection is not implemented.`, {
        runner,
        model,
        runnerSessionId,
        runnerSessionPath,
      }),
    };
  }

  if (!runnerPersistsSessionFiles(runner)) {
    return {
      snapshot: unavailableSnapshot(base, `${runner} does not persist runner transcript files.`, {
        runner,
        model,
        runnerSessionId,
        runnerSessionPath,
        source: 'pane-degraded',
      }),
    };
  }

  if (!runnerSessionPath) {
    const vars = await loadSlotVars(slotId);
    const binding = await resolveRunnerSessionForRun(run, vars);
    runnerSessionPath = binding?.runnerSessionPath ?? null;
  }

  if (!runnerSessionPath) {
    return {
      snapshot: unavailableSnapshot(base, 'No runner transcript path is attached to this run.', {
        runner,
        model,
        runnerSessionId,
      }),
    };
  }

  const read = await readSessionFile({
    slotId,
    runner,
    sessionPath: runnerSessionPath,
  });
  if (!read.exists) {
    return {
      snapshot: unavailableSnapshot(base, 'Runner transcript file is not available on disk.', {
        runner,
        model,
        runnerSessionId,
        runnerSessionPath: read.path,
      }),
    };
  }

  const projection = provider.project(read.lines);
  const limit = normalizeLimit(params.limit);
  const messages = projection.messages.slice(-limit);
  const cursor: WorkerSessionHistoryCursor = {
    path: read.path,
    offset: read.size,
    mtimeMs: read.mtimeMs,
    messageCount: projection.messages.length,
  };
  const degradedReason =
    projection.skippedMalformedLines > 0
      ? `Skipped ${projection.skippedMalformedLines} malformed live transcript line(s).`
      : undefined;

  return {
    snapshot: {
      slotId,
      runId: run.id,
      role,
      contextId,
      runner,
      model,
      runnerSessionId,
      runnerSessionPath: read.path,
      source: 'transcript',
      messages,
      cursor,
      truncated: read.truncated || projection.messages.length > messages.length,
      degradedReason,
      generatedAt: new Date().toISOString(),
    },
  };
}

function deltaFromSnapshot(
  snapshot: WorkerSessionHistorySnapshot,
  reset: boolean,
): WorkerSessionHistoryDeltaPayload {
  return {
    slotId: snapshot.slotId,
    runId: snapshot.runId,
    role: snapshot.role,
    contextId: snapshot.contextId,
    runner: snapshot.runner,
    model: snapshot.model,
    runnerSessionPath: snapshot.runnerSessionPath ?? undefined,
    source: snapshot.source,
    messages: snapshot.messages,
    cursor: snapshot.cursor,
    reset,
    degradedReason: snapshot.degradedReason,
    generatedAt: snapshot.generatedAt,
  };
}

export function workerSessionHistorySubscriptionKey(
  params: WorkerSessionHistoryUnsubscribeParams,
): string {
  return [params.slotId ?? '', params.runId ?? '', params.role ?? '', params.contextId ?? ''].join(
    ':',
  );
}

export async function workerSessionHistorySubscribe(
  params: WorkerSessionHistorySubscribeParams,
  emit: Emit,
): Promise<{
  result: WorkerSessionHistorySubscribeResult;
  unsubscribe: WorkerSessionHistoryUnsubscribe;
}> {
  const initial = await workerSessionHistoryGet(params);
  if (!workerSessionHistoryEnabled()) {
    return {
      result: { ...initial, subscribed: false },
      unsubscribe: () => undefined,
    };
  }

  let lastCursor = initial.snapshot.cursor;
  let knownMessageIds = new Set(initial.snapshot.messages.map((message) => message.id));
  let lastStateKey = historyStateKey(initial.snapshot);
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule() {
    if (closed) return;
    timer = setTimeout(poll, SUBSCRIBE_POLL_MS);
    timer.unref();
  }

  const emitSnapshotDelta = (snapshot: WorkerSessionHistorySnapshot) => {
    const nextCursor = snapshot.cursor;
    const nextStateKey = historyStateKey(snapshot);
    const stateChanged = nextStateKey !== lastStateKey;
    const reset =
      stateChanged ||
      !lastCursor ||
      !nextCursor ||
      lastCursor.path !== nextCursor.path ||
      nextCursor.offset < lastCursor.offset;
    const messages = reset
      ? snapshot.messages
      : snapshot.messages.filter((message) => !knownMessageIds.has(message.id));
    if (messages.length > 0 || stateChanged) {
      emit(Events.WORKER_SESSION_HISTORY_DELTA, {
        ...deltaFromSnapshot(snapshot, reset),
        messages,
      });
    }
    lastCursor = nextCursor;
    lastStateKey = nextStateKey;
    if (reset) knownMessageIds = new Set(snapshot.messages.map((message) => message.id));
    else for (const message of messages) knownMessageIds.add(message.id);
  };

  async function poll() {
    try {
      const { snapshot } = await workerSessionHistoryGet(params);
      if (!closed) emitSnapshotDelta(snapshot);
    } catch (err) {
      console.warn(`[worker-history] subscription poll failed: ${(err as Error).message}`);
      const snapshot = unavailableSnapshot(params, (err as Error).message);
      if (!closed) emitSnapshotDelta(snapshot);
    } finally {
      schedule();
    }
  }

  schedule();

  return {
    result: { ...initial, subscribed: workerSessionHistoryEnabled() },
    unsubscribe: () => {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

function historyStateKey(snapshot: WorkerSessionHistorySnapshot): string {
  return [
    snapshot.slotId ?? '',
    snapshot.runId ?? '',
    snapshot.role ?? '',
    snapshot.contextId ?? '',
    snapshot.runner ?? '',
    snapshot.model ?? '',
    snapshot.runnerSessionPath ?? '',
    snapshot.source,
    snapshot.degradedReason ?? '',
    snapshot.cursor?.path ?? '',
  ].join(':');
}
