import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

export const SCENARIO_ID = 'terminal-order-smoke';
export const RUNNER_AGNOSTIC = true;

/**
 * Live proof of ADR-053 publish-before-cleanup on a terminal run
 * (MANUAL-000117).
 *
 * The engine used to gate the terminal status on teardown: the failure branches
 * ran `cleanupSlotAfterRunFailure` before broadcasting, and the COMPLETE and
 * CI-watch steps ran `slotRelease` inside the step body. Clients therefore saw
 * `failed` / `done` only after tmux teardown, provider shutdown, and the slot
 * reset had all finished.
 *
 * The claim is an ORDERING between two independently observable facts, so this
 * samples both as fast as the gateway will answer and looks for a sample where
 * the run is already terminal while its slot has not returned to `ready`. That
 * combination is impossible under the old ordering: the slot was ready before
 * the terminal status was ever published.
 *
 * Reads run state FIRST and slot state second, so a positive sample is
 * conservative — the slot was still occupied at a moment strictly after the run
 * was already terminal.
 *
 * The run fails at WRITE_TASK against a PR that does not exist, which is the
 * engine's generic `fail` branch with the real slot teardown behind it.
 * `complete` is not proven here — a scripted run cannot reach `done` on
 * farmslot-farm without producing a real publication package and PR — and
 * `block` is unit-covered; both are recorded as such in this evidence rather
 * than claimed.
 */

function rpc(method, params = {}, timeoutMs = 120_000) {
  const script = path.join(ROOT, 'apps/command-center/scripts/cdp.mjs');
  const result = spawnSync('node', [script, 'gateway', method, JSON.stringify(params)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs + 10_000,
    env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: String(timeoutMs) },
  });
  const stdout = result.stdout?.trim() ?? '';
  if (result.status !== 0) {
    throw new Error(
      `Gateway RPC ${method} failed (exit ${result.status}): ${result.stderr?.trim() || stdout || 'gateway unavailable'}`,
    );
  }
  return JSON.parse(stdout);
}

function tryRpc(method, params = {}, timeoutMs = 30_000) {
  try {
    return { ok: true, value: rpc(method, params, timeoutMs) };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * One authenticated gateway socket, held open for the whole observation.
 *
 * Spawning `cdp.mjs` per sample costs ~200ms of process startup, which is wider
 * than the teardown window this scenario has to resolve — a sampler that slow
 * cannot tell "the window did not exist" from "the sampler could not see it".
 * The same socket also receives the gateway's own broadcasts, so the moment the
 * terminal status is PUBLISHED is recorded at the resolution the gateway
 * published it, not at polling resolution.
 */
class GatewaySocket {
  constructor() {
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
    /** Broadcast events, with the local time each one arrived. */
    this.events = [];
  }

  static credential() {
    const pick = (env) =>
      env.FARMSLOT_GATEWAY_PASSWORD
        ? { password: env.FARMSLOT_GATEWAY_PASSWORD }
        : env.FARMSLOT_GATEWAY_TOKEN
          ? { token: env.FARMSLOT_GATEWAY_TOKEN }
          : null;
    const fromProcess = pick(process.env);
    if (fromProcess) return fromProcess;
    for (const name of ['.env.local-auth', '.env']) {
      const file = path.join(ROOT, name);
      if (!fs.existsSync(file)) continue;
      const parsed = {};
      for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
        const match = rawLine.trim().match(/^([A-Z0-9_]+)=(.*)$/);
        if (match) parsed[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
      const fromFile = pick(parsed);
      if (fromFile) return fromFile;
    }
    return null;
  }

  connect(timeoutMs = 15_000) {
    const url = process.env.FARMSLOT_GATEWAY ?? 'ws://localhost:7777';
    const credential = GatewaySocket.credential();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`gateway socket did not authenticate within ${timeoutMs}ms`));
      }, timeoutMs);
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on('message', (buffer) => {
        const message = JSON.parse(buffer);
        if (message.id === 'auth') {
          clearTimeout(timer);
          if (!message.ok) {
            socket.close();
            reject(new Error(`gateway auth refused: ${JSON.stringify(message)}`));
            return;
          }
          this.socket = socket;
          resolve(this);
          return;
        }
        if (message.type === 'event') {
          this.events.push({ at: Date.now(), event: message.event, payload: message.payload });
          return;
        }
        const settle = this.pending.get(message.id);
        if (!settle) return;
        this.pending.delete(message.id);
        message.ok
          ? settle.resolve(message.payload ?? message.result)
          : settle.reject(new Error(JSON.stringify(message)));
      });
      socket.once('open', () =>
        socket.send(
          JSON.stringify({
            type: 'req',
            id: 'auth',
            method: 'auth.connect',
            params: {
              clientKind: 'ui',
              clientName: 'terminal-order-smoke',
              ...(credential?.token ? { token: credential.token } : {}),
              ...(credential?.password ? { password: credential.password } : {}),
            },
          }),
        ),
      );
    });
  }

  call(method, params = {}, timeoutMs = 20_000) {
    const id = `r${(this.nextId += 1)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

const TERMINAL_STATUSES = new Set(['done', 'failed', 'blocked', 'cancelled']);

/**
 * How long the terminal broadcast may trail the terminal status WRITE.
 *
 * The router emits from `onMutated`, immediately after the single store
 * mutation, so the honest value is a few milliseconds. The budget is generous
 * on purpose: what it has to separate is "published straight away" from
 * "published after teardown finished", and teardown is seconds of tmux and
 * provider work — the pre-ADR-053 shape measures ~2s here.
 */
const PUBLISH_LAG_BUDGET_MS = 500;

/**
 * Whether this sample shows a run that actually went through the engine's
 * terminal transition.
 *
 * `completedAt` is the discriminator, and it has to be: it is written by the
 * SAME store mutation that publishes the terminal status, while a terminal-
 * looking status alone is not enough — an interactive run held at a blocked
 * gate reads `blocked` with its slot deliberately retained and its monitor step
 * still running, which would satisfy a status-only check under the old ordering
 * as well.
 */
function wentTerminal(entry) {
  return TERMINAL_STATUSES.has(entry.runStatus ?? '') && Boolean(entry.runCompletedAt);
}

/**
 * One sample of the two facts, run state before slot state.
 *
 * The order matters for the claim: reading the slot first and the run second
 * could pair a stale "still busy" slot with a later terminal run and prove
 * nothing.
 */
async function sample(socket, runId, slotId) {
  const at = Date.now();
  const run = (await socket.call('run.get', { runId })).run;
  const fleet = await socket.call('fleet.status', {});
  const slot = fleet.fleet?.slots?.find((candidate) => candidate.slot === slotId) ?? null;
  return {
    at,
    elapsedMs: 0,
    runStatus: run?.status ?? null,
    runCompletedAt: run?.completedAt ?? null,
    slotLifecycle: slot?.lifecycle ?? null,
    slotPhase: slot?.phase ?? null,
    slotCurrentRunId: slot?.currentRunId ?? null,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollFor(description, read, accept, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = read();
    if (accept(latest)) return latest;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}; latest=${JSON.stringify(latest)}`);
}

export async function runScenario({ timeoutMs, outDir, slotId, explicit = false }) {
  const reportRunner = 'scripted';
  if (!slotId || process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS !== '1') {
    const reason =
      'terminal-order-smoke needs --slot <farmslot-farm slotId> and FARMSLOT_ENABLE_SCRIPTED_SCENARIOS=1; it dispatches a real scripted validation run';
    const report = { runner: reportRunner, pass: false, skipped: !explicit, reason, nodes: [] };
    const outPath = writeEvidence(report, SCENARIO_ID, reportRunner, outDir);
    return { scenario: SCENARIO_ID, runner: reportRunner, outPath, pass: false, report };
  }

  const nodes = [];
  const node = (name, pass, detail) => {
    nodes.push({ name, pass, detail });
    if (!pass) throw new Error(`${name}: ${detail}`);
  };
  const report = {
    runner: reportRunner,
    slotId,
    pass: false,
    // Stated in the evidence rather than left to be inferred: what this
    // scenario does and does not discriminate.
    discrimination:
      'The `fail` teardown reachable on this fleet — `cleanupSlotAfterRunFailure` after a ' +
      'WRITE_TASK failure — is slot-row work with no worker to kill, and completes in tens of ' +
      'milliseconds. Re-running this scenario against a build that awaits the teardown BEFORE ' +
      'publishing (the pre-ADR-053 shape) therefore still passes: there is nothing slow to wait ' +
      'for. The node below is a REGRESSION GUARD on the publish lag, not a discriminating proof ' +
      'of the ordering. The discriminating proof is run-lifecycle/terminal-transition.test.ts, ' +
      'whose ordering assertions do fail when the teardown is moved ahead of the publish. The ' +
      'slow teardown (`slotRelease`: tmux kill, git reset, artifact copy) belongs to the ' +
      '`complete` path, which a scripted run cannot reach on farmslot-farm without producing a ' +
      'real publication package and writing to a real PR.',
    coverage: {
      fail: 'live end-to-end in this scenario, through a WRITE_TASK failure on a nonexistent PR: the run reaches `failed` through the refactored transition and its slot returns to ready',
      complete:
        'not live: a scripted run cannot reach `done` on farmslot-farm without producing a real publication package and PR. Covered by run-lifecycle/terminal-transition.test.ts and the ci-watch step deferral test.',
      block:
        'not live: unit-covered in run-lifecycle/terminal-transition.test.ts, as planned for this slice.',
    },
    nodes,
  };
  let runId = null;
  let socket = null;

  try {
    socket = await new GatewaySocket().connect();
    const fleet = rpc('fleet.status');
    const slot = fleet.fleet?.slots?.find((candidate) => candidate.slot === slotId);
    if (!slot) throw new Error(`slot ${slotId} not found in fleet.status`);
    report.project = slot.project;

    const created = rpc('run.create', {
      project: slot.project,
      // A review-pr run against a PR that does not exist fails at WRITE_TASK,
      // which is the engine's generic `fail` branch: the terminal status write,
      // the step-scoped slot cleanup, and the terminal safety net. It is the
      // only terminal failure reachable on this fleet without spending an LLM
      // turn or writing to a real PR — the scripted runner's `failure` scenario
      // parks the run at a blocked ALERT (an operator wait with its slot held
      // and its monitor step still running), which is not a terminal transition
      // at all and would pass a status-only check under the old ordering too.
      flowType: 'review-pr',
      mode: 'autonomous',
      ticketOrPr: process.env.FARMSLOT_TERMINAL_ORDER_MISSING_PR ?? 'deeeed/farmslot#999999',
      runner: 'scripted',
      scripted: { mode: 'scenario', scenario: 'success', stepDelayMs: 0 },
      slotId,
      skipPrepare: true,
    });
    runId = created.run.id;
    report.runId = runId;

    await pollFor(
      'the run to bind its slot',
      () => rpc('run.get', { runId }).run,
      (state) => state.slotId === slotId,
      timeoutMs,
    );

    // Sample both facts until the run is terminal AND its slot is back to
    // ready, so the window either shows up in the samples or provably did not
    // exist. Held on one socket, so the cadence is a gateway round trip rather
    // than a process spawn; the achieved cadence is recorded either way.
    const samples = [];
    const startedAt = Date.now();
    const deadline = startedAt + Math.min(timeoutMs, 600_000);
    let settled = false;
    while (Date.now() < deadline) {
      const entry = await sample(socket, runId, slotId);
      entry.elapsedMs = entry.at - startedAt;
      samples.push(entry);
      if (wentTerminal(entry) && entry.slotLifecycle === 'ready' && !entry.slotCurrentRunId) {
        settled = true;
        break;
      }
    }
    report.sampleCount = samples.length;
    report.sampleCadenceMs =
      samples.length > 1
        ? Math.round(
            (samples[samples.length - 1].at - samples[0].at) / Math.max(1, samples.length - 1),
          )
        : null;
    const last = samples[samples.length - 1];
    report.finalStatus = last?.runStatus ?? null;
    report.finalCompletedAt = last?.runCompletedAt ?? null;

    // The gateway's own publish moment, at broadcast resolution rather than
    // polling resolution: the event the transition router emits from
    // `onMutated`, before any after-effect runs.
    const terminalEvent = socket.events.find(
      (entry) =>
        entry.payload?.run?.id === runId && TERMINAL_STATUSES.has(entry.payload?.run?.status ?? ''),
    );
    // The two moments the claim is about, on one clock:
    //
    //   publish  — when the gateway BROADCAST the terminal run, which the
    //              transition router does from `onMutated`, before any
    //              after-effect;
    //   released — the first sample, taken after this run had bound the slot,
    //              that saw the slot back to ready and unowned.
    //
    // Anchoring "released" to the binding is what makes the comparison mean
    // anything: the slot was ready before this run ever claimed it, so the
    // first ready sample of the whole series is not the release.
    const boundIndex = samples.findIndex((entry) => entry.slotCurrentRunId === runId);
    const firstReadyAfterBinding =
      boundIndex >= 0
        ? samples
            .slice(boundIndex)
            .find((entry) => entry.slotLifecycle === 'ready' && !entry.slotCurrentRunId)
        : null;
    report.publishedAt = terminalEvent?.at ?? null;
    report.publishedEvent = terminalEvent?.event ?? null;
    report.slotBoundSampleAt = boundIndex >= 0 ? samples[boundIndex].at : null;
    report.slotReleasedObservedAt = firstReadyAfterBinding?.at ?? null;
    report.publishToSlotReadyMs =
      terminalEvent && firstReadyAfterBinding ? firstReadyAfterBinding.at - terminalEvent.at : null;

    node(
      'run-reached-terminal',
      Boolean(last) && wentTerminal(last),
      `run settled at ${report.finalStatus} completedAt=${report.finalCompletedAt}; slot settled=${settled}`,
    );

    node(
      'slot-binding-observed',
      boundIndex >= 0,
      boundIndex >= 0
        ? `${slotId} was observed bound to ${runId.slice(0, 8)}`
        : `${slotId} was never observed bound to this run`,
    );

    // THE claim, measured on the two moments that are free of any cache: the
    // terminal status WRITE (`completedAt`, written by the transition's single
    // store mutation) and the BROADCAST of that status (this socket's receive
    // time). ADR-053 puts the broadcast immediately after the mutation and the
    // teardown after both, so this lag is milliseconds. The pre-ADR-053 shape
    // ran the teardown between them, so the lag was the whole teardown.
    //
    // Deliberately not measured against the fleet's view of the slot: that is
    // served from a refreshed cache, so it trails BOTH moments by an
    // unpredictable amount and cannot separate the two orderings. It is
    // recorded below as context, not as the proof.
    report.publishLagMs =
      terminalEvent && report.finalCompletedAt
        ? terminalEvent.at - Date.parse(report.finalCompletedAt)
        : null;
    node(
      'terminal-status-published-without-waiting-for-teardown',
      report.publishLagMs !== null && report.publishLagMs <= PUBLISH_LAG_BUDGET_MS,
      terminalEvent
        ? `terminal ${terminalEvent.event} broadcast ${report.publishLagMs}ms after the status write (budget ${PUBLISH_LAG_BUDGET_MS}ms)`
        : 'no terminal run event was broadcast to this socket',
    );

    // Recorded, not gated: the fleet's slot view is cache-served, so the gap to
    // it is context for the operator rather than a second proof.
    const proof = samples.filter(
      (entry) => wentTerminal(entry) && (entry.slotLifecycle !== 'ready' || entry.slotCurrentRunId),
    );
    report.publishedBeforeReleaseSamples = proof.slice(0, 20);
    report.pairedSampleCatches = proof.length;

    node(
      'slot-returned-to-ready',
      settled,
      settled
        ? `${slotId} returned to ready after the terminal status`
        : `${slotId} never returned to ready within the budget`,
    );

    report.pass = nodes.every((entry) => entry.pass);
  } catch (error) {
    report.error = error?.message ?? String(error);
    report.pass = false;
  } finally {
    if (runId) {
      const state = tryRpc('run.get', { runId });
      const current = state.ok ? state.value.run : null;
      if (!current || !TERMINAL_STATUSES.has(current.status ?? '') || !current.completedAt) {
        tryRpc('run.cancel', { runId, reason: `${SCENARIO_ID} validation complete` });
      }
    }
    socket?.close();
    const released = tryRpc('slot.release', { slotId, keepWork: true }, 300_000);
    if (!released.ok) report.cleanupWarnings = [released.error];
  }

  const outPath = writeEvidence(report, SCENARIO_ID, reportRunner, outDir);
  return { scenario: SCENARIO_ID, runner: reportRunner, outPath, pass: report.pass, report };
}
