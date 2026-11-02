import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isRecord, type Run, type RunStep } from '@farmslot/protocol';

import type { ProjectVars } from '../core/config.js';
import { makeVars } from '../runners/test-fixtures.js';

await import('../runtime/mock-pty.test-support.js');
const root = await mkdtemp(path.join(os.tmpdir(), 'launch-binding-'));
process.env.FARMSLOT_HOME = root;
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
after(() => rm(root, { recursive: true, force: true }));
const checkout = path.join(root, 'checkout');
const configuredPath = path.join(root, 'configured-checkout');
await mkdir(checkout);
await symlink(checkout, configuredPath);
const vars = makeVars({ remoteRepo: configuredPath });
const project: ProjectVars = {
  projectName: vars.projectName,
  projectConfig: path.join(root, 'project.json'),
  projectFixturesDir: path.join(root, 'fixtures'),
  projectTemplatesDir: path.join(root, 'templates'),
  projectJson: {},
  runtimeDir: 'temp/farmslot',
  artifactDir: 'artifacts',
};
const workerEnvironmentScript = fileURLToPath(
  new URL('../../../../packages/agent-runtime/scripts/native-worker-env.cjs', import.meta.url),
);
const { nativeWorkerProcessEnvironment, projectToolsFirst } = createRequire(import.meta.url)(
  workerEnvironmentScript,
) as {
  nativeWorkerProcessEnvironment(
    environment: { set: Record<string, string>; unset: string[] },
    base: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv;
  projectToolsFirst(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
};
const config = await import('../core/config.js');
const state = await import('../core/state.js');
const execution = await import('../core/exec.js');
const runtimeScript = await import('../tasks/agent-runtime-script.js');
const store = await import('../runs/store.js');
const capabilities = await import('../methods/runtime-capabilities.js');
let selectedVars = vars;
const commands: string[] = [];
let currentRun: Run | undefined;
let duringSlotRead: (() => void) | undefined;
beforeEach(() => {
  selectedVars = vars;
  currentRun = undefined;
  duringSlotRead = undefined;
  commands.length = 0;
});
function runFixture(): Run {
  return {
    id: 'preflight-run',
    familyId: 'preflight-family',
    project: vars.projectName,
    flowType: 'dev',
    mode: 'interactive',
    lane: 'production',
    status: 'dispatching',
    slotId: vars.slotId,
    ticketOrPr: 'fixture',
    branch: null,
    taskFile: null,
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'scripted', model: 'scripted' },
    steps: [
      {
        name: 'dispatch',
        status: 'running',
        outputs: {
          retainedOutput: true,
          subSteps: [{ name: 'earlier', outcome: 'ok', durationMs: 1 }],
        },
      },
    ],
  };
}
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => selectedVars,
    loadProjectVars: async () => project,
  },
});
mock.module('../core/state.js', {
  namedExports: {
    ...state,
    readSlotRow: async () => {
      duringSlotRead?.();
      return null;
    },
  },
});
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: () => currentRun,
    updateRunStep: (_id: string, name: string, patch: Partial<RunStep>) => {
      assert(currentRun);
      const step = currentRun.steps.find((entry) => entry.name === name);
      assert(step);
      Object.assign(step, patch);
      return currentRun;
    },
  },
});
mock.module('../methods/runtime-capabilities.js', {
  namedExports: { ...capabilities, runtimeCapabilityStatus: async () => ({ leases: [] }) },
});
mock.module('../tasks/agent-runtime-script.js', {
  namedExports: {
    ...runtimeScript,
    agentRuntimeScriptForSlot: async (_vars: unknown, filename: string) =>
      filename === 'native-worker-env.cjs'
        ? workerEnvironmentScript
        : '/fixture/scripts/task-init-cli.mjs',
  },
});
mock.module('../core/exec.js', {
  namedExports: {
    ...execution,
    execOnSlot: async (_vars: unknown, command: string) => {
      commands.push(command);
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify(
          command.includes('nodeMissing')
            ? {
                packageManager: null,
                requirements: [],
                tools: {
                  node: { version: '24.22.1' },
                  packageManager: {},
                  packageManagerNode: {},
                  ruby: {},
                },
              }
            : { status: 'verified', detail: 'fixture retained inputs match' },
        ),
      };
    },
  },
});
const modulePath: string = './worker-launch-preflight.js?binding-regression';
const {
  admitWorkerLaunch,
  WorkerLaunchInputsChangedError,
}: typeof import('./worker-launch-preflight.js') = await import(modulePath);

test('native realpath-normalized checkout admits and still fences a later config change', async () => {
  const nativeVars = { ...vars, remoteRepo: await realpath(configuredPath) };
  assert.notEqual(nativeVars.remoteRepo, configuredPath);
  const fence = await admitWorkerLaunch({
    vars: nativeVars,
    projectVars: project,
    environment: { set: { PREFLIGHT_FIXTURE: 'native' }, unset: [] },
  });
  await fence();
  assert.equal(commands.length, 2);
  assert.ok(commands.every((command) => command.includes(nativeVars.remoteRepo)));
  selectedVars = { ...vars, remoteRepo: path.join(root, 'other-checkout') };
  await assert.rejects(
    fence(),
    (error) =>
      error instanceof WorkerLaunchInputsChangedError &&
      /Worker launch inputs changed during preflight/.test(error.message),
  );
});

test('a native launch probe resolves the same Node as the native worker environment (F318)', async (t) => {
  const nativeVars = { ...vars, remoteRepo: await realpath(configuredPath) };
  await (
    await admitWorkerLaunch({
      vars: nativeVars,
      projectVars: project,
      environment: { set: { PREFLIGHT_FIXTURE: 'native' }, unset: [] },
    })
  )();
  const probe = commands.find((command) => command.includes('nodeMissing'));
  assert.ok(probe);
  // A host like macpro: Homebrew's node first on PATH, the project's Node behind asdf's shims.
  // Homebrew's node may run the environment helper; the probe itself must not reach it.
  const home = await mkdtemp(path.join(os.tmpdir(), 'native-toolchain-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const brew = path.join(home, 'homebrew-bin');
  const shims = path.join(home, '.asdf', 'shims');
  await mkdir(brew);
  await mkdir(shims, { recursive: true });
  await writeFile(
    path.join(brew, 'node'),
    `#!/bin/sh\ncase "$1" in */native-worker-env.cjs) exec ${process.execPath} "$@";; esac\necho homebrew node answered >&2\nexit 97\n`,
  );
  await writeFile(path.join(shims, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  await chmod(path.join(brew, 'node'), 0o755);
  await chmod(path.join(shims, 'node'), 0o755);
  const host = { HOME: home, PATH: `${brew}:/usr/bin:/bin` };
  // The worker's final environment, as the native host builds it: the runner's own directory
  // (here one holding the Node it was installed with) ahead of PATH, then project tools first.
  const runnerDirectory = path.join(home, 'runner-bin');
  await mkdir(runnerDirectory);
  await writeFile(path.join(runnerDirectory, 'node'), '#!/bin/sh\nexit 98\n');
  await chmod(path.join(runnerDirectory, 'node'), 0o755);
  const workerEnvironment = nativeWorkerProcessEnvironment({ set: {}, unset: [] }, host);
  const worker = spawnSync('/bin/sh', ['-c', 'command -v node'], {
    env: projectToolsFirst({
      ...workerEnvironment,
      PATH: `${runnerDirectory}:${workerEnvironment.PATH}`,
    }),
    encoding: 'utf8',
  });
  assert.equal(worker.stdout.trim(), path.join(shims, 'node'));
  const result = spawnSync('/bin/sh', ['-c', probe], { env: host, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).tools.node.version, process.version);
});

test('the native worker environment wrapper keeps a probe output, status and missing Node', () => {
  const run = (environment: object, command: string) =>
    spawnSync(
      process.execPath,
      [workerEnvironmentScript, JSON.stringify(environment), '/bin/sh', '-c', command],
      { encoding: 'utf8' },
    );
  const failed = run({ set: {}, unset: [] }, 'printf probe-output; exit 3');
  assert.equal(failed.stdout, 'probe-output');
  assert.equal(failed.status, 3);
  // A launch whose PATH holds no Node reaches the toolchain probe's own report.
  const missing = run(
    { set: { PATH: '/usr/bin:/bin', HOME: os.tmpdir() }, unset: ['ASDF_DATA_DIR'] },
    "command -v node >/dev/null 2>&1 && echo found || printf '%s' '{\"nodeMissing\":true}'",
  );
  assert.deepEqual(JSON.parse(missing.stdout), { nodeMissing: true });
});

test('a returned relaunch fence rejects cancellation during its last asynchronous read', async () => {
  currentRun = runFixture();
  const fence = await admitWorkerLaunch({
    runId: currentRun.id,
    vars,
    projectVars: project,
    wrapCommand: (command) => command,
  });
  duringSlotRead = () => {
    assert(currentRun);
    currentRun.status = 'cancelled';
  };
  await assert.rejects(fence(), /preflight was superseded/);
});

test('native recovery and fix relaunch outcomes survive transient detail clearing without a collector', async () => {
  currentRun = runFixture();
  currentRun.steps[0].status = 'done';
  currentRun.steps.push({ name: 'watch-worker', status: 'running' });
  await admitWorkerLaunch({
    runId: currentRun.id,
    vars: { ...vars, remoteRepo: await realpath(configuredPath) },
    projectVars: project,
    wrapCommand: (command) => command,
  });
  const step = currentRun.steps[0];
  // The watch owner replaces its own outputs when it completes.
  Object.assign(currentRun.steps[1], { status: 'done', detail: undefined, outputs: {} });
  assert.equal(step.outputs?.retainedOutput, true);
  const rows = step.outputs?.subSteps;
  assert(Array.isArray(rows));
  assert.equal(rows.length, 4);
  for (const name of ['code', 'toolchain', 'leftovers']) {
    const row: unknown = rows.find(
      (entry: unknown) => isRecord(entry) && entry.name === `preflight-${name}`,
    );
    assert(isRecord(row));
    assert.equal(row.outcome, name === 'toolchain' ? 'skipped' : 'ok');
    assert.match(String(row.detail), /attempts=1/);
  }
});
