/**
 * One command, on the machine a slot lives on.
 *
 * Split out of `resource-manager.ts` so the device inventory can reuse the same
 * routing without importing the manager itself — the manager now depends on the
 * inventory for its post-control device-state check, and a cycle between the two
 * would be resolved by module order rather than by design.
 */
import { execLocal } from '../core/exec.js';

import { getNode } from './machine-registry.js';
import { getSlotLocality, sendNodeRequest } from './node-rpc.js';

export interface ResourceCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The one command-running seam, so every reader of it is testable without a host. */
export type ResourceCommandExec = (
  slotId: string,
  cwd: string,
  cmd: string,
  timeout: number,
) => Promise<ResourceCommandResult>;

export async function execResourceCommand(
  slotId: string,
  cwd: string,
  cmd: string,
  timeout: number,
): Promise<ResourceCommandResult> {
  const { isLocal, machine } = await getSlotLocality(slotId);
  if (!isLocal) {
    const node = getNode(machine);
    if (node) {
      try {
        return (await sendNodeRequest(node, 'exec', {
          cmd,
          cwd,
          timeout,
        })) as ResourceCommandResult;
      } catch (err) {
        return { stdout: '', stderr: (err as Error).message, exitCode: 1 };
      }
    }
    // No node — fall through to local exec, matching the legacy health path.
  }

  return execLocal(cmd, { cwd, timeout });
}
