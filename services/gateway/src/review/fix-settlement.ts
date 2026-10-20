// review/fix-settlement.ts — a retained review-fix context leaves 'working' once its attempt signalled.

import type { AgentContext, AgentContextStatus, Run, WorkerSignal } from '@farmslot/protocol';

import { fixContextStatusForSignal, upsertAgentContext } from '../agents/contexts.js';
import { loadSlotVars } from '../core/config.js';
import { getRun } from '../runs/store.js';
import { resolveContextFilePath } from '../tasks/watcher.js';
import { terminalWorkerSignalFromRaw } from '../tasks/worker-signals.js';

import { readOptionalSlotFile } from './snapshots.js';

const ACTIVE_FIX_STATUSES: ReadonlySet<AgentContextStatus> = new Set([
  'launching',
  'working',
  'waiting',
]);

export type ReviewFixSignalReader = (run: Run, context: AgentContext) => Promise<string>;

async function readReviewFixSignal(run: Run, context: AgentContext): Promise<string> {
  const vars = await loadSlotVars(run.slotId!);
  return readOptionalSlotFile(
    vars,
    resolveContextFilePath(
      vars.remoteRepo,
      context.signalFile,
      `${vars.remoteRepo}/${context.signalFile}`,
    ),
  );
}

/**
 * The review loop that delivered a fix marks its context when it consumes the
 * fix signal. A restart or gate replay can drop that loop, and the gate then
 * moves on with the context still 'working' while its worker sits idle
 * (TAT-4145 bda11b1a). Settle a context whose own attempt already signalled a
 * terminal status, the way the loop would have, unless `adoptable` says a later
 * resume still adopts it: that resume consumes the signal itself.
 */
export async function settleFinishedReviewFixContext(
  runId: string,
  options: {
    readSignal?: ReviewFixSignalReader;
    adoptable?: (context: AgentContext) => Promise<boolean>;
  } = {},
): Promise<boolean> {
  const run = getRun(runId);
  const context = run?.agentContexts?.find(
    (candidate) =>
      candidate.role === 'review-fix' &&
      ACTIVE_FIX_STATUSES.has(candidate.status) &&
      Boolean(candidate.signalAttemptId && candidate.signalFile),
  );
  if (!run?.slotId || !context || (await options.adoptable?.(context))) return false;
  let signal: WorkerSignal | undefined;
  try {
    signal = terminalWorkerSignalFromRaw(
      await (options.readSignal ?? readReviewFixSignal)(run, context),
    );
  } catch (error) {
    // An offline node or a half-written signal proves nothing: the context keeps
    // its status, and the next gate presentation reads the signal again.
    console.warn(
      `[review] run ${runId.slice(0, 8)} — review-fix signal unreadable, context left as is: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
    );
    return false;
  }
  if (!signal || signal.attemptId !== context.signalAttemptId) return false;
  const finished = signal;
  const settled = await upsertAgentContext(
    runId,
    'review-fix',
    { id: context.id },
    {
      resolvePatch: (current) =>
        current &&
        ACTIVE_FIX_STATUSES.has(current.status) &&
        current.signalAttemptId === finished.attemptId
          ? {
              id: current.id,
              status: fixContextStatusForSignal(finished.status),
              completedAt: new Date().toISOString(),
              lastSignalAt: finished.timestamp,
            }
          : null,
    },
  );
  return settled !== null;
}
