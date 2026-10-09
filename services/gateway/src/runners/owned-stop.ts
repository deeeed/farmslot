import type { AgentContextTarget, Run } from '@farmslot/protocol';

import { execOnSlot, loadSlotVars, readSlotRow } from '../core/index.js';
import { shellQuote, tmuxSendTextCommand, tmuxShellSnippet } from '../core/tmux.js';
import { getRun } from '../runs/store.js';

import { getRunnerDefinition, isKnownRunner, runnerPromptSubmitKey } from './registry.js';
import { RUNNER_PARK_GRACEFUL_EXIT_TIMEOUT_MS, stopRunnerForPark } from './session-lifecycle.js';
import { probeRunnerDescendantPid } from './session-process.js';

type SlotVars = Awaited<ReturnType<typeof loadSlotVars>>;

/** Reviewer contexts record their exact `%N` pane in `pane`; only worker contexts set `paneId`. */
export function contextPaneId(target: AgentContextTarget): string | null {
  if (target.paneId) return target.paneId;
  return target.pane && /^%\d+$/.test(target.pane) ? target.pane : null;
}

/** Exit a published run's worker in its exact pane; returns why the exit was not confirmed. */
async function exitPublishedRunWorker(
  vars: SlotVars,
  paneId: string,
  panePid: string,
  runner: string,
  assertOwned: () => Promise<void>,
): Promise<string | null> {
  const exit = isKnownRunner(runner) ? getRunnerDefinition(runner).gracefulExit : null;
  if (!exit) return `runner '${runner}' has no graceful exit capability`;
  await assertOwned();
  const preserved = await execOnSlot(
    vars,
    tmuxShellSnippet(`set-option -p -t ${shellQuote(paneId)} remain-on-exit on`),
    { cwd: '/' },
  );
  if (preserved.exitCode !== 0) return 'the worker pane could not be preserved';
  await assertOwned();
  const sent = await execOnSlot(
    vars,
    tmuxSendTextCommand(paneId, exit.command, {
      enter: true,
      submitKey: runnerPromptSubmitKey(runner),
      submitDelayMs: exit.submitDelayMs,
    }),
    { cwd: '/' },
  );
  if (sent.exitCode !== 0) return `graceful exit was not delivered (exit ${sent.exitCode})`;
  const deadline = Date.now() + RUNNER_PARK_GRACEFUL_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const live = await probeRunnerDescendantPid(vars, panePid, runner);
    if (live.state === 'absent') return null;
    if (live.state === 'unknown') return `runner liveness is unknown (${live.code})`;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return `runner did not exit within ${RUNNER_PARK_GRACEFUL_EXIT_TIMEOUT_MS}ms`;
}

/** Stop this run's exact saved conversations (any of its workers once published); sessions stay. */
export async function stopRunOwnedTmuxWorkers(run: Run): Promise<string | null> {
  const expectedGeneration = run.engineState?.generation;
  const contexts = structuredClone(run.agentContexts ?? []);
  for (const context of contexts) {
    if (context.nativeSession || context.nativeSessionOwner || !context.target) continue;
    const slotId = context.slotId ?? run.slotId;
    const slot = slotId ? await readSlotRow(slotId) : null;
    if (slot && slot.current_run_id !== run.id) continue;
    if (slot?.handoff_run_id && slot.handoff_run_id !== run.id)
      return 'Another native handoff owns this slot reservation; worker cleanup deferred';
    if (!slotId) return `Worker ${context.id} has no slot ownership evidence`;
    const vars = await loadSlotVars(slotId);
    const targetPaneId = contextPaneId(context.target);
    if (!targetPaneId) return `Worker ${context.id} has no exact pane identity; cleanup deferred`;
    const pane = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `display-message -p -t ${shellQuote(targetPaneId)} -F '#{session_name}\t#{pane_id}\t#{pane_pid}'`,
      ),
      { cwd: '/' },
    );
    if (pane.exitCode === 1) continue; // A historical pane that no longer exists owns nothing live.
    if (pane.exitCode !== 0) return `Worker ${context.id} pane inspection failed; cleanup deferred`;
    const [session, paneId, panePid] = pane.stdout.trim().split('\t');
    // Tmux can return exit 0 with empty fields for an absent exact target.
    if (!session && !paneId && !panePid) continue;
    if (session !== context.target.session || paneId !== targetPaneId)
      return `Worker ${context.id} pane ownership changed; cleanup deferred`;
    const live = await probeRunnerDescendantPid(vars, panePid, context.runner ?? undefined);
    if (live.state === 'absent') continue;
    if (live.state === 'unknown')
      return `Worker ${context.id} liveness is unknown; cleanup deferred`;
    const assertOwned = async () => {
      const currentSlot = await readSlotRow(slotId);
      const currentRun = getRun(run.id);
      const current = currentRun?.agentContexts?.find((candidate) => candidate.id === context.id);
      if (
        currentSlot?.current_run_id !== run.id ||
        currentSlot?.slot_epoch !== slot?.slot_epoch ||
        (currentSlot?.handoff_run_id && currentSlot.handoff_run_id !== run.id) ||
        currentRun?.engineState?.generation !== expectedGeneration ||
        !current ||
        current.nativeSession ||
        current.nativeSessionOwner ||
        current.runner !== context.runner ||
        current.runnerSessionId !== context.runnerSessionId ||
        current.runnerSessionPath !== context.runnerSessionPath ||
        JSON.stringify(current.target) !== JSON.stringify(context.target)
      )
        throw new Error(
          `Worker ${context.id} ownership changed before stop; exit was not delivered`,
        );
    };
    if (context.runner && (!context.runnerSessionId || !context.runnerSessionPath)) {
      // Published work lives on its remote branch, so nothing needs this
      // conversation to resume; holding the slot for it only blocks the next run.
      const publication = run.engineState?.publishGate?.publicationStatus;
      if (publication !== 'published_draft' && publication !== 'published_ready')
        return `Worker ${context.id} cannot be stopped without its exact saved conversation identity; cleanup deferred`;
      const failure = await exitPublishedRunWorker(
        vars,
        targetPaneId,
        panePid,
        context.runner,
        assertOwned,
      );
      if (failure) return `Worker ${context.id} stop was not confirmed: ${failure}`;
      continue;
    }
    if (!context.runner || !context.runnerSessionId || !context.runnerSessionPath)
      return `Worker ${context.id} cannot be stopped without its exact saved conversation identity; cleanup deferred`;
    const result = await stopRunnerForPark({
      vars,
      preservePane: true,
      beforeExit: assertOwned,
      recoveryHandle: {
        version: 1,
        runnerId: context.runner,
        contextId: context.id,
        sessionId: context.runnerSessionId,
        sessionPath: context.runnerSessionPath,
        target: { ...context.target, paneId: targetPaneId },
        model: context.model ?? null,
        capturedAt: run.createdAt,
      },
    });
    if (!result.ok) return `Worker ${context.id} stop was not confirmed: ${result.error}`;
  }
  return null;
}
