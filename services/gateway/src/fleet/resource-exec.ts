/**
 * One command, on the machine a slot lives on.
 *
 * Split out of `resource-manager.ts` so the device inventory can reuse the same
 * routing without importing the manager itself — the manager now depends on the
 * inventory for its post-control device-state check, and a cycle between the two
 * would be resolved by module order rather than by design.
 */
import { execLocal } from '../core/exec.js';
import { ResourceCommandUnavailableError } from '../core/resource-command-error.js';

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
      const startedAt = Date.now();
      let remoteCmd = cmd;
      if (cmd.includes('~/farmslot-node')) {
        // Resource hooks call farm scripts too; run them from the bundle that
        // matches this config, not the node's last deploy (ledger F15). A
        // delivery still pending or failed means the command could not run:
        // unavailable, never a failed probe, which shutdown would read as
        // "already stopped" and skip its hook. Imported on demand so this
        // module's many importers (device inventory, cleanup, pressure) do not
        // load the node-support graph for commands that never need it.
        const { resolveSlotFarmCommand } = await import('../node-support/remote-command.js');
        try {
          remoteCmd = await resolveSlotFarmCommand(slotId, cmd, timeout);
        } catch (err) {
          throw new ResourceCommandUnavailableError(
            `Resource command unavailable on ${machine}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
      }
      try {
        return (await sendNodeRequest(node, 'exec', {
          cmd: remoteCmd,
          cwd,
          timeout: Math.max(1, timeout - (Date.now() - startedAt)),
        })) as ResourceCommandResult;
      } catch (err) {
        throw new ResourceCommandUnavailableError(
          `Resource command unavailable on ${machine}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
    throw new ResourceCommandUnavailableError(`Resource node ${machine} is disconnected`);
  }

  return execLocal(cmd, { cwd, timeout });
}
