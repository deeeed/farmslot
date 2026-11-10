import { createHash } from 'node:crypto';
import path from 'node:path';

import { runnerRuntimeDir } from '../../../../scripts/lib/runner-runtime.cjs';
import { farmPathsForSlot } from '../fleet/farm-paths.js';
import { usesNodeLink } from '../fleet/node-link-policy.js';

import type { SlotVars } from './config.js';
import { isLocal } from './exec.js';
import { currentSlotCommandExecutor } from './exec-scope.js';
import { commandIncludesRemotePath, shellExpressionForRemotePath } from './remote-paths.js';
import { slotMkdir, slotWriteFileAtomic } from './slot-io.js';

/** Keep launch bytes out of tmux's size-limited client command transport. */
export async function writeTmuxLaunchScript(
  vars: SlotVars,
  target: string,
  command: string,
): Promise<string> {
  // execOnSlot can no longer see farm references hidden inside the file.
  // Preserve its remote support selection before publishing the launch bytes;
  // owned executors already supply their complete execution contract.
  if (
    !currentSlotCommandExecutor() &&
    (!isLocal(vars.host, vars.machine) || usesNodeLink(vars.machine)) &&
    commandIncludesRemotePath(command, farmPathsForSlot(vars).code.node)
  ) {
    const { resolveRemoteFarmCommand } = await import('../node-support/remote-command.js');
    command = await resolveRemoteFarmCommand(vars, command);
  }
  // Transport files belong to the slot's default runtime, independent of task
  // evidence or project runtime overrides. Hash exact window/pane targets so
  // role names cannot escape the directory or collide after sanitization.
  const dir = path.posix.join(runnerRuntimeDir(vars.remoteRepo), '.launch');
  const file = path.posix.join(dir, `${createHash('sha256').update(target).digest('hex')}.sh`);
  await slotMkdir(vars, dir);
  await slotWriteFileAtomic(vars, file, `#!/bin/bash\n${command}\n`, { mode: 0o600 });
  return `bash ${shellExpressionForRemotePath(file)}`;
}
