#!/usr/bin/env tsx
// Live proof (F306) that find-slot asks before claiming a slot bound to another app. An isolated
// gateway and node (own pool, projects, runs, home and tmux socket directory) host one local slot
// whose pool `app` is apps/playground:
// 1. A run pinned to it with app=apps/sherpa-voice stops on an app_binding_mismatch card while the
//    slot's ownership row is unchanged. Abort fails the run, and the row is still unchanged.
// 2. A run with the slot's own app passes find-slot without a card; the proof then cancels it.
// 3. Continue on the card: find-slot selects again, replays the answer (still one card), claims the
//    slot and records `appBinding`.
// 4. Abort across a gateway restart: the card outlives its waiter; resolved on the restarted
//    gateway, Abort fails the run with no second card and the slot as it was.
// The worker is the scripted runner and waits on a file the proof never writes, so no model runs.
//
// Run: yarn tsx scripts/runner-validation/gateway/app-binding-mismatch.mts [evidence-dir]
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanupOnExit,
  type IsolatedStackParts,
  linkCheckout,
  poll,
  startIsolatedStack,
  startReaper,
  stopProcess,
  writeJson as json,
} from '../lib/isolated-stack.mjs';
import type {
  FleetStatusResult,
  Run,
  RunDecision,
  SlotStatus,
} from '../../../packages/protocol/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(root, process.argv[2] ?? `temp/app-binding-mismatch/${Date.now()}`);
await mkdir(evidence, { recursive: true });
// The node resolves the checkout's real path (macOS /var is /private/var); the pool names it.
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'app-binding-mismatch-')));
// Any tmux call the gateway or node makes reaches only a socket under this directory.
const tmuxDir = await mkdtemp('/tmp/abm-');
const machine = 'app-binding-node';
const slotId = 'app-binding-slot';
const projectName = 'app-binding';
const session = path.basename(fixture);
const repo = path.join(fixture, 'repo');
const baseEnv: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: tmuxDir };
delete baseEnv.TMUX;
delete baseEnv.TMUX_PANE;
const privateTmuxServer = () => existsSync(path.join(tmuxDir, `tmux-${process.getuid?.() ?? ''}`));
const reaper = startReaper();
reaper.path(fixture);
reaper.path(tmuxDir);
// The proof's own socket directory only: a dispatch the matching run reaches may start a server there.
reaper.command(['tmux', 'kill-server'], baseEnv);
const parts: IsolatedStackParts = {};
// The gateway started again on the same fixture for node 4 (the node is not restarted).
const restarted: IsolatedStackParts = {};
const runs: Run[] = [];
const cleanupErrors: unknown[] = [];
const cleanup = cleanupOnExit(async () => {
  const attempt = (step: () => Promise<unknown>) =>
    step().catch((error: unknown) => cleanupErrors.push(error));
  const connection = restarted.connection ?? parts.connection;
  for (const run of runs) {
    if (!connection) break;
    const current = await connection
      .call<{ run: Run }>('run.get', { runId: run.id })
      .then((result) => result.run)
      .catch((error: unknown) => {
        cleanupErrors.push(error);
        return undefined;
      });
    if (current && !['done', 'failed', 'cancelled'].includes(current.status))
      await attempt(() =>
        connection.call('run.cancel', { runId: run.id, reason: 'app binding fixture cleanup' }),
      );
  }
  restarted.connection?.close();
  parts.connection?.close();
  await attempt(() => stopProcess(parts.node));
  await attempt(() => stopProcess(restarted.gateway));
  await attempt(() => stopProcess(parts.gateway));
  // Only a server on this proof's own socket directory, and only if a step started one.
  if (privateTmuxServer()) spawnSync('tmux', ['kill-server'], { stdio: 'ignore', env: baseEnv });
  await attempt(() => rm(fixture, { recursive: true, force: true }));
  await attempt(() => rm(tmuxDir, { recursive: true, force: true }));
  reaper.done();
});

type Ownership = Pick<
  SlotStatus,
  'lifecycle' | 'phase' | 'currentRunId' | 'handoffRunId' | 'cleanupRunId' | 'slotEpoch'
>;

let failure: unknown;
let result: Record<string, unknown> | undefined;
try {
  await linkCheckout(root, fixture, 'Isolated app binding fixture');
  await linkCheckout(root, repo, 'Isolated app binding checkout');
  await symlink(path.join(fixture, 'projects'), path.join(repo, 'projects'));
  const project = path.join(fixture, 'projects', projectName);
  await mkdir(path.join(project, 'templates/prompts'), { recursive: true });
  await writeFile(
    path.join(project, 'templates/prompts/worker-dispatch.md'),
    'Read {{TASK_FILE}} and run the configured command.\n',
  );
  await mkdir(path.join(project, 'templates/worker'), { recursive: true });
  await writeFile(
    path.join(project, 'templates/worker/dev.md'),
    '# Worker: dev\n\n- [ ] Run the configured command.\n',
  );
  const neverWritten = path.join(fixture, 'never-written');
  await json(path.join(project, 'project.json'), {
    name: projectName,
    repo_url: root,
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    execution_templates: { sources: [] },
    // Two apps and no recipe default: the slot's own pool app is its binding.
    apps: ['apps/playground', 'apps/sherpa-voice'],
    scripted: {
      commands: {
        hold: {
          command: `deadline=$(( $(date +%s) + 60 )); until [ -e '${neverWritten}' ]; do [ $(date +%s) -lt $deadline ] || exit 1; sleep 0.2; done`,
          timeout_ms: 90_000,
        },
      },
    },
    monitoring: { poll_interval_min: 0.02, total_timeout_min: 10 },
  });
  await json(path.join(fixture, `pool/${projectName}.json`), {
    machine,
    host: 'localhost',
    ssh_user: process.env.USER ?? 'operator',
    project: projectName,
    platform: 'cli',
    os: process.platform,
    slots: [{ id: slotId, enabled: true, repo, session, app: 'apps/playground', resources: {} }],
  });
  await json(path.join(fixture, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: slotId,
        machine,
        project: projectName,
        platform: 'cli',
        repo,
        session,
        lifecycle: 'ready',
        phase: null,
        agent: 'idle',
        enabled: true,
        health: { ssh: 'LOCAL', device: '-', devserver: 'OK', fixtures: '-' },
      },
    ],
  });
  let { connection: gw } = await startIsolatedStack(
    { root, evidence, env: baseEnv, fixture, reaper, node: { machine } },
    parts,
  );

  const ownership = async (): Promise<Ownership> => {
    const { fleet } = await gw.call<FleetStatusResult>('fleet.status');
    const row = fleet.slots.find((slot) => slot.slot === slotId);
    assert.ok(row, `${slotId} is in the fleet`);
    const { lifecycle, phase, currentRunId, handoffRunId, cleanupRunId, slotEpoch } = row;
    return { lifecycle, phase, currentRunId, handoffRunId, cleanupRunId, slotEpoch };
  };
  const createRun = async (app: string) => {
    const { run } = await gw.call<{ run: Run }>('run.create', {
      project: projectName,
      flowType: 'dev',
      mode: 'interactive',
      devInteractiveProfile: 'reviewed',
      ticketOrPr: `app binding proof ${app}`,
      initialContext: 'App binding validation run. Its worker only waits.',
      slotId,
      runner: 'scripted',
      model: 'scripted',
      scripted: { mode: 'command', commandRef: 'hold' },
      skipPrepare: true,
      completionPolicy: 'artifact-only',
      app,
    });
    runs.push(run);
    return run;
  };
  const readRun = async (runId: string) => (await gw.call<{ run: Run }>('run.get', { runId })).run;
  const appCards = (run: Run): RunDecision[] =>
    run.decisions.filter((decision) => decision.type === 'engine_app_binding_mismatch');
  const findSlot = (run: Run) => run.steps.find((step) => step.name === 'find-slot');
  const waitForCard = (runId: string) =>
    poll(
      'the app binding card',
      async () => {
        const run = await readRun(runId);
        if (['failed', 'cancelled', 'done'].includes(run.status))
          throw new Error(`The run ended before asking (${run.status}): ${run.error ?? ''}`);
        if (findSlot(run)?.status === 'done')
          throw new Error(`find-slot claimed ${run.slotId} without asking about its app`);
        return appCards(run).find((decision) => !decision.resolvedAt);
      },
      120_000,
    );
  const waitForFailure = (runId: string) =>
    poll(
      'the aborted run to fail',
      async () => {
        const run = await readRun(runId);
        if (appCards(run).length > 1) throw new Error('A second app binding card opened');
        return run.status === 'failed' ? run : undefined;
      },
      60_000,
    );
  const waitForStop = (runId: string) =>
    poll(
      'the run to stop',
      async () => {
        const run = await readRun(runId);
        return ['cancelled', 'failed', 'done'].includes(run.status) ? run : undefined;
      },
      120_000,
    );
  const abortedMessage = new RegExp(
    `App binding mismatch: ${slotId} is bound to apps/playground, not apps/sherpa-voice`,
  );

  const before = await ownership();
  await json(path.join(evidence, 'slot-before.json'), before);

  // 1. Another app: a card before any claim, then Abort.
  const mismatched = await createRun('apps/sherpa-voice');
  const card = await waitForCard(mismatched.id);
  await json(path.join(evidence, 'card.json'), card);
  assert.deepEqual(card.payload, {
    kind: 'app_binding_mismatch',
    slotId,
    runApp: 'apps/sherpa-voice',
    slotApp: 'apps/playground',
    source: 'slot',
    boundSlots: [],
  });
  assert.deepEqual(
    card.actions.map((action) => action.id),
    ['abort', 'continue'],
  );
  const atCard = await ownership();
  assert.deepEqual(atCard, before, 'the slot row is unchanged while the card is open');
  await gw.call('run.resolveDecision', {
    runId: mismatched.id,
    decisionId: card.id,
    actionId: 'abort',
  });
  const aborted = await waitForFailure(mismatched.id);
  await json(path.join(evidence, 'aborted-run.json'), aborted);
  assert.match(aborted.error ?? '', abortedMessage);
  const afterAbort = await ownership();
  assert.deepEqual(afterAbort, before, 'the aborted run left the slot as it was');

  // 2. The slot's own app: find-slot passes without a card.
  const matching = await createRun('apps/playground');
  const passed = await poll(
    'find-slot to pass for the matching app',
    async () => {
      const run = await readRun(matching.id);
      if (appCards(run).length > 0) throw new Error('A matching app raised the app binding card');
      const step = findSlot(run);
      if (step?.status === 'done') return run;
      if (['failed', 'cancelled'].includes(run.status) || step?.status === 'failed')
        throw new Error(
          `find-slot did not pass (${run.status}): ${run.error ?? step?.detail ?? ''}`,
        );
      return undefined;
    },
    120_000,
  );
  await json(path.join(evidence, 'matching-run.json'), passed);
  const matchedStep = findSlot(passed)!;
  assert.equal(matchedStep.outputs?.selectedSlot, slotId);
  assert.equal(matchedStep.outputs?.appBinding, undefined);
  await gw.call('run.cancel', { runId: matching.id, reason: 'app binding proof done' });
  const cancelled = await waitForStop(matching.id);

  // 3. Continue: select again, replay the answer, claim, record the binding.
  const continuing = await createRun('apps/sherpa-voice');
  const continueCard = await waitForCard(continuing.id);
  await gw.call('run.resolveDecision', {
    runId: continuing.id,
    decisionId: continueCard.id,
    actionId: 'continue',
  });
  const claimed = await poll(
    'find-slot to claim after Continue',
    async () => {
      const run = await readRun(continuing.id);
      if (['failed', 'cancelled'].includes(run.status))
        throw new Error(`The run ended after Continue (${run.status}): ${run.error ?? ''}`);
      return findSlot(run)?.status === 'done' ? run : undefined;
    },
    120_000,
  );
  await json(path.join(evidence, 'continued-run.json'), claimed);
  assert.equal(appCards(claimed).length, 1, 'the restarted attempt replays the answer');
  const continuedStep = findSlot(claimed)!;
  assert.equal(continuedStep.outputs?.selectedSlot, slotId);
  assert.deepEqual(continuedStep.outputs?.appBinding, continueCard.payload);
  const claimedRow = await poll(
    'the slot row to name the continued run',
    async () => {
      const row = await ownership();
      return row.currentRunId === continuing.id ? row : undefined;
    },
    30_000,
  );
  await gw.call('run.cancel', { runId: continuing.id, reason: 'app binding proof done' });
  await waitForStop(continuing.id);
  // A cancelled run keeps its slot until a later claim reclaims it. Node 4 compares against the
  // row once teardown is done: two equal reads in a row, neither mid-release.
  let previous: string | undefined;
  const settled = await poll(
    'the slot row to settle after the cancel',
    async () => {
      const row = await ownership();
      const current = JSON.stringify(row);
      const stable = row.phase !== 'releasing' && current === previous;
      previous = current;
      return stable ? row : undefined;
    },
    120_000,
  );
  await json(path.join(evidence, 'slot-before-restart-node.json'), settled);

  // 4. Abort across a gateway restart: the resolver resumes find-slot with no live waiter.
  const restarting = await createRun('apps/sherpa-voice');
  const restartCard = await waitForCard(restarting.id);
  gw.close();
  await stopProcess(parts.gateway);
  const afterRestart = path.join(evidence, 'after-restart');
  await mkdir(afterRestart, { recursive: true });
  ({ connection: gw } = await startIsolatedStack(
    { root, evidence: afterRestart, env: baseEnv, fixture, reaper },
    restarted,
  ));
  const reloaded = await readRun(restarting.id);
  assert.deepEqual(
    appCards(reloaded).map((decision) => [decision.id, decision.resolvedAt ?? null]),
    [[restartCard.id, null]],
    'the card survives the restart, unanswered',
  );
  await gw.call('run.resolveDecision', {
    runId: restarting.id,
    decisionId: restartCard.id,
    actionId: 'abort',
  });
  const abortedAfterRestart = await waitForFailure(restarting.id);
  await json(path.join(evidence, 'aborted-after-restart.json'), abortedAfterRestart);
  assert.equal(appCards(abortedAfterRestart).length, 1, 'no second card after the restart');
  assert.match(abortedAfterRestart.error ?? '', abortedMessage);
  const afterRestartAbort = await ownership();
  assert.deepEqual(afterRestartAbort, settled, 'the slot row is as it was before the run');

  result = {
    pass: true,
    evidence,
    card: { id: card.id, payload: card.payload },
    slotBefore: before,
    slotAtCard: atCard,
    slotAfterAbort: afterAbort,
    aborted: { id: aborted.id, status: aborted.status, error: aborted.error },
    matching: { id: passed.id, findSlot: matchedStep.outputs, finalStatus: cancelled.status },
    continued: {
      id: claimed.id,
      cards: appCards(claimed).length,
      findSlot: continuedStep.outputs,
      slotRow: claimedRow,
    },
    abortedAfterRestart: {
      id: abortedAfterRestart.id,
      cards: appCards(abortedAfterRestart).length,
      error: abortedAfterRestart.error,
      slotBefore: settled,
      slotAfter: afterRestartAbort,
    },
  };
  await json(path.join(evidence, 'result.json'), result);
} catch (error) {
  failure = error;
  await json(path.join(evidence, 'failure.json'), { error: String(error), fixture });
} finally {
  await cleanup();
  if (cleanupErrors.length > 0)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      'Cleanup failed',
    );
}
if (failure) throw failure;
console.log(JSON.stringify(result));
