import type { ResourceSidecarMeta } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';

/** PID alone is never evidence of provider ownership. */
export async function probeResourceProcess(
  vars: SlotVars,
  pid: number,
): Promise<ResourceSidecarMeta['process']> {
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error('Provider PID is invalid; process ownership is unknown');
  const result = await execOnSlot(vars, `ps -p ${pid} -o pid=,pgid=,lstart=`, { cwd: '/' });
  if (result.exitCode === 1) return undefined; // The provider has already exited.
  if (result.exitCode !== 0) throw new Error('Provider process identity capture failed');
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(result.stdout);
  if (!match) throw new Error('Provider process identity is unreadable');
  return {
    pid: Number(match[1]),
    group: Number(match[2]),
    identity: match[3].trim().replace(/\s+/g, ' '),
  };
}
