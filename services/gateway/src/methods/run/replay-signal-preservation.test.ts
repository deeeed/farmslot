import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const fixture = await mkdtemp(path.join(tmpdir(), 'rsp-'));
const project = 'replay-signal-proof';
const slotId = `${project}-1`;
const repo = path.join(fixture, 'repo');
const projectRoot = path.join(fixture, 'projects', project);
const taskFile = path.join(projectRoot, 'tasks', 'probe', 'TASK.md');
const signalFile = path.join(repo, '.task', 'probe', 'SIGNAL.json');
const previousEnvironment = new Map<string, string | undefined>();
for (const [key, value] of Object.entries({
  FARMSLOT_ROOT: fixture,
  FARMSLOT_HOME: path.join(fixture, 'home'),
  FARMSLOT_RUNS_DIR: path.join(fixture, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
  FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
  FARMSLOT_TEST_STATUS_FILE: path.join(fixture, 'status.json'),
  TMUX_TMPDIR: path.join(fixture, 't'),
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  NODE_TEST_CONTEXT: '1',
})) {
  previousEnvironment.set(key, process.env[key]);
  process.env[key] = value;
}
after(async () => {
  await rm(fixture, { recursive: true, force: true });
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
for (const directory of [
  path.dirname(taskFile),
  path.dirname(signalFile),
  path.join(fixture, 'pool'),
  path.join(fixture, 'scripts'),
  path.join(fixture, 'services', 'gateway'),
  path.join(fixture, 't'),
])
  await mkdir(directory, { recursive: true });
await writeFile(path.join(fixture, 'CLAUDE.md'), '# Private test fixture\n');
await writeFile(path.join(fixture, 'scripts', 'dev.sh'), '#!/bin/sh\n');
await writeFile(path.join(fixture, 'services', 'gateway', 'package.json'), '{"name":"fixture"}');
await writeFile(taskFile, '# Private task\n\n- [ ] Wait for the operator.\n');
await writeFile(
  path.join(projectRoot, 'project.json'),
  JSON.stringify({ name: project, paths: { runtime_dir: '.agent', artifact_dir: '.task' } }),
);
await writeFile(
  path.join(fixture, 'pool', 'local.json'),
  JSON.stringify({
    machine: hostname(),
    host: 'localhost',
    ssh_user: userInfo().username,
    project,
    platform: 'cli',
    slots: [{ id: slotId, repo, session: 'never-started', resources: {} }],
  }),
);

const { statusFile } = await import('../../core/state.js');
const { createRun, deleteRun, getRun, runsDirectory, updateRun } =
  await import('../../runs/store.js');
const { runReplayStep } = await import('./replay-step.js');
assert.equal(statusFile, path.join(fixture, 'status.json'));
assert.equal(runsDirectory(), path.join(fixture, 'runs'));

test('dispatch replay preserves the idle worker signal until replacement admission', async (t) => {
  const run = createRun({ project, flowType: 'dev', ticketOrPr: 'example/fixture#1' });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  const signal = JSON.stringify({
    attemptId: 'original-attempt',
    status: 'running',
    timestamp: '2026-11-12T00:00:00.000Z',
  });
  await writeFile(signalFile, signal);
  updateRun(run.id, {
    status: 'blocked',
    slotId,
    taskFile,
    transport: 'tmux',
    engineState: { taskInit: { taskFile, status: 'initialized' } },
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        label: 'Worker',
        runId: run.id,
        slotId,
        status: 'waiting',
        taskFile: '.task/probe/TASK.md',
        signalFile: '.task/probe/SIGNAL.json',
        signalAttemptId: 'original-attempt',
        attemptStartedAt: '2026-11-12T00:00:00.000Z',
      },
    ],
    steps: run.steps.map((step) => ({
      ...step,
      status: ['find-slot', 'write-task', 'prepare', 'dispatch'].includes(step.name)
        ? 'done'
        : step.name === 'monitor'
          ? 'running'
          : 'pending',
    })),
  });
  await writeFile(
    statusFile,
    JSON.stringify({
      slots: [
        {
          slot: slotId,
          lifecycle: 'held',
          phase: 'waiting',
          current_run_id: run.id,
        },
      ],
    }),
  );

  let observe!: (value: string | Error) => void;
  const observed = new Promise<string | Error>((resolve) => {
    observe = resolve;
  });
  await runReplayStep({ runId: run.id, stepName: 'dispatch', triggeredBy: 'operator' }, () => {}, {
    probeTaskSignal: async () => null,
    // Stop at the real engine handoff: admission has not replaced any worker.
    startEngine: async () => {
      try {
        observe(await readFile(signalFile, 'utf8'));
      } catch (error) {
        observe(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  const atAdmission = await observed;
  assert.equal(
    atAdmission,
    signal,
    'replay must leave the original signal intact before admission',
  );
  assert.equal(await readFile(signalFile, 'utf8'), signal);
});
