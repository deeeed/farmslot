// Live proof on an isolated gateway: an artifact-only dev run created through the CLI keeps its
// pipeline review off, dispatch.preview echoes it, and run.create and dispatch.preview refuse it on
// a flow that pushes, without artifact-only, and for an unknown value. Engine start is disabled, so
// no worker or reviewer launches here; no-pipeline-review-skip.mts runs the engine for the REVIEW
// step's recorded skip.
//
// Run: yarn tsx scripts/runner-validation/gateway/no-pipeline-review.mts [evidence-dir]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanupOnExit,
  type IsolatedStackParts,
  linkCheckout,
  startIsolatedStack,
  startReaper,
  stopProcess,
  writeJson as json,
} from '../lib/isolated-stack.mjs';
import type { Run } from '../../../packages/protocol/src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(root, process.argv[2] ?? `temp/no-pipeline-review/${Date.now()}`);
await mkdir(evidence, { recursive: true });
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'farmslot-no-pipeline-review-')));
// The gateway's tmux calls reach only this proof's (unstarted) server.
const tmuxDir = await mkdtemp('/tmp/npr-');
// Outside the fixture root's own status file, which the gateway refuses as a shared fleet store.
const statusFile = path.join(fixture, 'status', 'farm-status.json');
const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: tmuxDir };
delete env.TMUX;
delete env.TMUX_PANE;
// A cancelled recipe SIGKILLs this process within a second; the reaper then stops what it owned.
const reaper = startReaper();
reaper.path(fixture);
reaper.path(tmuxDir);
const parts: IsolatedStackParts = {};
let token = '';
const cleanupErrors: unknown[] = [];
const cleanup = cleanupOnExit(async () => {
  const attempt = (step: () => Promise<unknown>) =>
    step().catch((error: unknown) => cleanupErrors.push(error));
  parts.connection?.close();
  await attempt(() => stopProcess(parts.gateway));
  await attempt(() => rm(fixture, { recursive: true, force: true }));
  await attempt(() => rm(tmuxDir, { recursive: true, force: true }));
  reaper.done();
});

let failure: unknown;
let result: Record<string, unknown> | undefined;
try {
  // FARMSLOT_ROOT must be a Farmslot checkout: a shared clone with this checkout's sources.
  await linkCheckout(root, fixture, 'Isolated pipeline review validation');
  await json(path.join(fixture, 'projects', 'proof', 'project.json'), {
    name: 'proof',
    repo_url: 'https://github.com/example/app.git',
    ci: { repo: 'example/app' },
    default_branch: 'main',
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
  });
  // run.create renders the project's dev worker template; the example pack's is enough here.
  await mkdir(path.join(fixture, 'projects', 'proof', 'templates', 'worker'), { recursive: true });
  await writeFile(
    path.join(fixture, 'projects', 'proof', 'templates', 'worker', 'dev.md'),
    await readFile(
      path.join(root, 'packs/example-app/projects/example-app-farm/templates/worker/dev.md'),
    ),
  );
  await mkdir(path.join(fixture, 'repo'));
  await json(path.join(fixture, 'pool', 'proof-host.json'), {
    machine: 'proof-host',
    host: 'localhost',
    project: 'proof',
    platform: 'cli',
    slots: [
      {
        id: 'proof-1',
        enabled: true,
        repo: path.join(fixture, 'repo'),
        session: 'npr-proof',
        resources: {},
      },
    ],
  });
  await json(statusFile, {
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: 'proof-1',
        machine: 'proof-host',
        project: 'proof',
        platform: 'cli',
        enabled: true,
        lifecycle: 'ready',
        agent: 'idle',
        branch: 'main',
        runner: 'claude',
        model: 'sonnet',
      },
    ],
  });
  const stack = await startIsolatedStack(
    {
      root,
      evidence,
      env,
      fixture,
      reaper,
      gatewayEnv: {
        NODE_TEST_CONTEXT: '1',
        FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
        FARMSLOT_TEST_STATUS_FILE: statusFile,
        FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'test-automation',
      },
    },
    parts,
  );
  const connection = stack.connection;
  token = stack.token;
  const url = `ws://127.0.0.1:${stack.port}`;
  // The CLI reads the proof's profile for this URL from the fixture's home.
  const cliEnv = { ...env, FARMSLOT_HOME: path.join(fixture, 'home') };

  /** The checkout-local CLI against the isolated gateway; a refusal returns its error text. */
  function cli(args: string[]): { ok: true; data: any } | { ok: false; error: string } {
    try {
      const raw = execFileSync(
        'yarn',
        ['workspace', '@farmslot/cli', 'farmslot', '--url', url, '--json', ...args],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 60_000,
          env: cliEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const parsed = JSON.parse(raw);
      return parsed.status === 'ok' ? { ok: true, data: parsed.data } : { ok: false, error: raw };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      return { ok: false, error: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
    }
  }

  const proven: Record<string, unknown> = {};

  const dev = ['--project', 'proof', '--flow-type', 'dev', '--ticket', 'no pipeline review proof'];

  const preview = cli(['dispatch', 'preview', ...dev, '--no-pipeline-review']);
  assert(preview.ok, `preview: ${!preview.ok && preview.error}`);
  assert.deepEqual(preview.data.preview.pipelineReview, {
    policy: 'none',
    reason: 'Pipeline review is off for this artifact-only run (pipelineReview none).',
  });
  proven.preview = preview.data.preview.pipelineReview;

  const created = cli(['run', 'create', ...dev, '--no-pipeline-review']);
  assert(created.ok, `run create: ${!created.ok && created.error}`);
  const { run } = await connection.call<{ run: Run }>('run.get', { runId: created.data.run.id });
  assert.equal(run.pipelineReview, 'none');
  assert.equal(run.completionPolicy, 'artifact-only');
  proven.readback = {
    runId: run.id,
    pipelineReview: run.pipelineReview,
    completionPolicy: run.completionPolicy,
  };
  await connection.call('run.cancel', { runId: run.id });

  const before = (await connection.call<{ runs: Run[] }>('run.list')).runs.length;
  const refusals: Record<string, string> = {};
  for (const [label, params, expected] of [
    [
      'update-branch',
      { flowType: 'update-branch', ticketOrPr: 'example/app#7', completionPolicy: 'artifact-only' },
      /only for dev and fix-bug runs; update-branch runs/,
    ],
    [
      'no artifact-only',
      { flowType: 'dev', ticketOrPr: 'proof refusal' },
      /only for artifact-only runs/,
    ],
    [
      'unknown value',
      {
        flowType: 'dev',
        ticketOrPr: 'proof refusal',
        completionPolicy: 'artifact-only',
        pipelineReview: 'off',
      },
      /must be 'default' or 'none', not "off"/,
    ],
  ] as const) {
    for (const method of ['dispatch.preview', 'run.create'] as const) {
      const refused = await connection
        .call(method, { project: 'proof', pipelineReview: 'none', ...params })
        .then(
          () => null,
          (error: Error) => error.message,
        );
      assert(refused && expected.test(refused), `${method} ${label}: ${refused ?? 'accepted'}`);
      refusals[`${method} ${label}`] = refused;
    }
  }
  assert.equal(
    (await connection.call<{ runs: Run[] }>('run.list')).runs.length,
    before,
    'a refusal creates nothing',
  );
  proven.refusals = refusals;
  // The CLI flag on the dispatch preview of a flow that pushes is refused the same way.
  const cliRefusal = cli([
    'dispatch',
    'preview',
    '--project',
    'proof',
    '--flow-type',
    'update-branch',
    '--ticket',
    'example/app#7',
    '--no-pipeline-review',
  ]);
  assert(
    !cliRefusal.ok && /only for dev and fix-bug runs/.test(cliRefusal.error),
    'CLI update-branch preview',
  );
  result = {
    pass: true,
    endpoint: 'isolated gateway, checkout-local CLI and RPC',
    engineStartDisabled: true,
    ...proven,
  };
  await json(path.join(evidence, 'result.json'), result);
} catch (error) {
  const log = await readFile(path.join(evidence, 'gateway.log'), 'utf8').catch(() => '');
  const details = (token ? log.replaceAll(token, '[redacted]') : log)
    .split('\n')
    .slice(-20)
    .join('\n');
  failure = new Error(`${String(error)}\n${details}`, { cause: error });
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
console.log(JSON.stringify(result, null, 2));
