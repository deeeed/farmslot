#!/usr/bin/env tsx
// Live proof (F296) that a pool rewrite landing during a dispatch's launch preflight no longer
// fails the run: the engine dispatches once more on the re-read inputs and the worker launches.
//
// An isolated gateway and node (their own pool, projects, runs, home and private tmux server)
// dispatch a scripted dev run through run.create. The pool's machine PATH puts a fixture `node`
// first: when the launch preflight's code probe runs, it rewrites one machine env value in the pool
// file once, as the 0.94.9 pin update did to Extension a1b1684a and Terminal b075cfb6. The run must
// record the retry, launch its worker, and reach MONITOR. Nothing else is substituted.
//
// Run: yarn tsx scripts/runner-validation/gateway/launch-inputs-reload.mts [evidence-dir]
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
import type { Run } from '../../../packages/protocol/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(root, process.argv[2] ?? `temp/launch-inputs-reload/${Date.now()}`);
await mkdir(evidence, { recursive: true });
// The node resolves the checkout's real path (macOS /var is /private/var); the pool names it.
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'launch-inputs-reload-')));
// Every tmux call here, the gateway's and the node's reach only this proof's private server.
const tmuxDir = await mkdtemp('/tmp/lir-');
const machine = 'launch-reload-node';
const slotId = 'launch-reload-slot';
const session = path.basename(fixture);
const repo = path.join(fixture, 'repo');
const poolFile = path.join(fixture, 'pool/launch-reload.json');
const rewrote = path.join(fixture, 'pool-rewritten');
const baseEnv: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: tmuxDir };
delete baseEnv.TMUX;
delete baseEnv.TMUX_PANE;
// A cancelled recipe SIGKILLs this process within a second; the reaper then stops what it owned.
const reaper = startReaper();
reaper.path(fixture);
reaper.path(tmuxDir);
reaper.command(['tmux', 'kill-server'], baseEnv);
// What the worker's shell saw for the rewritten value: the retry must launch on the new inputs.
const workerPin = path.join(fixture, 'worker-pin');
const parts: IsolatedStackParts = {};
let run: Run | undefined;
const cleanupErrors: unknown[] = [];
// Every owned resource is attempted, on the normal path and when the recipe is cancelled.
const cleanup = cleanupOnExit(async () => {
  const attempt = (step: () => Promise<unknown>) =>
    step().catch((error: unknown) => cleanupErrors.push(error));
  const { connection } = parts;
  if (connection && run && !['done', 'failed', 'cancelled'].includes(run.status)) {
    const { id } = run;
    await attempt(() =>
      connection.call('run.cancel', { runId: id, reason: 'launch inputs reload fixture cleanup' }),
    );
  }
  connection?.close();
  await attempt(() => stopProcess(parts.node));
  await attempt(() => stopProcess(parts.gateway));
  // The proof's own tmux server under its private TMUX_TMPDIR; no other server is touched.
  spawnSync('tmux', ['kill-server'], { stdio: 'ignore', env: baseEnv });
  await attempt(() => rm(fixture, { recursive: true, force: true }));
  await attempt(() => rm(tmuxDir, { recursive: true, force: true }));
  reaper.done();
});

const tmux = (...args: string[]) =>
  execFileSync('tmux', args, { encoding: 'utf8', env: baseEnv }).trim();

await linkCheckout(root, fixture, 'Isolated launch-inputs reload fixture');
await linkCheckout(root, repo, 'Isolated launch-inputs reload checkout');
// The launch preflight checks the slot's package manager the way a worker would run it.
for (const entry of ['.yarnrc.yml', '.yarn', 'yarn.lock', '.nvmrc'])
  if (existsSync(path.join(root, entry)))
    await symlink(path.join(root, entry), path.join(repo, entry));
await symlink(path.join(fixture, 'projects'), path.join(repo, 'projects'));
const project = path.join(fixture, 'projects/launch-reload');
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
  name: 'launch-reload',
  repo_url: root,
  paths: { runtime_dir: '.agent', artifact_dir: '.task' },
  execution_templates: { sources: [] },
  // Keeps the worker alive until the run is read at MONITOR; the run is cancelled afterwards.
  scripted: {
    commands: {
      hold: {
        command: `printf %s "$LAUNCH_RELOAD_PIN" > '${workerPin}' && sleep 300`,
        timeout_ms: 330_000,
      },
    },
  },
  monitoring: { poll_interval_min: 0.02, total_timeout_min: 10 },
});
// The fixture `node` the slot's shell finds first. The launch preflight's code probe is the only
// call carrying its program text; the first one rewrites the pool file, then every call is node.
const shimDir = path.join(fixture, 'shim');
await mkdir(shimDir);
await writeFile(
  path.join(shimDir, 'node'),
  [
    '#!/bin/sh',
    'case "$*" in',
    '  *"Worker farmslot CLI is missing"*)',
    `    if mkdir ${JSON.stringify(rewrote)} 2>/dev/null; then`,
    `      ${JSON.stringify(process.execPath)} -e 'const fs=require("fs"),f=process.argv[1],p=JSON.parse(fs.readFileSync(f,"utf8"));p.env.LAUNCH_RELOAD_PIN="after";fs.writeFileSync(f,JSON.stringify(p,null,2))' ${JSON.stringify(poolFile)}`,
    '    fi;;',
    'esac',
    `exec ${JSON.stringify(process.execPath)} "$@"`,
    '',
  ].join('\n'),
);
await chmod(path.join(shimDir, 'node'), 0o755);
await json(poolFile, {
  machine,
  host: 'localhost',
  ssh_user: process.env.USER ?? 'operator',
  project: 'launch-reload',
  platform: 'cli',
  os: process.platform,
  env: { PATH: `${shimDir}:${process.env.PATH}`, LAUNCH_RELOAD_PIN: 'before' },
  slots: [{ id: slotId, enabled: true, repo, session, resources: {} }],
});
await json(path.join(fixture, '.farm-status.json'), {
  checked_at: new Date().toISOString(),
  slots: [
    {
      slot: slotId,
      machine,
      project: 'launch-reload',
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

let failure: unknown;
let result: Record<string, unknown> | undefined;
try {
  tmux('new-session', '-d', '-s', session, '-c', repo);
  const { connection: gw } = await startIsolatedStack(
    { root, evidence, env: baseEnv, fixture, reaper, node: { machine } },
    parts,
  );

  run = (
    await gw.call<{ run: Run }>('run.create', {
      project: 'launch-reload',
      flowType: 'dev',
      mode: 'interactive',
      ticketOrPr: 'launch inputs reload proof',
      initialContext: 'Launch inputs reload validation run. Makes no changes.',
      slotId,
      runner: 'scripted',
      model: 'scripted',
      scripted: { mode: 'command', commandRef: 'hold' },
      skipPrepare: true,
      completionPolicy: 'artifact-only',
    })
  ).run;
  const runId = run.id;
  const monitoring = await poll(
    'the run to reach MONITOR',
    async () => {
      run = (await gw.call<{ run: Run }>('run.get', { runId })).run;
      const dispatch = run.steps.find((step) => step.name === 'dispatch');
      if (
        ['done', 'failed', 'blocked', 'cancelled'].includes(run.status) ||
        dispatch?.status === 'failed'
      )
        throw new Error(
          `Dispatch did not survive the reload (${run.status}): ${run.error ?? dispatch?.detail}`,
        );
      return run.steps.find((step) => step.name === 'monitor')?.status === 'running'
        ? run
        : undefined;
    },
    180_000,
  );
  await json(path.join(evidence, 'run.json'), monitoring);
  const dispatch = monitoring.steps.find((step) => step.name === 'dispatch')!;
  const subSteps = (
    (dispatch.outputs?.subSteps ?? []) as Array<{ name: string; detail?: string }>
  ).map((step) => step.name);
  assert.ok(existsSync(rewrote), 'the pool file was rewritten during the code probe');
  assert.equal(
    JSON.parse(await readFile(poolFile, 'utf8')).env.LAUNCH_RELOAD_PIN,
    'after',
    'the rewrite stuck',
  );
  assert.equal(dispatch.status, 'done');
  assert.ok(subSteps.includes('preflight-retry'), `the retry is recorded: ${subSteps.join(', ')}`);
  const seen = await poll(
    'the worker to record the value it launched with',
    async () => (existsSync(workerPin) ? await readFile(workerPin, 'utf8') : undefined),
    30_000,
  );
  assert.equal(seen, 'after', 'the retried launch ran on the rewritten inputs');
  result = { pass: true, evidence, runId, dispatchSubSteps: subSteps, workerSawPin: seen };
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
