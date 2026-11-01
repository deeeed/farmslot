import { type ConnectedNode, getNode } from '../fleet/machine-registry.js';
import { NodeExecUnconfirmedError } from '../fleet/node-rpc.js';

import type { SlotVars } from './config.js';
import { execOnSlot, type ExecResult, isLocal } from './exec.js';

interface ReadProbe {
  promise: Promise<ExecResult>;
  connection: ConnectedNode['ws'] | undefined;
  unconfirmed: boolean;
}

const pending = new Map<string, ReadProbe>();
const LOCAL_WORKSPACE_PROBE_CONCURRENCY = 4;
let localWorkspaceProbes = 0;
const localWorkspaceWaiters: Array<() => void> = [];

async function admitLocalWorkspaceProbe(): Promise<() => void> {
  if (localWorkspaceProbes < LOCAL_WORKSPACE_PROBE_CONCURRENCY) localWorkspaceProbes++;
  else await new Promise<void>((resolve) => localWorkspaceWaiters.push(resolve));
  return () => {
    const next = localWorkspaceWaiters.shift();
    if (next) next();
    else localWorkspaceProbes--;
  };
}

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

  const entry: ReadProbe = {
    connection,
    unconfirmed: false,
    promise: Promise.resolve().then(async () => {
      // A fleet read may inspect every local checkout. Admit only a small
      // batch, then start its command budget. Queued readers still share the
      // flight, and recovery/remote reads retain their existing admission.
      const release =
        scope === 'workspace' && isLocal(vars.host, vars.machine)
          ? await admitLocalWorkspaceProbe()
          : undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      timer.unref();
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
        // readers on that failure until the node delivers that result late (its
        // process closed) or its connection is replaced.
        entry.unconfirmed = error instanceof NodeExecUnconfirmedError;
        if (error instanceof NodeExecUnconfirmedError) {
          entry.connection = error.executionConnection;
          void error.closeout.then(() => {
            if (pending.get(key) === entry) pending.delete(key);
          });
        }
        throw error;
      } finally {
        clearTimeout(timer);
        if (!entry.unconfirmed && pending.get(key) === entry) pending.delete(key);
        release?.();
      }
    }),
  };
  pending.set(key, entry);
  return entry.promise;
}
