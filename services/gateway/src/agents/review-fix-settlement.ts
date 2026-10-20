// agents/review-fix-settlement.ts — a retained review-fix context leaves 'working' once its attempt signalled.

import type { AgentContext, AgentContextStatus, Run } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { getRun } from '../runs/store.js';
import { resolveContextFilePath } from '../tasks/watcher.js';
import { terminalWorkerSignalFromRaw } from '../tasks/worker-signals.js';

import { upsertAgentContext } from './contexts.js';

const ACTIVE_FIX_STATUSES: ReadonlySet<AgentContextStatus> = new Set([
  'launching',
  'working',
  'waiting',
]);

export type ReviewFixSignalReader = (run: Run, context: AgentContext) => Promise<string | null>;

async function readReviewFixSignal(run: Run, context: AgentContext): Promise<string | null> {
  const vars = await loadSlotVars(run.slotId!);
  const signalPath = resolveContextFilePath(
    vars.remoteRepo,
    context.signalFile,
    `${vars.remoteRepo}/${context.signalFile}`,
  );
  const result = await execOnSlot(
    vars,
    `cat ${shellQuote(signalPath)} 2>/dev/null`,
    vars.remoteRepo,
  );
  return result.exitCode === 0 ? result.stdout : null;
}

/**
 * The review loop that delivered a fix marks its context when it consumes the
 * fix signal. A restart or gate replay can drop that loop, and the gate then
 * moves on with the context still 'working' while its worker sits idle
 * (TAT-4145 bda11b1a). Settle a context whose own attempt already signalled a
 * terminal status, the way the loop would have. Never throws.
 */
export async function settleFinishedReviewFixContext(
  runId: string,
  readSignal: ReviewFixSignalReader = readReviewFixSignal,
): Promise<boolean> {
  const run = getRun(runId);
  const context = run?.agentContexts?.find(
    (candidate) =>
      candidate.role === 'review-fix' &&
      ACTIVE_FIX_STATUSES.has(candidate.status) &&
      Boolean(candidate.signalAttemptId && candidate.signalFile),
  );
  if (!run?.slotId || !context) return false;
  try {
    const signal = terminalWorkerSignalFromRaw((await readSignal(run, context)) ?? '');
    if (!signal || signal.attemptId !== context.signalAttemptId) return false;
    const status: AgentContextStatus =
      signal.status === 'blocked' ? 'blocked' : signal.status === 'failed' ? 'failed' : 'complete';
    const settled = await upsertAgentContext(
      runId,
      'review-fix',
      { id: context.id },
      {
        resolvePatch: (current) =>
          current &&
          ACTIVE_FIX_STATUSES.has(current.status) &&
          current.signalAttemptId === signal.attemptId
            ? {
                id: current.id,
                status,
                completedAt: new Date().toISOString(),
                lastSignalAt: signal.timestamp,
              }
            : null,
      },
    );
    return settled !== null;
  } catch (error) {
    console.warn(
      `[agent-contexts] run ${runId.slice(0, 8)} — review-fix context not settled: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
    );
    return false;
  }
}
