import type { AgentContext } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { tmuxShellSnippet } from '../core/tmux.js';

import {
  probeRunnerDescendantPid,
  verifyExactLiveRunnerSessionBinding,
} from './session-process.js';

export type RetainedWorkerProgressTarget =
  | { state: 'absent' }
  | { state: 'present'; target: string }
  | { state: 'unknown'; reason: string };

interface RetainedWorkerProgressReaders {
  exec: typeof execOnSlot;
  probe: typeof probeRunnerDescendantPid;
  binding: typeof verifyExactLiveRunnerSessionBinding;
}

/** A missing pane is not a busy turn; a resumed worker must prove its saved conversation. */
export async function readRetainedWorkerProgressTarget(
  vars: SlotVars,
  context: AgentContext,
  readers: RetainedWorkerProgressReaders = {
    exec: execOnSlot,
    probe: probeRunnerDescendantPid,
    binding: verifyExactLiveRunnerSessionBinding,
  },
): Promise<RetainedWorkerProgressTarget> {
  const target = context.target;
  const runner = context.runner;
  const sessionId = context.runnerSessionId;
  const sessionPath = context.runnerSessionPath;
  if (!target?.paneId || !runner)
    return { state: 'unknown', reason: 'Recorded worker pane identity is incomplete' };
  const listed = await readers.exec(
    vars,
    tmuxShellSnippet("list-panes -a -F '#{session_name}\t#{pane_id}\t#{pane_pid}'"),
    { timeout: 10_000 },
  );
  if (listed.exitCode !== 0 || !listed.stdout.trim())
    return { state: 'unknown', reason: 'Worker pane inventory is unavailable' };
  const panes = listed.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [session, paneId, panePid] = line.split('\t');
      return { session, paneId, panePid };
    });
  if (
    panes.some(
      ({ session, paneId, panePid }) =>
        !session || !/^%\d+$/.test(paneId ?? '') || !/^\d+$/.test(panePid ?? ''),
    )
  )
    return { state: 'unknown', reason: 'Worker pane inventory is incomplete' };
  // The recorded pane outlives a runner that exited: the role shell stays. Only a live runner
  // there is unconfirmed progress; with it gone, a replacement is looked for as for a gone pane.
  const recorded = panes.find(({ paneId }) => paneId === target.paneId);
  if (recorded) {
    const process = await readers.probe(vars, recorded.panePid!, runner, { timeout: 10_000 });
    if (process.state !== 'absent')
      return {
        state: 'unknown',
        reason:
          process.state === 'unknown'
            ? (process.reason ?? 'Worker process probe is unavailable')
            : 'Recorded worker pane still runs its runner; progress is unconfirmed',
      };
  }
  let resumed: string | undefined;
  for (const pane of panes.filter(
    ({ session, paneId }) => session === target.session && paneId !== recorded?.paneId,
  )) {
    const process = await readers.probe(vars, pane.panePid!, runner, { timeout: 10_000 });
    if (process.state === 'unknown')
      return { state: 'unknown', reason: process.reason ?? 'Worker process probe is unavailable' };
    if (process.state === 'absent') continue;
    // Only a live replacement needs the saved conversation; absence does not.
    const binding =
      sessionId && sessionPath
        ? await readers.binding(vars, runner, {
            paneId: pane.paneId!,
            runnerPid: process.pid,
            slotId: vars.slotId,
            expectedSessionId: sessionId,
            expectedSessionPath: sessionPath,
          })
        : undefined;
    if (!binding?.ok || resumed)
      return {
        state: 'unknown',
        reason: 'Replacement worker conversation is unconfirmed or ambiguous',
      };
    resumed = pane.paneId;
  }
  return resumed ? { state: 'present', target: resumed } : { state: 'absent' };
}
