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
  const census = async () => {
    const listed = await readers.exec(
      vars,
      tmuxShellSnippet("list-panes -a -F '#{session_name}\t#{pane_id}\t#{pane_pid}'"),
      { timeout: 10_000 },
    );
    if (listed.exitCode !== 0 || !listed.stdout.trim())
      return { reason: 'Worker pane inventory is unavailable' };
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
      return { reason: 'Worker pane inventory is incomplete' };
    return { panes };
  };
  const listed = await census();
  if (!listed.panes) return { state: 'unknown', reason: listed.reason };
  const panes = listed.panes;
  // The recorded pane outlives a runner that exited: the role shell stays. Only a live runner
  // there is unconfirmed progress; with it gone, a replacement is looked for as for a gone pane.
  const recorded = panes.find(({ paneId }) => paneId === target.paneId);
  let resumed: string | undefined;
  for (const pane of panes.filter(
    ({ session, paneId }) => session === target.session || paneId === target.paneId,
  )) {
    const process = await readers.probe(vars, pane.panePid!, runner, { timeout: 10_000 });
    if (process.state === 'unknown')
      return { state: 'unknown', reason: process.reason ?? 'Worker process probe is unavailable' };
    if (process.state === 'absent') continue;
    if (pane === recorded)
      return {
        state: 'unknown',
        reason: 'Recorded worker pane still runs its runner; progress is unconfirmed',
      };
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
  if (recorded) {
    // A session reload respawns the pane in place under a new process, which the probe of the
    // old one cannot see. The exit counts only while the pane still runs the process probed.
    const again = await census();
    if (again.panes?.find(({ paneId }) => paneId === target.paneId)?.panePid !== recorded.panePid)
      return {
        state: 'unknown',
        reason: again.reason ?? 'Recorded worker pane was respawned during the check',
      };
  }
  return resumed ? { state: 'present', target: resumed } : { state: 'absent' };
}
