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
import { readNativeWorkerSnapshot } from '../runners/native/worker-control.js';
import { resumeNativeWorker } from '../runners/native/worker-recovery.js';
import { getRun, persistRunNow } from '../runs/store.js';
import { checklistMarkerCommand, targetForChecklistBasename } from '../tasks/checklist-target.js';

import { readReviewFeedback } from './feedback.js';
import { withNativeReviewMutation, withNativeReviewOperation } from './native-review-operation.js';
import { TerminalReviewArtifactError } from './terminal-result.js';

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

/** One durable completion instruction per admitted reviewer, shared by live and restart recovery. */
export async function continueNativeReviewCompletion(input: CompletionInput): Promise<boolean> {
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
  const command = snapshot.commands.find(
    (entry) => entry.commandId === context.nativeSession!.commandId,
  );
  const reserved = context.nativeCommandId;
  const adopted = reserved && context.nativeSession!.commandId === reserved;
  const ended = command?.state === 'completed' || command?.state === 'failed';
  if (adopted) {
    if (!probe.ok && ended && command.outcome !== 'interrupted')
      throw new NativeReviewCompletionError(
        'Native reviewer completion turn ended without a valid terminal signal',
      );
    if (!probe.ok && input.enforceProgressTimeout) {
      const project = await loadProjectVars(vars.projectName);
      const timeout = (project.projectJson.review?.review_inactivity_timeout_min ?? 10) * 60_000;
      const acceptedAt = Date.parse(context.nativeSession!.acceptedAt ?? '');
      if (!Number.isFinite(acceptedAt))
        throw new NativeReviewCompletionError(
          'Native reviewer completion has no valid progress clock',
        );
      let latest = acceptedAt;
      const recordProgress = (at: string) => {
        const value = Date.parse(at);
        if (Number.isFinite(value) && value >= acceptedAt)
          latest = Math.max(latest, Math.min(Date.now(), value));
      };
      for (const event of probe.code === 'non_terminal'
        ? (probe.signal?.checklistTiming?.events ?? [])
        : [])
        recordProgress(event.checkedAt);
      let page = snapshot;
      while (Number.isFinite(latest) && Date.now() - latest >= timeout) {
        for (const event of page.events) {
          if (
            event.sessionId === context.nativeSession!.sessionId &&
            event.commandId === reserved &&
            event.generation === context.nativeSession!.generation &&
            ['command.accepted', 'tool.started', 'tool.completed'].includes(event.type)
          )
            recordProgress(event.at);
        }
        if (Date.now() - latest < timeout) break;
        if (!page.hasMore)
          throw new NativeReviewCompletionError(
            'Native reviewer completion turn exceeded its checklist/tool inactivity limit',
          );
        page = await readNativeWorkerSnapshot(runId, 'review', context.id, {
          after: page.cursor,
          limit: 500,
        });
        current();
      }
    }
    return false;
  }
  if (
    !reserved &&
    (!['launching', 'working', 'waiting'].includes(context.status) ||
      probe.ok ||
      probe.code !== 'non_terminal' ||
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
    `artifacts/review-feedback.${context.id}.md`,
    context.reviewResultFile,
  );
  current();
  if (feedback.incomplete || feedback.terminalInvalidReason)
    throw new TerminalReviewArtifactError(
      feedback.terminalInvalidReason ??
        'Native reviewer completion requires valid review artifacts',
    );
  if (!reserved) {
    const target = targetForChecklistBasename(path.posix.basename(context.taskFile));
    const text =
      `Continue this exact reviewer task in ${context.taskFile}. Preserve the existing findings, report and completed checklist steps. ` +
      `Finish its remaining checklist and run ${checklistMarkerCommand(taskDir, target)} complete. ` +
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
  return true;
}
