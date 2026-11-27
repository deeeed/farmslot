import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  type AgentContext,
  isTerminalRunStatus,
  type NativeSessionReadResult,
} from '@farmslot/protocol';

import { upsertAgentContext } from '../agents/contexts.js';
import { loadProjectVars, type loadSlotVars } from '../core/config.js';
import type { probeWorkerSignalForRun } from '../run-engine/run-monitor.js';
import {
  readNativeWorkerCommandError,
  readNativeWorkerSnapshot,
} from '../runners/native/worker-control.js';
import { resumeNativeWorker } from '../runners/native/worker-recovery.js';
import { getRun, persistRunNow } from '../runs/store.js';
import { checklistMarkerCommand, targetForChecklistBasename } from '../tasks/checklist-target.js';

import { readReviewFeedback } from './feedback.js';
import { withNativeReviewMutation, withNativeReviewOperation } from './native-review-operation.js';
import { reviewContextPolicyRound, reviewContextRoundId } from './review-round-budget.js';
import { ReviewerProgressClock } from './reviewer-progress.js';
import { reviewerFeedbackRelPath } from './template-paths.js';

interface CompletionInput {
  runId: string;
  context: AgentContext;
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  snapshot: NativeSessionReadResult;
  probe: Awaited<ReturnType<typeof probeWorkerSignalForRun>>;
  assertCurrent: () => void;
  /** Restart recovery has no live controller retaining the progress clock. */
  enforceProgressTimeout?: boolean;
}

export class NativeReviewCompletionError extends Error {}

/**
 * A completion turn ended without a valid terminal signal and its result reads PASS. A PASS is
 * not accepted without the terminal mark: that reviewer may have skipped verification, and a
 * PASS satisfies the publish gate. The round settles no-verdict.
 */
export class NativeReviewPassWithoutSignalError extends NativeReviewCompletionError {}

/**
 * Signal states that get the one completion re-ask: the reviewer stopped before its terminal
 * mark (`non_terminal`), or wrote a signal that cannot be read as this attempt's. A `missing`
 * signal is not re-asked: a reviewer may write its mark after its turn ends, and the monitor waits
 * for it. `artifact_contract` is a real gate and `terminal_contract_infrastructure` a gateway-side
 * check that could not run, so neither is re-asked.
 */
const COMPLETION_REASK_CODES = new Set([
  'non_terminal',
  'invalid_json',
  'invalid_schema',
  'stale',
  'context_mismatch',
]);

/** After a re-ask has ended, a signal that is still missing leaves the reviewer's result to decide. */
const RESULT_AFTER_REASK_CODES = new Set([...COMPLETION_REASK_CODES, 'missing']);

/** One durable completion instruction per admitted reviewer, shared by live and restart recovery. */
export async function continueNativeReviewCompletion(
  input: CompletionInput,
): Promise<false | 'continued' | 'deferred' | 'result'> {
  const { runId, vars, snapshot, probe } = input;
  const current = () => {
    input.assertCurrent();
    const run = getRun(runId);
    const context = run?.agentContexts?.find((entry) => entry.id === input.context.id);
    if (
      !run ||
      isTerminalRunStatus(run.status) ||
      run.status === 'paused' ||
      run.slotId !== vars.slotId ||
      !context?.nativeSession ||
      context.runId !== runId ||
      context.slotId !== run.slotId ||
      context.nativeSession.releasedAt ||
      context.taskFile !== input.context.taskFile ||
      context.nativeSession.sessionId !== input.context.nativeSession?.sessionId ||
      context.nativeSession.leaseId !== input.context.nativeSession?.leaseId ||
      context.nativeSession.generation !== input.context.nativeSession?.generation ||
      context.nativeSession.ownerPrincipalId !== input.context.nativeSession?.ownerPrincipalId ||
      context.nativeSession.executionNodeId !== input.context.nativeSession?.executionNodeId ||
      context.role !== 'review'
    )
      throw new Error('Native reviewer completion ownership changed');
    return { run, context };
  };
  let { run, context } = current();
  if (!context.taskFile || !context.reviewResultFile || !context.runnerSessionId) return false;
  // current() pins the task file; these stay valid when `context` is re-read below.
  const { taskFile, reviewResultFile } = context;
  const command = snapshot.commands.find(
    (entry) => entry.commandId === context.nativeSession!.commandId,
  );
  const reserved = context.nativeCommandId;
  const adopted = reserved && context.nativeSession!.commandId === reserved;
  const ended = command?.state === 'completed' || command?.state === 'failed';
  if (adopted && !probe.ok && ended) {
    if (probe.code === 'terminal_contract_infrastructure') {
      // Restart recovery (enforceProgressTimeout) has no poll loop, so it fails closed now
      // rather than ingest a verdict whose contract check never ran. The live monitor reads
      // the probe again on its next poll and fails closed at its inactivity limit.
      if (input.enforceProgressTimeout)
        throw new NativeReviewCompletionError(
          `Native reviewer terminal signal could not be checked after a restart: ${probe.message}`,
        );
      return false;
    }
    const failure =
      command.outcome === 'failed'
        ? await readNativeWorkerCommandError(runId, 'review', context.id)
        : undefined;
    ({ run, context } = current());
    // Only an active reviewer whose round has not settled can still produce its verdict.
    const resultTakeable = (latest: ReturnType<typeof current>) => {
      const roundId = reviewContextRoundId(latest.context);
      const settlement = roundId ? latest.run.reviewRoundSettlements?.[roundId] : undefined;
      return (
        ['launching', 'working', 'waiting'].includes(latest.context.status) &&
        Boolean(roundId) &&
        (!settlement || settlement.kind === 'pending')
      );
    };
    if (
      command.outcome === 'completed' &&
      !['closed', 'failed'].includes(snapshot.session.state) &&
      RESULT_AFTER_REASK_CODES.has(probe.code) &&
      resultTakeable({ run, context })
    ) {
      // 961d55d3: the reviewer wrote a valid result and ended the re-asked turn without its mark.
      const feedback = await readReviewFeedback(
        vars,
        path.posix.dirname(taskFile),
        reviewerFeedbackRelPath(context.id),
        reviewResultFile,
        reviewContextPolicyRound(run, context),
      );
      // A cancel or settlement may have landed during the read.
      const latest = current();
      if (resultTakeable(latest) && !feedback.incomplete && !feedback.terminalInvalidReason) {
        if (feedback.verdict !== 'issues')
          throw new NativeReviewPassWithoutSignalError(
            `Native reviewer completion turn ended without a valid terminal signal (${probe.code}); its PASS result is not accepted without one`,
          );
        console.warn(
          `[review] ${runId.slice(0, 8)}: reviewer ${context.id}: no valid terminal signal (${probe.code}) after the completion re-ask; accepting its valid ISSUES result as the verdict`,
        );
        return 'result';
      }
    }
    throw new NativeReviewCompletionError(
      failure?.message ?? 'Native reviewer completion turn ended without a valid terminal signal',
      { cause: failure },
    );
  }
  if (reserved && !probe.ok && input.enforceProgressTimeout) {
    const project = await loadProjectVars(vars.projectName);
    const timeout = (project.projectJson.review?.review_inactivity_timeout_min ?? 10) * 60_000;
    const acceptedAt = Date.parse(context.nativeSession!.acceptedAt ?? '');
    if (!Number.isFinite(acceptedAt))
      throw new NativeReviewCompletionError(
        'Native reviewer completion has no valid progress clock',
      );
    // The same progress rules as the live monitor: tools and marks; an open tool gets longer.
    const progress = new ReviewerProgressClock(acceptedAt, timeout);
    for (const event of probe.code === 'non_terminal'
      ? (probe.signal?.checklistTiming?.events ?? [])
      : [])
      progress.record(event.checkedAt);
    // Only the whole history can say the reviewer is idle: a later page may close an open tool,
    // which shortens its limit again.
    if (progress.expired()) {
      for (let page = snapshot; ; ) {
        for (const event of page.events) {
          if (
            event.sessionId === context.nativeSession!.sessionId &&
            event.commandId === context.nativeSession!.commandId &&
            event.generation === context.nativeSession!.generation
          ) {
            if (event.type === 'command.accepted') progress.record(event.at);
            else progress.observe(event);
          }
        }
        if (!page.hasMore) break;
        page = await readNativeWorkerSnapshot(runId, 'review', context.id, {
          after: page.cursor,
          limit: 500,
        });
        current();
      }
      if (progress.expired())
        throw new NativeReviewCompletionError(
          progress.toolOpen
            ? 'Native reviewer completion turn exceeded its open-tool limit'
            : 'Native reviewer completion turn exceeded its checklist/tool inactivity limit',
        );
    }
  }
  if (adopted) return false;
  if (
    !reserved &&
    (!['launching', 'working', 'waiting'].includes(context.status) ||
      probe.ok ||
      !COMPLETION_REASK_CODES.has(probe.code) ||
      !ended ||
      !command.accepted ||
      command.outcome === 'interrupted' ||
      snapshot.pendingRequests.length ||
      !(
        (snapshot.session.state === 'idle' && !snapshot.session.processStopped) ||
        (['closed', 'failed'].includes(snapshot.session.state) && snapshot.session.processStopped)
      ))
  )
    return false;
  const taskDir = path.posix.dirname(context.taskFile);
  const feedback = await readReviewFeedback(
    vars,
    taskDir,
    reviewerFeedbackRelPath(context.id),
    context.reviewResultFile,
    reviewContextPolicyRound(run, context),
  );
  current();
  // Only valid findings qualify. Invalid nonterminal artifacts retain the
  // monitor's existing exit or inactivity settlement.
  if (feedback.incomplete || feedback.terminalInvalidReason) return false;
  if (!reserved) {
    const target = targetForChecklistBasename(path.posix.basename(context.taskFile));
    const mark = checklistMarkerCommand(taskDir, target);
    const text =
      `Continue this exact reviewer task in ${context.taskFile}. Preserve the existing findings, report and completed checklist steps. ` +
      `Finish its remaining checklist and run ${mark} complete. ` +
      'Do not run start, reset the checklist, rerun the diff or start /review. Return the required review output schema after the terminal mark.';
    await withNativeReviewOperation(run, () =>
      withNativeReviewMutation(async () => {
        current();
        await upsertAgentContext(
          runId,
          'review',
          { id: context.id },
          {
            resolvePatch: (latest) => {
              current();
              return latest?.nativeCommandId
                ? null
                : { nativeCommandId: randomUUID(), nativeCommandText: text };
            },
            mirrorIf: (slot) => slot.current_run_id === runId,
          },
        );
        await persistRunNow(getRun(runId)!, 'native reviewer completion instruction reserved');
      }),
    );
  }
  ({ run, context } = current());
  if (!context.nativeCommandId || !context.nativeCommandText)
    throw new Error('Native reviewer completion reservation is unavailable');
  await resumeNativeWorker(runId, {
    purpose: 'review',
    contextId: context.id,
    commandId: context.nativeCommandId,
    text: context.nativeCommandText,
    assertCurrent: input.assertCurrent,
  });
  const resumed = getRun(runId)?.agentContexts?.find((entry) => entry.id === context.id);
  return resumed?.nativeSession?.commandId === context.nativeCommandId ? 'continued' : 'deferred';
}
