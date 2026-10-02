import path from 'node:path';

import type { AgentContext } from '@farmslot/protocol';

import { execOnSlot, type loadSlotVars } from '../core/index.js';
import { slotRealpath } from '../core/slot-io.js';
import { shellQuote, tmuxShellSnippet } from '../core/tmux.js';

import {
  listRunnerSessionFiles,
  probeRunnerDescendantPid,
  resolveRunnerSessionIdForPath,
  verifyExactLiveRunnerSessionBinding,
} from './session-process.js';

interface AdoptableTmuxWorker {
  paneId: string;
  runnerSessionId: string;
  runnerSessionPath: string;
}

/** Adoption requires process/argv and runner-owned session evidence, never pane text. */
export async function observeAdoptableTmuxWorker(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  context: AgentContext,
  session: string,
): Promise<AdoptableTmuxWorker> {
  if (!context.runner || !context.runnerSessionId)
    throw new Error('Adoption requires the saved runner conversation identity');
  const listed = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `list-panes -s -t ${shellQuote(`=${session}`)} -F '#{pane_id}\t#{pane_pid}\t#{pane_current_path}'`,
    ),
  );
  if (listed.exitCode !== 0)
    throw new Error(`Tmux adoption target is unavailable: ${listed.stderr}`);
  const repository = await slotRealpath(vars, vars.remoteRepo);
  const paths = context.runnerSessionPath
    ? [context.runnerSessionPath]
    : await listRunnerSessionFiles(vars, context.runner);
  const candidates: AdoptableTmuxWorker[] = [];
  for (const line of listed.stdout.trim().split('\n')) {
    const [paneId, panePid, cwd] = line.split('\t');
    if (!paneId || !panePid || !cwd || (await slotRealpath(vars, cwd)) !== repository) continue;
    const observedProcess = await probeRunnerDescendantPid(vars, panePid, context.runner);
    if (observedProcess.state === 'unknown')
      throw new Error(`Runner ownership is uncertain: ${observedProcess.reason}`);
    if (observedProcess.state !== 'present') continue;
    for (const candidate of paths) {
      if (
        (await resolveRunnerSessionIdForPath(vars, context.runner, candidate)) !==
        context.runnerSessionId
      )
        continue;
      const verified = await verifyExactLiveRunnerSessionBinding(vars, context.runner, {
        paneId,
        slotId: vars.slotId,
        runnerPid: observedProcess.pid,
        expectedSessionId: context.runnerSessionId,
        expectedSessionPath: candidate,
      });
      if (verified.ok)
        candidates.push({
          paneId,
          runnerSessionId: context.runnerSessionId,
          runnerSessionPath: path.posix.normalize(candidate),
        });
    }
  }
  if (candidates.length !== 1)
    throw new Error(
      `Adoption requires one live worker for the saved conversation; found ${candidates.length}`,
    );
  return candidates[0];
}
