#!/usr/bin/env tsx
// Live proof that tmux.worker.list names a dispatched worker's runner on that worker's pane only.
//
// An isolated gateway (its own pool, projects, runs and home) dispatches a scripted dev run through
// run.create, and a node registered for the pool machine reports the tmux panes. Dispatch records
// the worker's `%N` in the agent context's paneId. The worker pane must carry linkedRunner; a split
// sibling in the worker window and a second window of the same session keep the run link but not
// the runner. Nothing reads pane text.
//
// Run: yarn tsx scripts/runner-validation/gateway/linked-runner-pane.mts [evidence-dir]
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type IsolatedStackParts,
  linkCheckout,
  poll,
  startIsolatedStack,
  stopProcess,
  writeJson as json,
} from '../lib/isolated-stack.mjs';
import type {
  Run,
  TmuxWorkerListResult,
  TmuxWorkerSummary,
} from '../../../packages/protocol/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(root, process.argv[2] ?? `temp/linked-runner-pane/${Date.now()}`);
await mkdir(evidence, { recursive: true });
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'linked-runner-pane-')));
const machine = 'linked-runner-node';
const slotId = 'linked-runner-slot';
const session = path.basename(fixture);
const repo = path.join(fixture, 'repo');

function tmux(...args: string[]) {
  return execFileSync('tmux', args, { encoding: 'utf8' }).trim();
}

// The fixture root and slot checkout borrow this checkout's code, like the other isolated e2e runs.
await linkCheckout(root, fixture, 'Isolated linked-runner fixture');
await linkCheckout(root, repo, 'Isolated linked-runner checkout');
await symlink(path.join(fixture, 'projects'), path.join(repo, 'projects'));
const project = path.join(fixture, 'projects/linked-runner');
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
await json(path.join(project, 'project.json'), {
  name: 'linked-runner',
  repo_url: root,
  paths: { runtime_dir: '.agent', artifact_dir: '.task' },
  execution_templates: { sources: [] },
  // Keeps the worker process alive while the panes are read; the run is cancelled afterwards.
  scripted: { commands: { hold: { command: 'sleep 300', timeout_ms: 330_000 } } },
  monitoring: { poll_interval_min: 0.02, total_timeout_min: 10 },
});
await json(path.join(fixture, 'pool/linked-runner.json'), {
  machine,
  host: 'localhost',
  ssh_user: process.env.USER ?? 'operator',
  project: 'linked-runner',
  platform: 'cli',
  os: process.platform,
  slots: [{ id: slotId, enabled: true, repo, session, resources: {} }],
});
await json(path.join(fixture, '.farm-status.json'), {
  checked_at: new Date().toISOString(),
  slots: [
    {
      slot: slotId,
      machine,
      project: 'linked-runner',
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

const parts: IsolatedStackParts = {};
let run: Run | undefined;
let failure: unknown;
let result: Record<string, unknown> | undefined;
try {
  tmux('new-session', '-d', '-s', session, '-c', repo);
  const { connection: gw } = await startIsolatedStack(
    { root, evidence, env: process.env, fixture, node: { machine } },
    parts,
  );

  run = (
    await gw.call<{ run: Run }>('run.create', {
      project: 'linked-runner',
      flowType: 'dev',
      // Free-text tickets are accepted only by interactive starts; the command makes no changes.
      mode: 'interactive',
      ticketOrPr: 'linked runner pane proof',
      initialContext: 'Linked runner pane validation run. Makes no changes.',
      slotId,
      runner: 'scripted',
      model: 'scripted',
      scripted: { mode: 'command', commandRef: 'hold' },
      skipPrepare: true,
      completionPolicy: 'artifact-only',
    })
  ).run;
  const runId = run.id;

  // The worker context dispatch wrote, with the `%N` it captured.
  const workerTarget = await poll(
    'the dispatched worker context',
    async () => {
      run = (await gw.call<{ run: Run }>('run.get', { runId })).run;
      if (['done', 'failed', 'blocked', 'cancelled'].includes(run.status))
        throw new Error(`Run ended as ${run.status} before its worker launched: ${run.error}`);
      const target = run.agentContexts?.find((ctx) => ctx.role === 'dev')?.target;
      return target?.paneId?.startsWith('%') ? target : undefined;
    },
    120_000,
  );
  await json(path.join(evidence, 'run.json'), run);
  const workerPaneId = workerTarget.paneId!;
  const siblingPaneId = tmux(
    'split-window',
    '-d',
    '-P',
    '-F',
    '#{pane_id}',
    '-t',
    workerPaneId,
    'sleep 300',
  );
  const shellPaneId = tmux(
    'new-window',
    '-d',
    '-P',
    '-F',
    '#{pane_id}',
    '-t',
    `=${session}:`,
    'sleep 300',
  );

  const panes = await poll(
    'the session panes in tmux.worker.list',
    async () => {
      const list = await gw.call<TmuxWorkerListResult>('tmux.worker.list', {
        machine,
        includeDisconnected: false,
      });
      const byPane = (paneId: string) =>
        list.workers.find(
          (worker) => worker.ref.session === session && worker.ref.paneId === paneId,
        );
      const found = {
        worker: byPane(workerPaneId),
        sibling: byPane(siblingPaneId),
        shell: byPane(shellPaneId),
      };
      return Object.values(found).every((worker) => worker?.linkedRunId === runId)
        ? (found as Record<'worker' | 'sibling' | 'shell', TmuxWorkerSummary>)
        : undefined;
    },
    60_000,
  );
  await json(path.join(evidence, 'session-workers.json'), {
    runId,
    workerTarget,
    panes,
  });

  assert.equal(run.metrics?.runner, 'scripted');
  assert.equal(panes.worker.linkedRunner, 'scripted', 'worker pane names the linked runner');
  assert.equal(panes.sibling.linkedRunner, undefined, 'split sibling names no linked runner');
  assert.equal(panes.shell.linkedRunner, undefined, 'second window names no linked runner');
  result = {
    pass: true,
    evidence,
    runId,
    workerTarget,
    linkedRunner: Object.fromEntries(
      Object.entries(panes).map(([name, worker]) => [
        name,
        { paneId: worker.ref.paneId, linkedRunner: worker.linkedRunner ?? null },
      ]),
    ),
  };
  await json(path.join(evidence, 'result.json'), result);
} catch (error) {
  failure = error;
  await json(path.join(evidence, 'failure.json'), { error: String(error), fixture });
} finally {
  const cleanupErrors: unknown[] = [];
  const { connection } = parts;
  if (connection && run && !['done', 'failed', 'cancelled'].includes(run.status)) {
    await connection
      .call('run.cancel', { runId: run.id, reason: 'linked runner fixture cleanup' })
      .catch((error: unknown) => cleanupErrors.push(error));
  }
  connection?.close();
  await stopProcess(parts.node);
  await stopProcess(parts.gateway);
  // Cancelling the run may already have closed the session; only a surviving one is an error.
  const killed = spawnSync('tmux', ['kill-session', '-t', `=${session}`], { stdio: 'ignore' });
  if (
    killed.status !== 0 &&
    spawnSync('tmux', ['has-session', '-t', `=${session}`], { stdio: 'ignore' }).status === 0
  )
    cleanupErrors.push(new Error(`Owned tmux session ${session} survived cleanup`));
  await rm(fixture, { recursive: true, force: true });
  if (cleanupErrors.length > 0)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      'Cleanup failed',
    );
}
if (failure) throw failure;
console.log(JSON.stringify(result));
