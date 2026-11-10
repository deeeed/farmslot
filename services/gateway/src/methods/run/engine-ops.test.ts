import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test, type TestContext } from 'node:test';

import '../../runtime/mock-pty.test-support.js';

const root = mkdtempSync(path.join(tmpdir(), 'activate-retained-'));
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_DISPATCH_PRESSURE_ADMISSION: 'off',
});
after(() => rmSync(root, { recursive: true, force: true }));
for (const dir of ['home', 'runs', 'pool', 'projects/demo', 'scripts', 'services/gateway'])
  mkdirSync(path.join(root, dir), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable activation fixture\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
writeFileSync(
  path.join(root, 'projects/demo/project.json'),
  JSON.stringify({ name: 'demo', task_dir: 'work-items', hooks: {} }),
);
writeFileSync(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'move-node',
    host: 'localhost',
    project: 'demo',
    platform: 'cli',
    slots: ['move-a', 'move-b'].map((id) => ({
      id,
      repo: path.join(root, id),
      session: id,
      resources: {},
    })),
  }),
);
const { createRun, deleteRun, getRun, updateRun } = await import('../../runs/store.js');

const core = await import('../../core/index.js');
const fleet = await import('../../fleet/state.js');
const replayStep = await import('./replay-step.js');
let replay: typeof replayStep.runReplayStep;
const rollbacks: Array<Record<string, unknown>> = [];
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    claimSlotStatusIf: async () => ({ claimed: true, epoch: 1 }),
    updateSlotStatusIf: async (
      _id: string,
      _predicate: unknown,
      fields: Parameters<typeof core.updateSlotStatusIf>[2],
    ) => {
      rollbacks.push(fields);
      return true;
    },
  },
});
mock.module('../../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadFleetStatus: async () => ({
      slots: [{ slot: 'move-b', machine: 'move-node', agent: 'idle', currentRunId: null }],
    }),
  },
});
mock.module('./replay-step.js', {
  namedExports: {
    ...replayStep,
    runReplayStep: (...args: Parameters<typeof replayStep.runReplayStep>) => replay(...args),
  },
});
const { runActivateOnSlot, runAutoRecoveryStop, runCIWatchPoke } = await import('./engine-ops.js');

async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) return;
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

test('runAutoRecoveryStop disables auto recovery and emits run update', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-auto-stop`,
  });
  t.after(() => cleanupRun(run.id));

  const events: string[] = [];
  const result = runAutoRecoveryStop({ runId: run.id }, (event) => {
    events.push(event);
  });

  assert.equal(result.run.autoRecoveryDisabled, true);
  assert.equal(result.run.recoveryProposal?.status, 'disabled');
  assert.deepEqual(events, ['run.updated']);
});

test('runCIWatchPoke surfaces missing runs before poking monitor state', () => {
  assert.throws(() => runCIWatchPoke({ runId: 'missing-ci-watch' }), /Run not found/);
});

for (const fails of [false, true]) {
  test(`activate-on-slot ${fails ? 'rolls back' : 'moves'} the stored pin with the binding`, async (t) => {
    const previousPressure = process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION;
    process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = 'off';
    t.after(() => {
      if (previousPressure === undefined) delete process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION;
      else process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = previousPressure;
    });
    const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'PROJ-383-move' });
    t.after(() => cleanupRun(run.id));
    updateRun(run.id, { status: 'failed', slotId: 'move-a', requestedSlotId: 'move-a' });
    rollbacks.length = 0;
    replay = async () => {
      assert.equal(getRun(run.id)?.slotId, 'move-b');
      assert.equal(getRun(run.id)?.requestedSlotId, 'move-b');
      if (fails) throw new Error('replay refused');
      return { run: getRun(run.id)! };
    };
    const activate = () => runActivateOnSlot({ runId: run.id, slotId: 'move-b' }, () => {});
    if (fails) await assert.rejects(activate, /replay refused/);
    else await activate();
    assert.equal(getRun(run.id)?.slotId, fails ? 'move-a' : 'move-b');
    assert.equal(getRun(run.id)?.requestedSlotId, fails ? 'move-a' : 'move-b');
    assert.deepEqual(rollbacks, fails ? [{ current_run_id: null }] : []);
  });
}

async function retainedTask(t: TestContext, slotId = 'move-a') {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'RESTORE-1' });
  t.after(() => cleanupRun(run.id));
  const dir = path.join(root, 'gateway-tasks/dev', run.id);
  const files = {
    'TASK.md': '# Original task\n',
    'CHECKLIST.md': '- [ ] Original check\n',
    mark: '#!/usr/bin/env bash\n',
    'inputs/handoff.json': JSON.stringify({ attemptId: run.id, project: 'demo', flow: 'dev' }),
    'artifacts/harness-provenance.json': '{"pin":"original"}\n',
    'artifacts/report.md': 'Original worker report\n',
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  const taskFile = path.join(dir, 'TASK.md');
  const baseline = 'a'.repeat(40);
  updateRun(run.id, {
    status: 'failed',
    slotId,
    requestedSlotId: slotId,
    taskFile,
    worktreeHeadAtDispatch: baseline,
    engineState: { taskInit: { taskFile, status: 'initialized' } },
  });
  const { captureRunOutput } = await import('../../run-completion/output.js');
  await captureRunOutput(run.id, false, true);
  assert.ok(getRun(run.id)?.artifactBundle, 'fixture must have a retained bundle');
  await rm(path.join(dir, 'artifacts'), { recursive: true });
  rollbacks.length = 0;
  return {
    run,
    dir,
    files,
    taskFile,
    baseline,
    destination: path.join(root, 'move-b/work-items/dev', run.id),
  };
}

for (const destination of ['empty', 'already-rebound', 'missing-receipt'] as const) {
  test(`activation stages retained task before prepare when destination is ${destination}`, async (t) => {
    const f = await retainedTask(t, destination === 'empty' ? 'move-a' : 'move-b');
    if (destination === 'empty') await mkdir(f.destination, { recursive: true });
    if (destination === 'missing-receipt') await cp(f.dir, f.destination, { recursive: true });
    replay = async (params, _emit, hooks) => {
      assert.equal(params.stepName, 'prepare');
      assert.equal(hooks?.preserveDispatchBaseline, true);
      const current = getRun(f.run.id)!;
      assert.equal(current.slotId, 'move-b');
      assert.equal(current.requestedSlotId, 'move-b');
      assert.equal(current.taskFile, f.taskFile);
      assert.deepEqual(current.engineState?.taskInit, {
        taskFile: f.taskFile,
        status: 'initialized',
      });
      assert.equal(current.worktreeHeadAtDispatch, f.baseline);
      for (const [file, content] of Object.entries(f.files))
        assert.equal(await readFile(path.join(f.destination, file), 'utf8'), content);
      return { run: current };
    };
    await runActivateOnSlot({ runId: f.run.id, slotId: 'move-b' }, () => {});
    assert.deepEqual(rollbacks, []);
  });
}

test('same-slot activation preserves newer worker documents when the task receipt exists', async (t) => {
  const f = await retainedTask(t, 'move-b');
  for (const [file, content] of Object.entries(f.files)) {
    await mkdir(path.dirname(path.join(f.destination, file)), { recursive: true });
    await writeFile(path.join(f.destination, file), content);
  }
  await writeFile(path.join(f.destination, 'TASK.md'), '# Newer worker document\n');
  await writeFile(path.join(f.destination, 'CHECKLIST.md'), '- [x] Worker progress\n');
  replay = async () => {
    assert.equal(
      await readFile(path.join(f.destination, 'TASK.md'), 'utf8'),
      '# Newer worker document\n',
    );
    assert.equal(
      await readFile(path.join(f.destination, 'CHECKLIST.md'), 'utf8'),
      '- [x] Worker progress\n',
    );
    return { run: getRun(f.run.id)! };
  };
  await runActivateOnSlot({ runId: f.run.id }, () => {});
  assert.deepEqual(rollbacks, []);
});

test('activation rolls back the binding and claim when retained task staging fails', async (t) => {
  const f = await retainedTask(t);
  await writeFile(path.join(f.dir, 'inputs/handoff.json'), '{"attemptId":"replacement"}\n');
  replay = async () => {
    assert.fail('prepare replay must not start after staging fails');
  };
  await assert.rejects(
    runActivateOnSlot({ runId: f.run.id, slotId: 'move-b' }, () => {}),
    /task file copy to slot failed: Retained task inputs differ/,
  );
  assert.equal(getRun(f.run.id)?.slotId, 'move-a');
  assert.equal(getRun(f.run.id)?.requestedSlotId, 'move-a');
  assert.deepEqual(rollbacks, [{ current_run_id: null }]);
});
