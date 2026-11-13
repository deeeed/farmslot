#!/usr/bin/env tsx
// Live proof that an artifact-only run keeps the diff files the gateway writes at COMPLETE. MONITOR
// captures the worker's output first; COMPLETE then writes artifacts/diff.txt and its siblings and
// captures again. The second capture must retain them: /api/run-artifact serves every diff file the
// run lists from the bundle run.get names, and the output identity (manifestDigest) stays the one
// MONITOR captured. The engine runs for real on an isolated gateway (own pool, projects, runs, home
// and private tmux server) with the scripted runner; the slot is local, so no node agent runs.
//
// Run: yarn tsx scripts/runner-validation/gateway/late-diff-retention.mts [evidence-dir]
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  cleanupOnExit,
  connectGateway,
  freePort,
  type IsolatedStackParts,
  linkCheckout,
  startReaper,
  startWorkspaceProcess,
  stopProcess,
  writeJson as json,
} from '../lib/isolated-stack.mjs';
import { testGatewayIdentity } from '../../lib/test-gateway-identity-source.mjs';
import type { Run } from '../../../packages/protocol/src/index.js';

const DIFF_FILES = [
  'artifacts/diff.txt',
  'artifacts/diff-stat.json',
  'artifacts/iteration-diff.txt',
  'artifacts/iteration-diff-stat.json',
];

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(root, process.argv[2] ?? `temp/late-diff-retention/${Date.now()}`);
await mkdir(evidence, { recursive: true });
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'late-diff-retention-')));
// Every tmux call here reaches only this proof's private server.
const tmuxDir = await mkdtemp('/tmp/ldr-');
const machine = 'late-diff-node';
const slotId = 'late-diff-slot';
const session = path.basename(fixture);
const repo = path.join(fixture, 'repo');
// Created once MONITOR watches the worker; the worker's command waits for it.
const release = path.join(fixture, 'worker-release');
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
      connection.call('run.cancel', { runId: id, reason: 'late diff fixture cleanup' }),
    );
  }
  connection?.close();
  await attempt(() => stopProcess(parts.gateway));
  spawnSync('tmux', ['kill-server'], { stdio: 'ignore', env: baseEnv });
  await attempt(() => rm(fixture, { recursive: true, force: true }));
  await attempt(() => rm(tmuxDir, { recursive: true, force: true }));
  reaper.done();
});
const tmux = (...args: string[]) =>
  execFileSync('tmux', args, { encoding: 'utf8', env: baseEnv }).trim();

interface Capture {
  capturedAt: string;
  manifestDigest: string;
  bundleDigest: string | undefined;
  listedDiffFiles: string[];
}

let failure: unknown;
let result: Record<string, unknown> | undefined;
try {
  await linkCheckout(root, fixture, 'Isolated late diff fixture');
  await linkCheckout(root, repo, 'Isolated late diff checkout');
  // The clone has no checkout. Mark every tracked file skip-worktree so the working tree diff
  // COMPLETE captures holds only the worker's change, not thousands of absent files.
  execFileSync('git', ['-C', repo, 'read-tree', 'HEAD']);
  execFileSync('git', ['-C', repo, 'update-index', '--skip-worktree', '--stdin'], {
    input: execFileSync('git', ['-C', repo, 'ls-files'], { maxBuffer: 64 * 1024 * 1024 }),
  });
  await symlink(path.join(fixture, 'projects'), path.join(repo, 'projects'));
  const project = path.join(fixture, 'projects/late-diff');
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
  // The worker's whole turn: one committed change, so COMPLETE has a diff to write, and the two
  // reports a dev run hands over. It holds until the proof sees MONITOR watching it.
  const work = [
    `deadline=$(( $(date +%s) + 120 )); until [ -e '${release}' ]; do [ $(date +%s) -lt $deadline ] || exit 1; sleep 0.2; done`,
    'printf "late diff proof\\n" > late-diff-proof.txt',
    'git add late-diff-proof.txt',
    'git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm "test: late diff proof change"',
    'printf "# Late diff proof\\n\\nOne fixture change.\\n" > "$FARMSLOT_TASK_DIR/artifacts/pr-description.md"',
    'printf "# Learnings\\n\\n- Scripted proof worker.\\n" > "$FARMSLOT_TASK_DIR/artifacts/learnings.md"',
  ].join(' && ');
  await json(path.join(project, 'project.json'), {
    name: 'late-diff',
    repo_url: root,
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    execution_templates: { sources: [] },
    review: { enabled: false },
    scripted: { commands: { change: { command: work, timeout_ms: 60_000 } } },
    monitoring: { poll_interval_min: 0.02, total_timeout_min: 10 },
  });
  await json(path.join(fixture, 'pool/late-diff.json'), {
    machine,
    host: 'localhost',
    ssh_user: process.env.USER ?? 'operator',
    project: 'late-diff',
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
        project: 'late-diff',
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
  // The isolated gateway as startIsolatedStack starts it, without a node (the slot is local), and
  // with a start budget a loaded host can meet: a cold gateway import takes over a minute there.
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}`;
  const token = testGatewayIdentity(path.join(fixture, 'home'), url);
  const gateway = (parts.gateway = startWorkspaceProcess(
    {
      root,
      evidence,
      env: {
        ...baseEnv,
        FARMSLOT_ROOT: fixture,
        FARMSLOT_HOME: path.join(fixture, 'home'),
        FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
        FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
        FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
        FARMSLOT_DISPATCH_QUEUE_FILE: path.join(fixture, 'queue.json'),
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: String(port),
        FARMSLOT_GATEWAY_PROFILE: 'proof',
        FARMSLOT_DISABLE_ORCHESTRATION: '1',
        FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
      },
    },
    '@farmslot/gateway',
    'gateway.log',
  ));
  reaper.group(gateway.pid);
  const gw = (parts.connection = await connectGateway({
    url,
    token,
    gateway,
    log: 'gateway.log',
    budgetMs: 300_000,
  }));

  run = (
    await gw.call<{ run: Run }>('run.create', {
      project: 'late-diff',
      flowType: 'dev',
      mode: 'interactive',
      devInteractiveProfile: 'reviewed',
      ticketOrPr: 'late diff retention proof',
      initialContext: 'Late diff retention validation run. Commits one fixture file.',
      slotId,
      runner: 'scripted',
      model: 'scripted',
      scripted: { mode: 'command', commandRef: 'change' },
      skipPrepare: true,
      completionPolicy: 'artifact-only',
      pipelineReview: 'none',
    })
  ).run;
  const runId = run.id;
  const read = async () => (run = (await gw.call<{ run: Run }>('run.get', { runId })).run);
  const step = (name: string) => run!.steps.find((candidate) => candidate.name === name);
  // Budgets for a loaded host: task init and launch run the checkout CLI.
  const deadline = Date.now() + 600_000;
  while (step('monitor')?.status !== 'running') {
    await read();
    if (['failed', 'cancelled'].includes(run.status))
      throw new Error(`The run ended before MONITOR (${run.status}): ${run.error ?? ''}`);
    if (Date.now() > deadline) throw new Error('Timed out waiting for MONITOR');
    await delay(500);
  }
  await writeFile(release, '');
  // Every distinct output capture, read every 100 ms until COMPLETE is done.
  const captures: Capture[] = [];
  const completeDeadline = Date.now() + 600_000;
  for (;;) {
    await read();
    const output = run.output;
    if (output && output.capturedAt !== captures.at(-1)?.capturedAt)
      captures.push({
        capturedAt: output.capturedAt,
        manifestDigest: output.manifestDigest,
        bundleDigest: output.artifactBundle?.bundleDigest,
        listedDiffFiles: output.artifactManifest
          .map(({ path: file }) => file)
          .filter((file) => DIFF_FILES.includes(file)),
      });
    const complete = step('complete');
    if (['failed', 'cancelled'].includes(run.status) || complete?.status === 'failed')
      throw new Error(`COMPLETE failed (${run.status}): ${run.error ?? complete?.detail ?? ''}`);
    if (complete?.status === 'done') break;
    if (Date.now() > completeDeadline) throw new Error('Timed out waiting for COMPLETE');
    await delay(100);
  }
  await json(path.join(evidence, 'run-final.json'), run);
  await json(path.join(evidence, 'captures.json'), captures);

  const final = run;
  const output = final.output!;
  const listed = output.artifactManifest
    .map(({ path: file }) => file)
    .filter((file) => DIFF_FILES.includes(file));
  assert.ok(
    listed.includes('artifacts/diff.txt') && listed.includes('artifacts/diff-stat.json'),
    `COMPLETE wrote and listed the diff files: ${JSON.stringify(listed)}`,
  );
  // The worker's capture came first, without the gateway diff files.
  const workerCapture = captures.find((capture) => capture.listedDiffFiles.length === 0);
  const reads = [];
  for (const file of listed) {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/run-artifact?${new URLSearchParams({ runId, path: file })}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = await response.text();
    reads.push({
      path: file,
      status: response.status,
      bundleDigest: response.headers.get('X-Farmslot-Bundle-Digest'),
      bytes: body.length,
      ...(response.ok ? {} : { body: body.slice(0, 200) }),
    });
  }
  await json(path.join(evidence, 'artifact-reads.json'), reads);
  const bundleDigest = final.artifactBundle?.bundleDigest;
  result = {
    runId,
    evidence,
    captures,
    reads,
    runBundleDigest: bundleDigest,
    outputBundleDigest: output.artifactBundle?.bundleDigest,
    manifestDigest: output.manifestDigest,
  };
  for (const entry of reads) {
    assert.equal(entry.status, 200, `${entry.path}: ${entry.status} ${entry.body ?? ''}`);
    assert.equal(entry.bundleDigest, bundleDigest, `${entry.path} came from run.get's bundle`);
  }
  assert.equal(output.artifactBundle?.bundleDigest, bundleDigest);
  assert.ok(workerCapture, 'the worker capture without the diff files was observed');
  assert.equal(output.manifestDigest, workerCapture.manifestDigest, 'output identity unchanged');
  assert.notEqual(bundleDigest, workerCapture.bundleDigest, 'COMPLETE retained a new bundle');
  result = { pass: true, ...result };
  await json(path.join(evidence, 'result.json'), result);
} catch (error) {
  failure = error;
  await json(path.join(evidence, 'failure.json'), { error: String(error), fixture, result, run });
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
