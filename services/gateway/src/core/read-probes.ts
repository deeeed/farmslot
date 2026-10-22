import { type ConnectedNode, getNode } from '../fleet/machine-registry.js';
import { NodeExecUnconfirmedError } from '../fleet/node-rpc.js';

import type { SlotVars } from './config.js';
import { execOnSlot, type ExecResult } from './exec.js';

interface ReadProbe {
  promise: Promise<ExecResult>;
  connection: ConnectedNode['ws'] | undefined;
  unconfirmed: boolean;
}

const pending = new Map<string, ReadProbe>();

/** Polling readers share an owned command until its process closeout settles. */
export function readSlotProbe(
  vars: SlotVars,
  command: string,
  scope: string,
  timeout: number,
): Promise<ExecResult> {
  const key = JSON.stringify([vars.machine, vars.remoteRepo, scope, command]);
  const connection = getNode(vars.machine)?.ws;
  const existing = pending.get(key);
  if (existing && (!existing.unconfirmed || existing.connection === connection))
    return existing.promise;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref();
  const entry: ReadProbe = {
    connection,
    unconfirmed: false,
    promise: Promise.resolve().then(async () => {
      try {
        const result = await execOnSlot(vars, command, {
          timeout,
          signal: controller.signal,
          noRetry: true,
        });
        if (result.exitCode !== 0)
          throw new Error(`Read probe did not complete (exit ${result.exitCode})`);
        return result;
      } catch (error) {
        // A lost closeout reply does not prove the old process stopped. Keep
        // readers on that failure until its node connection is replaced.
        entry.unconfirmed = error instanceof NodeExecUnconfirmedError;
        if (error instanceof NodeExecUnconfirmedError) entry.connection = error.executionConnection;
        throw error;
      } finally {
        clearTimeout(timer);
        if (!entry.unconfirmed && pending.get(key) === entry) pending.delete(key);
      }
    }),
  };
  pending.set(key, entry);
  return entry.promise;
}
