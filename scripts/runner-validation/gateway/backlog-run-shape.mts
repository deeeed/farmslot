#!/usr/bin/env tsx
// Live proof that a standing manual backlog item dispatches exactly the run shape it declares,
// across a gateway restart. On an isolated gateway (own pool, projects, runs, backlog, home and
// private tmux server) the proof creates a nightly-shaped item (multiPr, scripted command,
// artifact-only, pipelineReview none, skipPrepare, one pinned slot), restarts the gateway, then
// marks it ready and enqueues it the way a nightly trigger does. The dispatched run must carry
// that shape, skip REVIEW for pipeline-review-off, finish, and return the item to ready. Then two
// more nights: the second fails; the third's handoff archives it and names it on the new run.
// `codex` and `claude` on the node's PATH are fixtures that refuse, so no model is reached.
//
// Run: yarn tsx scripts/runner-validation/gateway/backlog-run-shape.mts [evidence-dir]
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
import type { BacklogItem, NodeInfo, Run } from '../../../packages/protocol/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(root, process.argv[2] ?? `temp/backlog-run-shape/${Date.now()}`);
await mkdir(evidence, { recursive: true });
// The node resolves the checkout's real path (macOS /var is /private/var); the pool names it.
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'backlog-run-shape-')));
// Every tmux call here, the gateway's and the node's, reaches only this proof's private server.
const tmuxDir = await mkdtemp('/tmp/brs-');
const machine = 'backlog-shape-node';
const slotId = 'backlog-shape-slot';
const projectName = 'backlog-shape';
const session = path.basename(fixture);
const repo = path.join(fixture, 'repo');
// Created once MONITOR watches the worker; the worker's command waits for it.
const release = path.join(fixture, 'worker-release');
// Present: the worker fails after its release, the way a partial nightly does.
const failNight = path.join(fixture, 'worker-fail');
const baseEnv: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: tmuxDir };
delete baseEnv.TMUX;
delete baseEnv.TMUX_PANE;
const reaper = startReaper();
reaper.path(fixture);
reaper.path(tmuxDir);
reaper.command(['tmux', 'kill-server'], baseEnv);
const parts: IsolatedStackParts = {};
let run: Run | undefined;
const cleanupErrors: unknown[] = [];
const cleanup = cleanupOnExit(async () => {
  const attempt = (step: () => Promise<unknown>) =>
    step().catch((error: unknown) => cleanupErrors.push(error));
  const { connection } = parts;
  if (connection && run && !['done', 'failed', 'cancelled'].includes(run.status)) {
    const { id } = run;
    await attempt(() =>
      connection.call('run.cancel', { runId: id, reason: 'backlog run shape fixture cleanup' }),
    );
  }
  connection?.close();
  await attempt(() => stopProcess(parts.node));
  await attempt(() => stopProcess(parts.gateway));
  spawnSync('tmux', ['kill-server'], { stdio: 'ignore', env: baseEnv });
  await attempt(() => rm(fixture, { recursive: true, force: true }));
  await attempt(() => rm(tmuxDir, { recursive: true, force: true }));
  reaper.done();
});
const tmux = (...args: string[]) =>
  execFileSync('tmux', args, { encoding: 'utf8', env: baseEnv }).trim();

const shape = {
  runner: 'scripted',
  scripted: { mode: 'command', commandRef: 'nightly' },
  completionPolicy: 'artifact-only',
  pipelineReview: 'none',
  skipPrepare: true,
} as const;

let failure: unknown;
let result: Record<string, unknown> | undefined;
try {
  await linkCheckout(root, fixture, 'Isolated backlog run shape fixture');
  await linkCheckout(root, repo, 'Isolated backlog run shape checkout');
  await symlink(path.join(fixture, 'projects'), path.join(repo, 'projects'));
  // COMPLETE captures the working-tree diff of a run with no commits. A real slot checkout is clean;
  // this no-checkout clone would show every tracked file as deleted and the linked framework copy as
  // untracked, so mark the tracked files skip-worktree and exclude the linked paths.
  execFileSync('git', ['-C', repo, 'read-tree', 'HEAD']);
  const tracked = execFileSync('git', ['-C', repo, 'ls-files', '-z']);
  execFileSync('git', ['-C', repo, 'update-index', '-z', '--skip-worktree', '--stdin'], {
    input: tracked,
  });
  await writeFile(
    path.join(repo, '.git/info/exclude'),
    ['/scripts/', '/services', '/packages', '/node_modules', '/projects', '/CLAUDE.md'].join('\n') +
      '\n',
    { flag: 'a' },
  );
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
  // The nightly's whole turn: no code change, just the two reports a dev run hands over. It holds
  // until the proof sees MONITOR watching it (the launch check needs a live worker) and gives up
  // after 120 s if that never comes.
  const work = [
    `deadline=$(( $(date +%s) + 120 )); until [ -e '${release}' ]; do [ $(date +%s) -lt $deadline ] || exit 1; sleep 0.2; done`,
    `[ ! -e '${failNight}' ]`,
    'printf "# Nightly proof\\n\\nNo change.\\n" > "$FARMSLOT_TASK_DIR/artifacts/pr-description.md"',
    'printf "# Learnings\\n\\n- Scripted proof worker.\\n" > "$FARMSLOT_TASK_DIR/artifacts/learnings.md"',
  ].join(' && ');
  await json(path.join(project, 'project.json'), {
    name: projectName,
    repo_url: root,
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    execution_templates: { sources: [] },
    // Review is on for this project, so only the item's own run shape can skip it.
    review: {
      enabled: true,
      runner: 'codex',
      model: 'gpt-6-luna',
      effort: 'low',
      mode: 'cold',
      max_retries: 0,
    },
    scripted: { commands: { nightly: { command: work, timeout_ms: 60_000 } } },
    monitoring: { poll_interval_min: 0.02, total_timeout_min: 10 },
  });
  // A reviewer the engine might still launch finds these first and refuses: no model is reached.
  const shimDir = path.join(fixture, 'shim');
  await mkdir(shimDir);
  for (const runner of ['codex', 'claude']) {
    await writeFile(
      path.join(shimDir, runner),
      `#!/bin/sh\necho "${runner} is disabled in this fixture" >&2\nexit 1\n`,
    );
    await chmod(path.join(shimDir, runner), 0o755);
  }
  await json(path.join(fixture, `pool/${projectName}.json`), {
    machine,
    host: 'localhost',
    ssh_user: process.env.USER ?? 'operator',
    project: projectName,
    platform: 'cli',
    os: process.platform,
    env: { PATH: `${shimDir}:${process.env.PATH}` },
    slots: [{ id: slotId, enabled: true, repo, session, resources: {} }],
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
  tmux('new-session', '-d', '-s', session, '-c', repo);

  // 1. Create the standing item once, then stop that gateway.
  const first = await startIsolatedStack({ root, evidence, env: baseEnv, fixture, reaper }, parts);
  const { item: created } = await first.connection.call<{ item: BacklogItem }>('backlog.create', {
    project: projectName,
    title: 'Nightly device build',
    sourceKind: 'manual',
    flowType: 'dev',
    notes: 'Standing item for a nightly scripted pass. Reused every night.',
    multiPr: true,
    allowedSlots: [slotId],
    mode: 'autonomous',
    status: 'ready',
    ...shape,
  });
  await json(path.join(evidence, 'item-created.json'), created);
  // Backlog writes are debounced: restart only once the item is on disk, as a standing item is.
  await poll(
    'the item to reach the backlog file',
    async () => {
      const file = path.join(fixture, '.backlog.json');
      if (!existsSync(file)) return undefined;
      const stored = JSON.parse(await readFile(file, 'utf8')) as BacklogItem[];
      return stored.find((item) => item.id === created.id);
    },
    30_000,
  );
  first.connection.close();
  await stopProcess(parts.gateway);
  parts.gateway = undefined;
  parts.connection = undefined;

  // 2. A new gateway on the same backlog file: the item keeps its run shape.
  const { connection: gw } = await startIsolatedStack(
    {
      root,
      evidence,
      env: baseEnv,
      fixture,
      reaper,
      node: { machine, env: { PATH: `${shimDir}:${process.env.PATH}` } },
    },
    parts,
  );
  const reloaded = (
    await gw.call<{ items: BacklogItem[] }>('backlog.list', { project: projectName })
  ).items.find((item) => item.id === created.id);
  assert.ok(reloaded, 'the standing item survives the gateway restart');
  await json(path.join(evidence, 'item-after-restart.json'), reloaded);
  for (const [key, value] of Object.entries(shape))
    assert.deepEqual(reloaded[key as keyof typeof shape], value, `${key} after restart`);

  // The queue dispatches at once, so the node must be connected before the item is enqueued.
  await poll(
    'the fixture node to connect',
    async () => {
      if (parts.node?.exitCode != null) throw new Error('Fixture node exited; see node.log');
      const { nodes } = await gw.call<{ nodes: NodeInfo[] }>('nodes.list', {});
      return nodes.find((node) => node.machine === machine);
    },
    60_000,
  );

  // 3. The nightly trigger: mark ready, enqueue; the dispatcher creates the run.
  await gw.call('backlog.markReady', { itemId: created.id });
  await gw.call('backlog.enqueue', { itemId: created.id });
  run = await poll(
    'the dispatched run',
    async () =>
      (await gw.call<{ runs: Run[] }>('run.list', { project: projectName, limit: 5 })).runs.find(
        (candidate) => candidate.ticketOrPr === created.sourceRef,
      ),
    120_000,
  );
  const runId = run.id;
  run = (await gw.call<{ run: Run }>('run.get', { runId })).run;
  await json(path.join(evidence, 'run-created.json'), run);
  assert.equal(run.completionPolicy, 'artifact-only');
  assert.equal(run.pipelineReview, 'none');
  assert.deepEqual(run.scripted, shape.scripted);
  assert.equal(run.slotId ?? run.requestedSlotId ?? slotId, slotId);
  await poll(
    'MONITOR to watch the worker',
    async () => {
      run = (await gw.call<{ run: Run }>('run.get', { runId })).run;
      if (['failed', 'cancelled'].includes(run.status))
        throw new Error(`The run ended before MONITOR (${run.status}): ${run.error ?? ''}`);
      return run.steps.find((step) => step.name === 'monitor')?.status === 'running'
        ? run
        : undefined;
    },
    300_000,
  );
  // The engine records the dispatch flags once it starts the run.
  assert.equal(run.engineState?.flags?.skipPrepare, true);
  assert.deepEqual(run.steps.find((step) => step.name === 'prepare')?.outputs, {
    skipped: true,
    reason: 'operator-skip',
  });
  await writeFile(release, '');
  const finished = await poll(
    'the run to finish',
    async () => {
      run = (await gw.call<{ run: Run }>('run.get', { runId })).run;
      const reviewers = (run.agentContexts ?? []).filter((context) => context.role === 'review');
      if (reviewers.length > 0)
        throw new Error('A reviewer was launched for a pipelineReview none run');
      if (['failed', 'cancelled'].includes(run.status))
        throw new Error(`The run ended ${run.status}: ${run.error ?? ''}`);
      return run.status === 'done' ? run : undefined;
    },
    240_000,
  );
  await json(path.join(evidence, 'run-final.json'), finished);
  const review = finished.steps.find((step) => step.name === 'review');
  assert.equal(review?.outputs?.reason, 'pipeline-review-off', `REVIEW: ${JSON.stringify(review)}`);
  const prepare = finished.steps.find((step) => step.name === 'prepare');
  const item = await poll(
    'the standing item to return to ready',
    async () =>
      (
        await gw.call<{ items: BacklogItem[] }>('backlog.list', { project: projectName })
      ).items.find((candidate) => candidate.id === created.id && candidate.status === 'ready'),
    60_000,
  );
  await json(path.join(evidence, 'item-final.json'), item);

  // 4. Later nights. A failed, unarchived run holds its ticket and slot, so a failed night is
  // what blocked the next one. Night 2 fails; night 3 must still start.
  const seen = new Set([runId]);
  const night = async (label: string, expect: 'done' | 'failed'): Promise<Run> => {
    await rm(release, { force: true });
    if (expect === 'failed') await writeFile(failNight, '');
    else await rm(failNight, { force: true });
    await gw.call('backlog.enqueue', { itemId: created.id });
    let next = await poll(
      `the ${label} run`,
      async () =>
        (await gw.call<{ runs: Run[] }>('run.list', { project: projectName, limit: 10 })).runs.find(
          (candidate) => candidate.ticketOrPr === created.sourceRef && !seen.has(candidate.id),
        ),
      120_000,
    );
    seen.add(next.id);
    await poll(
      `MONITOR to watch the ${label}`,
      async () => {
        next = (await gw.call<{ run: Run }>('run.get', { runId: next.id })).run;
        if (['failed', 'cancelled'].includes(next.status))
          throw new Error(
            `The ${label} ended before MONITOR (${next.status}): ${next.error ?? ''}`,
          );
        return next.steps.find((step) => step.name === 'monitor')?.status === 'running'
          ? next
          : undefined;
      },
      300_000,
    );
    await writeFile(release, '');
    next = await poll(
      `the ${label} to end ${expect}`,
      async () => {
        next = (await gw.call<{ run: Run }>('run.get', { runId: next.id })).run;
        if (next.status === expect) return next;
        if (['done', 'failed', 'cancelled'].includes(next.status))
          throw new Error(`The ${label} ended ${next.status}, not ${expect}: ${next.error ?? ''}`);
        return undefined;
      },
      240_000,
    );
    assert.equal(next.backlogItemId, created.id);
    await json(path.join(evidence, `${label.replaceAll(' ', '-')}-final.json`), next);
    return next;
  };
  const failed = await night('second night', 'failed');
  await poll(
    'the standing item to show the failed night',
    async () =>
      (
        await gw.call<{ items: BacklogItem[] }>('backlog.list', { project: projectName })
      ).items.find((candidate) => candidate.id === created.id && candidate.status === 'failed'),
    60_000,
  );
  // The nightly trigger's step after a failed night (CUTOVER): mark ready, then enqueue.
  await gw.call('backlog.markReady', { itemId: created.id });
  const third = await night('third night', 'done');
  // The handoff archived the failed night (history kept) and named it on the next run.
  assert.deepEqual(third.archivedPriorRunIds, [failed.id]);
  const archivedNight = path.join(fixture, 'runs', 'archive', `${failed.id}.json`);
  assert.ok(
    existsSync(archivedNight),
    `the failed night is kept in the run archive: ${archivedNight}`,
  );
  const doneNight = (await gw.call<{ run: Run }>('run.get', { runId })).run;
  assert.equal(doneNight.status, 'done', 'a done night blocks nothing and is left alone');
  await poll(
    'the standing item to return to ready again',
    async () =>
      (
        await gw.call<{ items: BacklogItem[] }>('backlog.list', { project: projectName })
      ).items.find(
        (candidate) =>
          candidate.id === created.id && candidate.status === 'ready' && !candidate.runId,
      ),
    60_000,
  );
  result = {
    pass: true,
    evidence,
    itemRef: created.sourceRef,
    runId,
    run: {
      status: finished.status,
      completionPolicy: finished.completionPolicy,
      pipelineReview: finished.pipelineReview,
      skipPrepare: finished.engineState?.flags?.skipPrepare,
      scripted: finished.scripted,
      prepare: prepare && { status: prepare.status, outputs: prepare.outputs },
      review: review && { status: review.status, outputs: review.outputs },
    },
    itemStatus: item.status,
    laterNights: {
      failed: { runId: failed.id, status: failed.status },
      afterFailure: { runId: third.id, status: third.status },
      archivedPriorRunIds: third.archivedPriorRunIds,
    },
  };
  await json(path.join(evidence, 'result.json'), result);
} catch (error) {
  failure = error;
  await json(path.join(evidence, 'failure.json'), { error: String(error), fixture, run });
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
