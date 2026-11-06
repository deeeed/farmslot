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
import { execOnSlot, isLocal } from '../core/exec.js';
import { getNode } from '../fleet/machine-registry.js';
import { loadFleetStatus } from '../fleet/state.js';
import {
  boundLegacyHistorySnapshot,
  legacySessionAppends,
} from '../resources/legacy-session-appends.js';
import { runnerPersistsSessionFiles } from '../runners/registry.js';
import { readRunnerSessionArchiveLines } from '../runners/session-archive.js';
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

type Emit = (event: string, payload: unknown) => void;

interface SessionFileRead {
  path: string;
  fileIdentity?: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
  lines: string[];
  truncated: boolean;
}

export interface WorkerSessionHistoryUnsubscribe {
  (): void;
  activate?(): void;
}

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
with path.open("rb") as handle:
    import os
    stat = os.fstat(handle.fileno())
    start = max(0, stat.st_size - 2 * 1024 * 1024)
    handle.seek(start)
    data = handle.read(stat.st_size - start)
if start:
    first = data.find(b"\\n") + 1
    if not first:
        raise RuntimeError("Transcript record exceeds initial history budget")
    start += first
    data = data[first:]
end = data.rfind(b"\\n") + 1
lines = data[:end].decode("utf-8", errors="replace").splitlines()
print(json.dumps({
    "path": str(path), "fileIdentity": str(stat.st_dev) + ":" + str(stat.st_ino),
    "exists": True, "size": start + end, "mtimeMs": int(stat.st_mtime * 1000),
    "lines": lines[-max_lines:], "truncated": start > 0 or len(lines) > max_lines,
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
  const explicitContext = Boolean(params.contextId || (params.role && params.role !== 'primary'));
  let runnerSessionPath = ctx?.runnerSessionPath?.trim() || null;
  if (!explicitContext) {
    runnerSessionPath = runnerSessionPath ?? run.metrics.runnerSessionPath ?? null;
  }

  const base = { ...params, slotId, runId: run.id, role, contextId };
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

  const projectLines = (input: {
    lines: string[];
    path: string;
    size: number;
    mtimeMs?: number;
    truncated?: boolean;
    source: 'transcript' | 'transcript-archive';
    fileIdentity?: string;
    degradedReason?: string;
  }): WorkerSessionHistoryGetResult => {
    const projection = provider.project(input.lines);
    const limit = normalizeLimit(params.limit);
    const messages = projection.messages.slice(-limit);
    const malformed =
      projection.skippedMalformedLines > 0
        ? `Skipped ${projection.skippedMalformedLines} malformed transcript line(s).`
        : undefined;
    const cursor: WorkerSessionHistoryCursor = {
      path: input.path,
      fileIdentity: input.fileIdentity,
      offset: input.size,
      mtimeMs: input.mtimeMs,
      messageCount: projection.messages.length,
    };
    return {
      snapshot: boundLegacyHistorySnapshot({
        slotId,
        runId: run.id,
        role,
        contextId,
        runner,
        model,
        runnerSessionId,
        runnerSessionPath: input.path,
        source: input.source,
        messages,
        cursor,
        truncated: Boolean(input.truncated) || projection.messages.length > messages.length,
        degradedReason: [input.degradedReason, malformed].filter(Boolean).join(' ') || undefined,
        generatedAt: new Date().toISOString(),
      }),
    };
  };

  let liveError: string | undefined;
  if (slotId) {
    try {
      if (!runnerSessionPath && !explicitContext) {
        const vars = await loadSlotVars(slotId);
        const binding = await resolveRunnerSessionForRun(run, vars);
        runnerSessionPath = binding?.runnerSessionPath ?? null;
      }
      if (runnerSessionPath) {
        const read = await readSessionFile({
          slotId,
          runner,
          sessionPath: runnerSessionPath,
        });
        if (read.exists) {
          return projectLines({
            lines: read.lines,
            path: read.path,
            fileIdentity: read.fileIdentity,
            size: read.size,
            mtimeMs: read.mtimeMs,
            truncated: read.truncated,
            source: 'transcript',
          });
        }
        liveError = 'Runner transcript file is not available on disk.';
      }
    } catch (err) {
      // Expected after recycle when the slot or live path is gone. Fall through
      // to the run-owned snapshot instead of failing History closed.
      liveError = err instanceof Error ? err.message : String(err);
    }
  }

  try {
    const archived = await readRunnerSessionArchiveLines({ run, contextId });
    if (archived) {
      return projectLines({
        lines: archived.lines,
        path: archived.originalPath,
        size: archived.size,
        truncated: archived.truncated,
        source: 'transcript-archive',
        degradedReason: 'Live transcript is gone; showing the recycle snapshot.',
      });
    }
  } catch (err) {
    const archiveError = err instanceof Error ? err.message : String(err);
    return {
      snapshot: unavailableSnapshot(
        base,
        liveError ? `${liveError} Archive read failed: ${archiveError}` : archiveError,
        {
          runner,
          model,
          runnerSessionId,
          runnerSessionPath,
        },
      ),
    };
  }

  if (!slotId && !runnerSessionPath) {
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

  return {
    snapshot: unavailableSnapshot(
      base,
      liveError ??
        (runnerSessionPath
          ? 'Runner transcript file is not available on disk.'
          : 'No runner transcript path is attached to this run.'),
      {
        runner,
        model,
        runnerSessionId,
        runnerSessionPath,
      },
    ),
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
  let active = false;
  let queued: WorkerSessionHistorySnapshot | undefined;
  let visibleSnapshot = initial.snapshot;
  const emitSnapshotDelta = (snapshot: WorkerSessionHistorySnapshot) => {
    if (closed) return;
    visibleSnapshot = snapshot;
    if (!active) {
      queued = boundLegacyHistorySnapshot(snapshot);
      return;
    }
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
    if (messages.length || stateChanged)
      emit(Events.WORKER_SESSION_HISTORY_DELTA, {
        ...deltaFromSnapshot(snapshot, reset),
        messages,
      });
    lastCursor = nextCursor;
    lastStateKey = nextStateKey;
    knownMessageIds = new Set(snapshot.messages.map((message) => message.id));
  };
  const snapshot = initial.snapshot;
  if (
    snapshot.source !== 'transcript' ||
    !snapshot.slotId ||
    !snapshot.runnerSessionPath ||
    !snapshot.cursor
  ) {
    return { result: { ...initial, subscribed: false }, unsubscribe: () => undefined };
  }
  const vars = await loadSlotVars(snapshot.slotId);
  const node = getNode(vars.machine);
  if (!node && !isLocal(vars.host, vars.machine))
    return {
      result: {
        snapshot: {
          ...snapshot,
          degradedReason: 'Completed-message history. Its node is offline.',
        },
        subscribed: false,
      },
      unsubscribe: () => undefined,
    };
  const current = () => {
    const run = snapshot.runId && getRun(snapshot.runId);
    if (!run) throw new Error('The historical run is no longer available');
    const context = selectAgentContext(run, { contextId: snapshot.contextId, role: snapshot.role });
    const identity = context?.runnerSessionId ?? run.metrics.runnerSessionId;
    if (identity && identity !== snapshot.runnerSessionId)
      throw new Error('Legacy reviewer identity changed; reopen its history');
  };
  const observed = await legacySessionAppends.observe(
    JSON.stringify([vars.machine, snapshot.runId, snapshot.contextId, snapshot.runnerSessionPath]),
    snapshot.runnerSessionPath,
    node,
    async () => {
      current();
      return (await workerSessionHistoryGet(params)).snapshot;
    },
    {
      changed: (next) => {
        try {
          current();
          emitSnapshotDelta(next);
        } catch (error) {
          emitSnapshotDelta({
            ...snapshot,
            source: 'unavailable',
            degradedReason: (error as Error).message,
          });
        }
      },
      failed: (error) =>
        emitSnapshotDelta({
          ...visibleSnapshot,
          source: 'unavailable',
          degradedReason: error.message,
        }),
    },
  );
  const unsubscribe: WorkerSessionHistoryUnsubscribe = () => {
    closed = true;
    queued = undefined;
    observed.stop();
  };
  unsubscribe.activate = () => {
    if (closed) return;
    active = true;
    if (queued) {
      emitSnapshotDelta(queued);
      queued = undefined;
    }
  };
  lastCursor = observed.snapshot.cursor;
  lastStateKey = historyStateKey(observed.snapshot);
  knownMessageIds = new Set(observed.snapshot.messages.map((message) => message.id));
  return { result: { snapshot: observed.snapshot, subscribed: true }, unsubscribe };
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
