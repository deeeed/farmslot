// Live spend of the agent session a task.progress read shows: tokens, cost, compactions and tool
// calls so far, overall and per checklist step. It rides on task.progress: no RPC, poll, process
// or Git call of its own. Each session's transcript is read from the byte offset where the last
// read stopped, at most once every 15 s however many viewers poll, one node request a read.
import {
  type ChecklistMark,
  createLiveToolUsage,
  type LiveToolUsage,
  type LiveUsageSummary,
} from '@farmslot/agent-runtime/tool-usage';
import {
  type AgentContext,
  FILE_TRANSFER_CHUNK_MAX_BYTES,
  type Run,
  type TaskLiveSpend,
} from '@farmslot/protocol';

import { type SlotLocality, slotReadRange } from '../core/slot-io.js';
import { contextChecklistMarks } from '../runtime/session-usage.js';

/** One agent session's transcript, and the checklist marks its steps end at. */
export interface LiveSpendSource {
  key: string;
  runner: string;
  path: string;
  marks: ChecklistMark[];
  /** Accounting window start: a reused conversation's earlier records belong to an earlier run. */
  since?: number;
}

/** The viewed context's source; undefined when it names no runner session. */
export function liveSpendSource(
  run: Run,
  context: AgentContext | null | undefined,
): LiveSpendSource | undefined {
  const path = context?.runnerSessionPath;
  const runner = context?.runner;
  if (!context || !path || !runner) return undefined;
  // The same window the session receipt counts in: this attempt of this context.
  const started = Date.parse(context.attemptStartedAt ?? context.startedAt ?? '');
  const since = Number.isFinite(started) ? started : undefined;
  return {
    key: `${run.id}\u0000${context.id}\u0000${since ?? ''}\u0000${path}`,
    runner,
    path,
    marks: contextChecklistMarks(run, context),
    ...(since !== undefined ? { since } : {}),
  };
}

export const LIVE_SPEND_READ_INTERVAL_MS = 15_000;
/** Chunks one read may take while catching up (a restart, a long transcript): 8 x 512 KB. */
const MAX_CHUNKS_PER_READ = 8;
/** Consecutive failed reads after which the reader starts again from byte 0 (a truncated file). */
const RESTART_AFTER_FAILURES = 2;
/** Readers kept; the oldest goes first. Each holds only its open step's events. */
const MAX_SESSIONS = 64;

interface Session {
  live: LiveToolUsage;
  readAt: number;
  reading?: Promise<void>;
  marksKey?: string;
  summary?: LiveUsageSummary;
  unavailable?: string;
  /** Transcript bytes not read yet: the numbers are partial until a later read catches up. */
  behindBytes?: number;
  failures: number;
}

const sessions = new Map<string, Session>();

/** For tests: forget every reader. */
export function resetLiveSpend(): void {
  sessions.clear();
}

async function readTail(io: SlotLocality, path: string, session: Session): Promise<void> {
  const { live } = session;
  for (let chunk = 0; chunk < MAX_CHUNKS_PER_READ; chunk++) {
    const range = await slotReadRange(io, path, live.offset, FILE_TRANSFER_CHUNK_MAX_BYTES);
    // A rotated or shorter transcript is another file: count it again from its start.
    if (
      (live.fileIdentity !== undefined && range.fileIdentity !== live.fileIdentity) ||
      range.size < live.offset
    ) {
      live.reset(range.fileIdentity);
      session.summary = undefined;
      continue;
    }
    live.fileIdentity = range.fileIdentity;
    if (range.bytes.length) {
      live.append(range.bytes);
      session.summary = undefined;
    }
    session.behindBytes = Math.max(0, range.size - live.offset);
    if (!session.behindBytes || !range.bytes.length) return;
  }
}

function spend(session: Session, readAt: number): TaskLiveSpend {
  const summary = session.summary;
  return {
    runner: session.live.runner,
    readAt: new Date(readAt).toISOString(),
    totalTokens: summary?.totalTokens ?? null,
    costUsd: summary?.costUsd ?? null,
    compactions: summary?.compactions ?? null,
    toolCalls: summary?.toolCalls ?? 0,
    steps: summary?.steps ?? [],
    ...(session.unavailable ? { unavailable: session.unavailable } : {}),
    ...(session.behindBytes ? { behindBytes: session.behindBytes } : {}),
  };
}

/** The session's spend so far. */
export async function liveSpendFor(
  io: SlotLocality,
  { key, runner, path, marks, since }: LiveSpendSource,
  now = Date.now(),
): Promise<TaskLiveSpend> {
  let session = sessions.get(key);
  if (!session) {
    const live = createLiveToolUsage(runner, since);
    if (!live)
      return {
        runner,
        readAt: new Date(now).toISOString(),
        totalTokens: null,
        costUsd: null,
        compactions: null,
        toolCalls: 0,
        steps: [],
        unavailable: `${runner} sessions are not one appendable transcript; spend arrives with the session receipt`,
      };
    session = { live, readAt: -Infinity, failures: 0 };
    sessions.set(key, session);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  } else {
    // Most recently read last, so eviction drops the reader nobody views.
    sessions.delete(key);
    sessions.set(key, session);
  }
  if (!session.reading && now - session.readAt >= LIVE_SPEND_READ_INTERVAL_MS) {
    session.readAt = now;
    const active = session;
    session.reading = readTail(io, path, active)
      .then(
        () => {
          active.unavailable = undefined;
          active.failures = 0;
        },
        (error: unknown) => {
          // The worker may not have written its first record yet; any other failure is shown
          // on the progress read instead of failing it, and the next read tries again. A node
          // refuses an offset past a truncated file's end without saying so: after repeated
          // failures the reader starts again from byte 0.
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code !== 'ENOENT' && ++active.failures >= RESTART_AFTER_FAILURES) {
            active.live.reset();
            active.summary = undefined;
            active.failures = 0;
          }
          active.unavailable =
            code === 'ENOENT'
              ? 'The session transcript is not written yet'
              : `The session transcript could not be read: ${(error as Error).message}`;
        },
      )
      .finally(() => {
        active.reading = undefined;
      });
  }
  await session.reading;
  const marksKey = JSON.stringify(marks.map((mark) => mark.checkedAt));
  if (!session.summary || session.marksKey !== marksKey) {
    session.summary = session.live.summary(marks);
    session.marksKey = marksKey;
  }
  return spend(session, session.readAt);
}
