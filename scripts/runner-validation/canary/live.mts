// Canary cases against the deployed gateway: per canary node, a native round trip and one
// scripted lifecycle run on that node's canary slot; on one node, the F324 replay. Only runs the
// canary creates are touched: each is pinned to a canary slot, in the canary project, tagged.
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { GatewayClient, type GatewayConnection } from '../../../packages/cli/src/gateway-client.js';
import { loadProfiles, profileCredential } from '../../../packages/cli/src/gateway-profiles.js';
import type { Run } from '../../../packages/protocol/src/index.js';
import { writeJson } from '../lib/isolated-stack.mjs';

import { CANARY_PROJECT, canaryRunParams } from './fixtures.mjs';
import {
  type CheckResult,
  failureText,
  LIFECYCLE_OUTCOME,
  outcomeDifferences,
  overBudget,
  runOutcome,
  type SlotView,
  stepTimings,
} from './outcome.mjs';

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
  onConnection?: (connection: GatewayConnection) => void;
}

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const WAITING = new Set(['needs-decision', 'human-gating', 'blocked', 'review-failed']);
const RUN_TIMEOUT_MS = 10 * 60_000;

export async function connectProfile(home: string, name: string): Promise<GatewayConnection> {
  const profile = loadProfiles(path.join(home, 'gateways.json')).gateways[name];
  if (!profile) throw new Error(`No gateway profile ${name} in ${home}/gateways.json`);
  return new GatewayClient({
    url: profile.url,
    timeout: 30_000,
    credential: profileCredential(profile) ?? null,
  }).connect();
}

export async function runLive(options: LiveOptions): Promise<CheckResult[]> {
  const { log } = options;
  const connection = await connectProfile(options.profileHome, options.profile);
  options.onConnection?.(connection);
  const call = <T,>(method: string, params?: unknown) => connection.call<T>(method, params);
  try {
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
    const results: CheckResult[] = [];
    for (const node of options.nodes) {
      if (options.nativeCheck) results.push(await nativeCheck(node.machine));
      if (options.lifecycle) results.push(await lifecycle(node, 'lifecycle'));
      if (node.machine === options.f324Node)
        results.push(await lifecycle(node, 'f324-replay-open-gate'));
    }
    return results;
  } finally {
    connection.close();
  }

  /** A zero-inference native round trip: the gateway routes a session list to the node's host. */
  async function nativeCheck(machine: string): Promise<CheckResult> {
    const started = Date.now();
    const base = {
      case: 'native-check',
      variant: machine,
      target: 'live' as const,
      model: 'none',
      modelCalls: 0,
    };
    try {
      await call('native.session.list', { executionNodeId: machine });
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      const late = overBudget({ 'native-check': seconds }, options.budgetsS);
      return {
        ...base,
        status: late.length ? 'fail' : 'pass',
        durationS: seconds,
        timingsS: { 'native-check': seconds },
        differences: late,
        observations: [],
        overBudget: late,
      };
    } catch (error) {
      return {
        ...base,
        status: 'fail',
        differences: [`native.session.list on ${machine} failed: ${String(error)}`],
        observations: [],
      };
    }
  }

  async function readSlot(slotId: string): Promise<SlotView | undefined> {
    const { fleet } = await call<{
      fleet: { slots: Array<{ slot: string; lifecycle: string; phase?: string | null }> };
    }>('fleet.status');
    return fleet.slots.find((slot) => slot.slot === slotId);
  }

  /**
   * One scripted canary run on the node's slot, driven to its end: the gate closed as shipped,
   * the slot released. The F324 variant replays from dispatch while the first gate card is open,
   * reading the decision inbox as a client does, and closes only a card the replay presents.
   */
  async function lifecycle(
    node: { machine: string; slot: string },
    kind: 'lifecycle' | 'f324-replay-open-gate',
  ): Promise<CheckResult> {
    const label = `${kind}-${node.machine}`;
    const dir = path.join(options.evidence, label);
    await mkdir(dir, { recursive: true });
    const base = {
      case: kind,
      variant: node.machine,
      target: 'live' as const,
      model: 'scripted',
      modelCalls: 0,
    };
    const started = Date.now();
    const { run: created } = await call<{ run: Run }>(
      'run.create',
      canaryRunParams(node.slot, label),
    );
    if (created.project !== CANARY_PROJECT || created.slotId !== node.slot)
      throw new Error(
        `Canary run ${created.id} was not pinned to ${node.slot} in ${CANARY_PROJECT}`,
      );
    const runId = created.id;
    await log(`${label}: run created`, { runId, slot: node.slot });
    const refused: string[] = [];
    const attempted = new Set<string>();
    let replayedAt: string | undefined;
    let run = created;
    let last = '';
    let changedAt = Date.now();
    let terminalSince: number | undefined;
    let slot: SlotView | undefined;
    try {
      for (;;) {
        if (Date.now() - started > RUN_TIMEOUT_MS) {
          refused.push(`the run did not settle within ${RUN_TIMEOUT_MS / 60_000} min`);
          break;
        }
        run = (await call<{ run: Run }>('run.get', { runId })).run;
        if (kind === 'f324-replay-open-gate' && replayedAt) await call('decision.list', {});
        slot = TERMINAL.has(run.status) ? await readSlot(node.slot) : undefined;
        const summary = `${run.status} ${run.steps.map((step) => `${step.name}:${step.status}`).join(' ')}${slot ? ` slot ${slot.lifecycle}/${slot.phase ?? '-'}` : ''}`;
        if (summary !== last) {
          await log(`${label}: ${summary}`);
          last = summary;
          changedAt = Date.now();
        }
        const gate = run.decisions.find(
          (decision) =>
            decision.type === 'engine_human_gate' &&
            !decision.resolvedAt &&
            !attempted.has(decision.id),
        );
        if (gate) {
          attempted.add(gate.id);
          try {
            if (kind === 'f324-replay-open-gate' && !replayedAt) {
              replayedAt = new Date().toISOString();
              await call('run.replayStep', { runId, stepName: 'dispatch' });
              await log(`${label}: replayed from dispatch with the gate card open`);
            } else if (!replayedAt || String(gate.createdAt) > replayedAt) {
              await call('run.resolveDecision', {
                runId,
                decisionId: gate.id,
                actionId: 'close-as-shipped',
              });
              await log(`${label}: closed the gate as shipped`);
            }
          } catch (error) {
            refused.push(
              `${replayedAt && kind !== 'lifecycle' ? 'the replay or gate close' : 'closing the gate'} was refused: ${String(error)}`,
            );
          }
          continue;
        }
        const unchangedMs = Date.now() - changedAt;
        if (TERMINAL.has(run.status)) {
          terminalSince ??= Date.now();
          if (
            (slot?.lifecycle === 'ready' && unchangedMs >= 1500) ||
            Date.now() - terminalSince > 150_000
          )
            break;
        } else if (
          (WAITING.has(run.status) &&
            run.decisions.some((decision) => !decision.resolvedAt) &&
            unchangedMs >= 5000) ||
          unchangedMs >= 6 * 60_000
        )
          break;
        await delay(1000);
      }
    } finally {
      // Never leave a canary run holding its slot.
      if (!TERMINAL.has(run.status))
        await call('run.cancel', { runId, reason: 'canary: outcome recorded' }).catch(
          (error: unknown) =>
            refused.push(`cancelling the unfinished canary run failed: ${String(error)}`),
        );
    }
    await writeJson(path.join(dir, 'run-final.json'), run);
    const observed = runOutcome(run, slot);
    const timingsS = stepTimings(run);
    if (terminalSince !== undefined && slot?.lifecycle === 'ready')
      timingsS.release = Math.round((changedAt - terminalSince) / 100) / 10;
    const differences = [...refused, ...outcomeDifferences(LIFECYCLE_OUTCOME, observed)];
    if (kind === 'f324-replay-open-gate') {
      const first = run.decisions
        .filter((decision) => decision.type === 'engine_human_gate')
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      if (first?.resolvedAction !== 'superseded')
        differences.push(
          `the gate card open at the replay ended ${first?.resolvedAction ?? (first ? 'open' : 'missing')}, not superseded`,
        );
    }
    const late = kind === 'lifecycle' ? overBudget(timingsS, options.budgetsS) : [];
    return {
      ...base,
      status: differences.length || late.length ? 'fail' : 'pass',
      runId,
      durationS: Math.round((Date.now() - started) / 100) / 10,
      observed,
      differences: [...differences, ...late],
      observations: [],
      timingsS,
      overBudget: late,
      failureText: failureText(run),
      evidence: dir,
    };
  }
}
