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

// A finished signal is the opposite case: nothing is still running, and
// `mark start` refuses to re-open it (agent-runtime/scripts/mark-checklist-step.cjs).
// The clearing that makes a re-dispatch legitimate ran only for a native fresh
// restart, so on tmux the replayed worker met its own finished signal and had
// no way past it.
//
// `mark no-change` writes status `complete` with a disposition rather than a
// status of its own (resolveTerminalPreset), so that is the shape tested here,
// not an invented `no-change` status no worker writes.
const finishedSignals = [
  { name: 'complete', body: { attemptId: 'finished-attempt', status: 'complete' } },
  {
    name: 'no-change',
    body: {
      attemptId: 'finished-attempt',
      status: 'complete',
      outcome: 'success',
      disposition: 'not_reproducible',
    },
  },
];
type FixtureRun = ReturnType<typeof createRun>;
type RunUpdate = Parameters<typeof updateRun>[1];

const finishedRun = (run: FixtureRun, overrides: RunUpdate = {}): RunUpdate => ({
  status: 'done',
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
      status: 'complete',
      taskFile: '.task/probe/TASK.md',
      signalFile: '.task/probe/SIGNAL.json',
      signalAttemptId: 'finished-attempt',
      attemptStartedAt: '2026-11-12T00:00:00.000Z',
    },
  ],
  steps: run.steps.map((step) => ({
    ...step,
    status: ['find-slot', 'write-task', 'prepare', 'dispatch', 'monitor'].includes(step.name)
      ? 'done'
      : 'pending',
  })),
  ...overrides,
});
const heldSlotStatus = (run: FixtureRun) =>
  JSON.stringify({
    slots: [{ slot: slotId, lifecycle: 'held', phase: 'idle', current_run_id: run.id }],
  });
/** The signal as the replay left it, read at the engine handoff. */
const replayAndReadSignal = async (
  run: FixtureRun,
  stepName: string,
  hooks: Parameters<typeof runReplayStep>[2] = {},
  file: string = signalFile,
): Promise<string | null> => {
  let observe!: (value: string | null) => void;
  const observed = new Promise<string | null>((resolve) => {
    observe = resolve;
  });
  await runReplayStep({ runId: run.id, stepName, triggeredBy: 'operator' }, () => {}, {
    probeTaskSignal: async () => null,
    ...hooks,
    startEngine: async () => {
      observe(await readFile(file, 'utf8').catch(() => null));
    },
  });
  return observed;
};

for (const finished of finishedSignals) {
  test(`dispatch replay clears a ${finished.name} signal on tmux transport`, async (t) => {
    const run = createRun({ project, flowType: 'dev', ticketOrPr: 'example/fixture#2' });
    t.after(async () => {
      if (!getRun(run.id)) return;
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    });
    await writeFile(
      signalFile,
      JSON.stringify({ ...finished.body, timestamp: '2026-11-12T00:00:00.000Z' }),
    );
    updateRun(run.id, finishedRun(run));
    await writeFile(statusFile, heldSlotStatus(run));

    assert.equal(
      await replayAndReadSignal(run, 'dispatch'),
      null,
      'a replayed worker must not meet the finished signal its own start refuses',
    );
  });
}

// `start` resumes a blocked signal and keeps the checked boxes, so removing it
// would throw away the work the resumed worker is supposed to continue.
test('dispatch replay keeps a blocked signal', async (t) => {
  const run = createRun({ project, flowType: 'dev', ticketOrPr: 'example/fixture#3' });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  const blocked = JSON.stringify({
    attemptId: 'blocked-attempt',
    status: 'blocked',
    disposition: 'blocked',
    reason: 'waiting on an operator',
    timestamp: '2026-11-12T00:00:00.000Z',
  });
  await writeFile(signalFile, blocked);
  updateRun(run.id, finishedRun(run, { status: 'blocked' }));
  await writeFile(statusFile, heldSlotStatus(run));

  assert.equal(
    await replayAndReadSignal(run, 'dispatch'),
    blocked,
    'a blocked signal is resumable and must survive the replay',
  );
});

// `update-branch` has no prepare step, and the old gate demanded one, so a
// dispatch replay of that flow skipped the clear entirely — the same strand on
// a flow whose worker is required to call `mark start`.
test('update-branch dispatch replay clears a finished signal with no prepare step', async (t) => {
  const run = createRun({
    project,
    flowType: 'update-branch',
    ticketOrPr: 'example/fixture#4',
  });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  assert.equal(
    run.steps.some((step) => step.name === 'prepare'),
    false,
    'this flow is only interesting because it has no prepare step',
  );
  await writeFile(
    signalFile,
    JSON.stringify({
      attemptId: 'finished-attempt',
      status: 'complete',
      timestamp: '2026-11-12T00:00:00.000Z',
    }),
  );
  updateRun(run.id, finishedRun(run));
  await writeFile(statusFile, heldSlotStatus(run));

  assert.equal(
    await replayAndReadSignal(run, 'dispatch'),
    null,
    'a flow without prepare still launches a worker, so the finished signal must go',
  );
});

// A replay at or before write-task is safe for a different reason, and it is
// worth pinning: the task is regenerated into its own timestamped directory
// (tasks/writer.ts), so the replayed worker never sees the old signal whatever
// this clear does.
test('write-task replay regenerates the task rather than reusing the old one', async (t) => {
  const run = createRun({ project, flowType: 'dev', ticketOrPr: 'example/fixture#5' });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  await writeFile(
    signalFile,
    JSON.stringify({
      attemptId: 'finished-attempt',
      status: 'complete',
      timestamp: '2026-11-12T00:00:00.000Z',
    }),
  );
  updateRun(run.id, finishedRun(run));
  await writeFile(statusFile, heldSlotStatus(run));

  await replayAndReadSignal(run, 'write-task');

  assert.equal(
    getRun(run.id)?.taskFile ?? null,
    null,
    'the replay clears the task file so write-task regenerates it in a new directory',
  );
});

// Deciding and deleting are two round trips, and a worker repairing evidence
// with `./mark N` publishes a fresh `running` signal over the same path in
// between (mark-io.cjs renames into place). The delete re-reads each file, so
// what the decision saw cannot be what gets removed.
//
// This covers the gap between the two round trips only. The narrower window
// inside the delete — another process writing between its own read and unlink —
// is closed by renaming the candidate aside and judging the bytes that moved,
// which this suite cannot schedule and so does not prove.
test('a signal that goes live between the decision and the delete survives', async (t) => {
  const run = createRun({ project, flowType: 'dev', ticketOrPr: 'example/fixture#6' });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  await writeFile(
    signalFile,
    JSON.stringify({
      attemptId: 'finished-attempt',
      status: 'complete',
      timestamp: '2026-11-12T00:00:00.000Z',
    }),
  );
  updateRun(run.id, finishedRun(run));
  await writeFile(statusFile, heldSlotStatus(run));

  const live = JSON.stringify({
    attemptId: 'repairing-attempt',
    status: 'running',
    timestamp: '2026-11-12T00:00:01.000Z',
  });
  const observed = await replayAndReadSignal(run, 'dispatch', {
    beforeWorkerSignalDelete: async () => {
      await writeFile(signalFile, live);
    },
  });

  assert.equal(observed, live, 'the live signal must be the one the worker finds');
});

// A clear that died between moving a signal aside and deciding on it leaves the
// only copy under the aside name, where the worker never looks: it reads the
// original path. The sweep has to cover a name whose original is absent, which
// is the whole point of that state, and the first version of it only swept
// names it had already read as finished.
test('an aside left by an interrupted clear is restored even with no original', async (t) => {
  const run = createRun({ project, flowType: 'dev', ticketOrPr: 'example/fixture#7' });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  const stranded = JSON.stringify({
    attemptId: 'interrupted-attempt',
    status: 'running',
    timestamp: '2026-11-12T00:00:00.000Z',
  });
  await rm(signalFile, { force: true });
  await writeFile(`${signalFile}.replay-clear.99999`, stranded);
  updateRun(run.id, finishedRun(run));
  await writeFile(statusFile, heldSlotStatus(run));

  assert.equal(
    await replayAndReadSignal(run, 'dispatch'),
    stranded,
    'the only copy of that signal must come back to the path the worker reads',
  );
});
