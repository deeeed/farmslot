import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { taskInit } from '@farmslot/agent-runtime';
import { ACCEPTANCE_CONTRACT_INPUT } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'writer-handoff-owner-'));
const project = 'writer-handoff-proof';
const slotId = 'writer-handoff-slot';
const worker = path.join(root, 'worker');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_HOME: root,
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
await mkdir(path.join(root, 'pool'), { recursive: true });
await mkdir(path.join(root, 'projects', project, 'templates/worker'), { recursive: true });
await mkdir(worker);
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    project,
    platform: 'cli',
    slots: [{ id: slotId, repo: worker, session: slotId }],
  }),
);
await writeFile(
  path.join(root, 'projects', project, 'project.json'),
  JSON.stringify({
    name: project,
    task_dir: 'tasks',
    hooks: {},
    execution_templates: { sources: [] },
  }),
);
await writeFile(
  path.join(root, 'projects', project, 'templates/worker/pr-complete.md'),
  '---\nplatforms: [cli]\n---\n# Complete the PR\n\n- [ ] 1. Read the inherited task.\n- [ ] 2. Complete the task.\n',
);
after(() => rm(root, { recursive: true, force: true }));
await import('../runtime/mock-pty.test-support.js');
const store = await import('../runs/store.js');
const state = await import('../core/state.js');
const raw = await import('../methods/pr/raw-cache.js');
const getRaw: typeof raw.getPRRawData = async () => ({
  checksStdout: '[]',
  prStateStdout: '{}',
  commentsStdout: '',
  reviewCommentsStdout: '',
  latestCommitStdout: '',
  reviewMetaStdout: '',
  fetchedAt: 0,
});
mock.module('../methods/pr/raw-cache.js', { namedExports: { ...raw, getPRRawData: getRaw } });
const maintenance = await import('../run-engine/branch-maintenance.js');
mock.module('../run-engine/branch-maintenance.js', {
  namedExports: { ...maintenance, prepareBranchMaintenance: async () => ({}) },
});
const hosted = await import('./hosted-task-init.js');
let beforeAcceptanceWrite: () => Promise<void>;
let initializations = 0;
const initialize: typeof hosted.initializeHostedTaskOnSlot = async (_slot, directory, input) => {
  initializations++;
  const result = await taskInit({
    ...input.task,
    template: { sources: [], selection: input.template },
  });
  await cp(input.task.taskDir, directory, { recursive: true });
  await beforeAcceptanceWrite();
  return result.executionTemplate;
};
mock.module('./hosted-task-init.js', {
  namedExports: {
    ...hosted,
    initializeHostedTaskOnSlot: initialize,
    syncHostedTaskSidecars: async () => {},
  },
});
const writerModule: string = './writer.js?handoff-owner-regression';
const { writeTaskFile }: typeof import('./writer.js') = await import(writerModule);

const scenarios = [
  'parent-released',
  'parent-owned',
  'child-owned',
  'foreign-reservation',
] as const;
for (const [index, scenario] of scenarios.entries()) {
  test(`acceptance task write with ${scenario}`, async (t) => {
    const parent = store.createRun({
      project,
      flowType: 'fix-bug',
      mode: 'autonomous',
      ticketOrPr: `PROJ-${scenario}`,
      slotId,
      ticketData: {
        source: 'manual',
        title: 'Original work',
        description: 'Original request',
        acceptanceCriteria: ['Keep the original acceptance criterion'],
        affectedArea: '',
        stepsToReproduce: [],
        screenshots: [],
        labels: [],
      },
    });
    const child = store.createRun({
      project,
      flowType: 'pr-complete',
      mode: 'autonomous',
      ticketOrPr: `example/repo#${42 + index}`,
      slotId,
      parentRunId: parent.id,
      familyId: parent.familyId,
    });
    store.updateRun(child.id, { status: 'writing-task', acceptanceContractVersion: 1 });
    t.after(async () => {
      for (const run of [child, parent]) {
        store.updateRun(run.id, { status: 'cancelled' });
        await store.deleteRun(run.id);
      }
    });
    await writeFile(
      state.statusFile,
      JSON.stringify({
        slots: [
          {
            slot: slotId,
            current_run_id: scenario === 'child-owned' ? child.id : parent.id,
            handoff_run_id: scenario === 'child-owned' ? null : child.id,
            lifecycle: 'busy',
            phase: 'working',
            slot_epoch: 1,
          },
        ],
      }),
    );
    const before = initializations;
    beforeAcceptanceWrite = async () => {
      if (scenario === 'parent-released') {
        store.updateRun(parent.id, { status: 'done' });
        await state.transitionSlotStatus(slotId, (row) =>
          row.current_run_id === parent.id
            ? { fields: state.slotOwnershipReleaseFields(), endsOwnership: true }
            : null,
        );
      } else if (scenario === 'foreign-reservation') {
        await state.updateSlotStatus(slotId, {
          current_run_id: null,
          handoff_run_id: 'another-run',
        });
      }
    };
    if (scenario === 'foreign-reservation') {
      await assert.rejects(() => writeTaskFile(store.getRun(child.id)!), /lost its task owner/);
      assert.equal(store.getRun(child.id)!.acceptanceExecutionContract, undefined);
    } else {
      const task = await writeTaskFile(store.getRun(child.id)!);
      const contract = JSON.parse(
        await readFile(path.join(path.dirname(task), ACCEPTANCE_CONTRACT_INPUT), 'utf8'),
      );
      assert.equal(contract.runId, child.id);
      assert.equal(contract.revision, 1);
      assert.deepEqual(contract.inheritedCriterionIds, []);
      const row = await state.readSlotRow(slotId);
      assert.equal(row?.handoff_run_id, scenario === 'child-owned' ? null : child.id);
      if (scenario === 'parent-released') assert.equal(row?.current_run_id, null);
    }
    assert.equal(initializations, before + 1, 'the first write succeeds without a replay');
  });
}
