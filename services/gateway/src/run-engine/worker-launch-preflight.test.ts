import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

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
    agentRuntimeScriptForSlot: async () => '/fixture/scripts/task-init-cli.mjs',
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
