// Client-endpoint proof for the acceptance-unreadable refusal on a run whose
// artifact capture failed (run 062f6a94: the bundle volume was unmounted).
//
// A private gateway on an isolated FARMSLOT_ROOT serves one seeded copy of that
// run record with its recorded captureError and no retained bundle. The proof
// reads the refusal through real client RPCs, so the message an operator sees is
// observed over the wire rather than asserted in-process:
//
//   run.get              -> the seeded record with its recorded capture failure
//   run.recipeRunsForRun -> RUN_ARTIFACTS_NOT_RETAINED naming the storage failure
//
// It creates no farm run, touches no shared gateway, and mounts nothing. Pass the
// source record with FARMSLOT_CAPTURE_PROOF_RUN (a `farmslot run get --json`
// document or a bare run record) and its retained task directory with
// FARMSLOT_CAPTURE_PROOF_TASK_DIR; both default to the parked 062f6a94 copies.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Run } from '@farmslot/protocol';

import { testGatewayIdentity } from '../../lib/test-gateway-identity-source.mjs';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.argv[2] === 'serve') {
  await import('../../../services/gateway/src/index.js');
} else {
  const recordPath =
    process.env.FARMSLOT_CAPTURE_PROOF_RUN ??
    path.join(source, 'temp/acceptance-unreadable/run.json');
  const taskDirSource =
    process.env.FARMSLOT_CAPTURE_PROOF_TASK_DIR ??
    path.join(source, 'temp/acceptance-unreadable/task');
  assert.ok(existsSync(recordPath), `Missing run record: ${recordPath}`);
  assert.ok(existsSync(taskDirSource), `Missing task directory: ${taskDirSource}`);

  const raw: unknown = JSON.parse(readFileSync(recordPath, 'utf8'));
  const envelope = raw as { data?: { run?: Run }; run?: Run };
  const original = (envelope.data?.run ?? envelope.run ?? raw) as Run;
  assert.ok(original.output?.captureError, 'The source run must record a capture failure');
  assert.equal(
    original.artifactBundle ?? original.output?.artifactBundle,
    undefined,
    'The source run must have retained no bundle',
  );

  const scratch = mkdtempSync(path.join(realpathSync(tmpdir()), 'acceptance-unreadable-proof-'));
  const root = path.join(scratch, 'root');
  const runsDir = path.join(root, '.runs');
  // The gate refuses a task outside the project's orchestrator task root, so the
  // copy keeps the original's projects/<project>/tasks/<flow>/<task> shape.
  const taskRel = (original.taskFile ?? '').split(`${path.sep}tasks${path.sep}`)[1];
  const taskDir = path.join(
    root,
    'projects',
    original.project,
    'tasks',
    taskRel ? path.dirname(taskRel) : path.basename(taskDirSource),
  );
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(path.dirname(taskDir), { recursive: true });
  cpSync(taskDirSource, taskDir, { recursive: true });
  // The root markers resolveFarmslotRoot looks for, linked from this checkout so
  // the private gateway runs this branch's code with its own farm paths.
  symlinkSync(path.join(source, 'scripts'), path.join(root, 'scripts'), 'dir');
  symlinkSync(path.join(source, 'packages'), path.join(root, 'packages'), 'dir');
  symlinkSync(path.join(source, 'services'), path.join(root, 'services'), 'dir');
  symlinkSync(path.join(source, 'CLAUDE.md'), path.join(root, 'CLAUDE.md'), 'file');

  // One copy of the real record, re-identified so nothing can reach the farm run,
  // with its task file inside this scratch root. Its captureError, acceptance
  // inputs, steps and metrics are the recorded ones.
  const runId = randomUUID();
  const run: Run = {
    ...original,
    id: runId,
    taskFile: path.join(taskDir, path.basename(original.taskFile ?? 'TASK.md')),
    activeTaskFile: undefined,
    slotId: undefined,
    requestedSlotId: undefined,
    allowedSlots: [],
  };
  writeFileSync(path.join(runsDir, `${runId}.json`), `${JSON.stringify(run, null, 2)}\n`);

  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      assert.ok(address && typeof address === 'object');
      probe.close(() => resolve(address.port));
    });
  });
  const home = path.join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  testGatewayIdentity(home, `ws://127.0.0.1:${port}`);
  // An allowlisted environment, never the operator shell's: an inherited
  // FARMSLOT_* path (a dispatch queue file, a pool directory, a runs directory)
  // would let this gateway reconcile real farm state against a scratch run store
  // and persist the result.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    SHELL: process.env.SHELL ?? '/bin/sh',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    ...(process.env.USER ? { USER: process.env.USER } : {}),
    ...(process.env.LOGNAME ? { LOGNAME: process.env.LOGNAME } : {}),
    FARMSLOT_ROOT: root,
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_RUNS_DIR: runsDir,
    FARMSLOT_HOME: home,
    FARMSLOT_GATEWAY_PROFILE: 'proof',
    FARMSLOT_GATEWAY_PASSWORD: '',
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DEMO_POOL: '0',
    NODE_TEST_CONTEXT: '1',
    TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
  };
  for (const name of Object.keys(process.env))
    assert.ok(
      !name.startsWith('FARMSLOT_') || name in env || name.startsWith('FARMSLOT_CAPTURE_PROOF_'),
      `Refusing to start the proof gateway while ${name} is set in this shell: it would point this gateway at real farm state. Unset it and run again.`,
    );
  mkdirSync(env.FARMSLOT_PROJECTS_DIR, { recursive: true });
  mkdirSync(env.FARMSLOT_POOL_DIR, { recursive: true });
  // The gate loads the run's project config. Only its identity and task layout
  // matter here: this proof never prepares a slot or runs a project hook.
  const projectDir = path.join(env.FARMSLOT_PROJECTS_DIR, run.project);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    path.join(projectDir, 'project.json'),
    `${JSON.stringify(
      {
        name: run.project,
        repo_url: 'git@example.invalid:proof/checkout.git',
        default_branch: 'main',
        task_dir: 'temp/tasks',
        paths: { runtime_dir: 'temp/farmslot', artifact_dir: 'temp/tasks' },
      },
      null,
      2,
    )}\n`,
  );

  const logs: string[] = [];
  let gateway: ChildProcess | undefined;
  const rpc = (method: string, params: unknown): { stdout: string; failed: boolean } => {
    try {
      return {
        stdout: execFileSync(
          process.execPath,
          [
            path.join(source, 'apps/command-center/scripts/cdp.mjs'),
            'gateway',
            method,
            JSON.stringify(params),
          ],
          { cwd: source, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
        ),
        failed: false,
      };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return { stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`, failed: true };
    }
  };
  const checks: string[] = [];
  try {
    gateway = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url), 'serve'],
      {
        cwd: source,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    for (const stream of [gateway.stdout, gateway.stderr])
      stream?.on('data', (data) => logs.push(String(data)));
    const deadline = Date.now() + 90_000;
    for (;;) {
      assert.ok(gateway.exitCode === null, `Gateway exited: ${logs.join('').slice(-2500)}`);
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
      assert.ok(
        Date.now() < deadline,
        `Gateway never became healthy: ${logs.join('').slice(-2500)}`,
      );
      await pause(50);
    }

    const served = rpc('run.get', { runId });
    assert.equal(served.failed, false, served.stdout);
    const servedRun =
      (JSON.parse(served.stdout) as { data?: { run?: Run }; run?: Run }).data?.run ??
      (JSON.parse(served.stdout) as { run?: Run }).run;
    assert.equal(servedRun?.output?.captureError, original.output?.captureError);
    checks.push('the gateway serves the seeded record with its recorded capture failure');

    // The retained-artifact client path: this is where an operator meets the
    // refusal, and before this change it said only "Run artifacts are not retained."
    const artifacts = rpc('run.recipeRunsForRun', { runId });
    assert.equal(artifacts.failed, true, `Expected a refusal, got: ${artifacts.stdout}`);
    assert.match(artifacts.stdout, /RUN_ARTIFACTS_NOT_RETAINED/);
    assert.match(artifacts.stdout, /Run artifacts are not retained: Storage unavailable/);
    assert.match(artifacts.stdout, /is not mounted/);
    checks.push('run.recipeRunsForRun refuses over RPC with the recorded capture failure');

    // The completion gate's own refusal is not replayed here: `run.replayStep`
    // on COMPLETE reselects a slot and refuses with "Run changed while reading
    // replay device requirements" without a pool and slot binding, which this
    // scratch root deliberately does not have. That half is covered by the
    // gate-prerequisites tests and by the operator replay of 062f6a94 and
    // 7431f372 on the deployed build.
  } finally {
    if (gateway?.pid !== undefined && gateway.exitCode === null) {
      gateway.kill('SIGTERM');
      for (let waited = 0; gateway.exitCode === null && waited < 10_000; waited += 100)
        await pause(100);
      if (gateway.exitCode === null) gateway.kill('SIGKILL');
    }
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const check of checks) console.log(`PASS ${check}`);
  console.log(`PASS acceptance-unreadable capture proof (${checks.length} checks)`);
}
