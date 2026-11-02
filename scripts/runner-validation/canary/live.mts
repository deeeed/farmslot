// Canary cases against the deployed gateway: per canary node, a native round trip and one
// scripted lifecycle run on that node's canary slot; on one node, the F324 replay. Only runs the
// canary creates are touched: each is pinned to a canary slot, in the canary project, tagged.
import path from 'node:path';

import { GatewayClient, type GatewayConnection } from '../../../packages/cli/src/gateway-client.js';
import { loadProfiles, profileCredential } from '../../../packages/cli/src/gateway-profiles.js';

import { CANARY_PROJECT } from './fixtures.mjs';
import { type CheckResult, failureText } from './outcome.mjs';
import {
  canaryShape,
  driveRun,
  f324Shape,
  Inconclusive,
  judgeLifecycle,
  nativeCheck,
  retire,
} from './run-driver.mjs';

export interface LiveOptions {
  /** FARMSLOT_HOME holding the profile store, and the profile name (`farm-automation`). */
  profileHome: string;
  profile: string;
  nodes: Array<{ machine: string; slot: string }>;
  lifecycle: boolean;
  nativeCheck: boolean;
  /** The node that also runs the F324 case. */
  f324Node?: string;
  budgetsS: Record<string, number>;
  evidence: string;
  log: (event: string, detail?: Record<string, unknown>) => Promise<void>;
  onCheck: (check: CheckResult) => void;
  /** Given what cancels the runs in flight and closes the connection; returns what went wrong. */
  onStop?: (stop: () => Promise<string[]>) => void;
}

export async function connectProfile(home: string, name: string): Promise<GatewayConnection> {
  const profile = loadProfiles(path.join(home, 'gateways.json')).gateways[name];
  if (!profile) throw new Error(`No gateway profile ${name} in ${home}/gateways.json`);
  return new GatewayClient({
    url: profile.url,
    timeout: 30_000,
    credential: profileCredential(profile) ?? null,
  }).connect();
}

export async function runLive(options: LiveOptions): Promise<void> {
  const { log } = options;
  const connection = await connectProfile(options.profileHome, options.profile);
  const call = <T,>(method: string, params?: unknown) => connection.call<T>(method, params);
  const inFlight = new Set<string>();
  const stop = async () => {
    const errors: string[] = [];
    for (const runId of inFlight) {
      const error = await retire(call, runId).catch((cause: unknown) => String(cause));
      if (error) errors.push(`canary run ${runId} is still active: ${error}`);
    }
    inFlight.clear();
    connection.close();
    return errors;
  };
  // The connection stays open for `stop`, which the caller runs on every exit path.
  options.onStop?.(stop);
  // Setup applied? Every canary slot must be in the fleet before anything is dispatched.
  const { fleet } = await call<{ fleet: { slots: Array<{ slot: string; lifecycle: string }> } }>(
    'fleet.status',
  );
  const missing = options.nodes.filter(
    (node) => !fleet.slots.some((slot) => slot.slot === node.slot),
  );
  if (missing.length)
    throw new Error(
      `Canary slots missing from the live fleet: ${missing.map((node) => node.slot).join(', ')}. Apply the canary setup first.`,
    );
  for (const node of options.nodes) {
    if (options.nativeCheck)
      options.onCheck(await nativeCheck(call, node.machine, options.budgetsS, 'live'));
    if (options.lifecycle) options.onCheck(await lifecycle(node, 'lifecycle'));
    if (node.machine === options.f324Node)
      options.onCheck(await lifecycle(node, 'f324-replay-open-gate'));
  }

  /** One scripted canary run on the node's slot, driven to its end. */
  async function lifecycle(
    node: { machine: string; slot: string },
    kind: 'lifecycle' | 'f324-replay-open-gate',
  ): Promise<CheckResult> {
    const label = `${kind}-${node.machine}`;
    const base = {
      case: kind,
      variant: node.machine,
      target: 'live' as const,
      model: 'scripted',
      modelCalls: 0,
    };
    try {
      const result = await driveRun({
        call,
        log,
        label,
        dir: path.join(options.evidence, label),
        slotId: node.slot,
        shape: (kind === 'lifecycle' ? canaryShape : f324Shape)(label),
        hooks: {
          onCreated: (runId) => {
            inFlight.add(runId);
          },
          pollMs: () => 1000,
        },
      });
      // Never leave a canary run holding its slot.
      const unretired = await retire(call, result.runId);
      if (!unretired) inFlight.delete(result.runId);
      const judged = judgeLifecycle(kind, result, options.budgetsS);
      const differences = [
        ...(result.run.project === CANARY_PROJECT && result.run.slotId === node.slot
          ? []
          : [`the run was not pinned to ${node.slot} in ${CANARY_PROJECT}`]),
        ...(unretired ? [`cancelling the unfinished canary run failed: ${unretired}`] : []),
        ...judged.differences,
      ];
      return {
        ...base,
        ...judged,
        status: differences.length ? 'fail' : 'pass',
        differences,
        runId: result.runId,
        durationS: result.durationS,
        observed: result.outcome,
        timingsS: result.timingsS,
        failureText: failureText(result.run),
        evidence: result.evidence,
      };
    } catch (error) {
      if (!(error instanceof Inconclusive)) throw error;
      const unretired = error.runId && (await retire(call, error.runId));
      if (error.runId && !unretired) inFlight.delete(error.runId);
      return {
        ...base,
        status: 'unverified',
        differences: [],
        observations: unretired ? [`could not retire the run: ${unretired}`] : [],
        error: error.message,
      };
    }
  }
}
