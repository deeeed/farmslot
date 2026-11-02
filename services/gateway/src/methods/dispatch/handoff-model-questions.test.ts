import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { primaryRoleForFlow, type Run } from '@farmslot/protocol';

import '../../runtime/mock-pty.test-support.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'handoff-model-questions-'));
for (const name of ['pool', 'home', 'runs', 'repo', 'projects/proof'])
  mkdirSync(path.join(root, name), { recursive: true });
Object.assign(process.env, {
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
});
after(() => rmSync(root, { recursive: true, force: true }));
const slotId = 'handoff-proof';
writeFileSync(
  path.join(root, 'pool/fixture.json'),
  JSON.stringify({
    machine: os.hostname(),
    host: 'localhost',
    project: 'proof',
    platform: 'cli',
    slots: [{ id: slotId, repo: path.join(root, 'repo'), session: 'proof' }],
  }),
);
writeFileSync(path.join(root, 'projects/proof/project.json'), JSON.stringify({ name: 'proof' }));
const store = await import('../../runs/store.js');
const core = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    readSlotField: async (_slot: string, field: string) => {
      const fields: Record<string, string> = { runner: 'claude', model: 'opus' };
      return fields[field] ?? null;
    },
  },
});
// Past the question-tool check, a dead worker ends the warm attempt with its own reason.
const lifecycle = await import('../../review/worker-lifecycle.js');
mock.module('../../review/worker-lifecycle.js', {
  namedExports: { ...lifecycle, isWorkerAlive: async () => false },
});
let liveOwner: string | undefined;
const fleet = await import('../../fleet/state.js');
mock.module('../../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadFleetStatus: async () => ({ slots: [{ slot: slotId, currentRunId: liveOwner }] }),
  },
});
const preview = await import('./preview.js');
mock.module('./preview.js', {
  namedExports: { ...preview, verifyBranchAffinityNudgeStillEligible: async () => null },
});
const warmModule: string = './warm-session-handoff.js?model-questions';
const nudgeModule: string = './nudge.js?model-questions';
const { warmSessionHandoffDispatch } = (await import(
  warmModule
)) as typeof import('./warm-session-handoff.js');
const { nudgeDispatch } = (await import(nudgeModule)) as typeof import('./nudge.js');

function terminalRun(mode: Run['mode']): Run {
  const run = store.createRun({
    flowType: 'pr-complete',
    project: 'proof',
    ticketOrPr: 'example/repo#1',
    runner: 'claude',
  });
  return store.updateRun(run.id, {
    slotId,
    mode,
    agentContexts: [
      {
        id: 'primary',
        runId: run.id,
        slotId,
        role: primaryRoleForFlow(run.flowType),
        label: 'Worker',
        status: 'working',
        modelQuestions: mode === 'autonomous' ? 'off' : 'on',
      },
    ],
  });
}
async function settle(...runs: Run[]) {
  for (const run of runs) {
    const terminal = store.updateRun(run.id, { status: 'done' });
    await store.persistRunNow(terminal, 'fixture cleanup');
    await store.deleteRun(run.id);
  }
}

for (const [from, to] of [
  ['interactive', 'autonomous'],
  ['autonomous', 'interactive'],
  ['autonomous', 'autonomous'],
] as const) {
  const changes = from !== to;
  test(`warm handoff from an ${from} worker to an ${to} run ${changes ? 'starts fresh' : 'may reuse it'}`, async (t) => {
    const parent = terminalRun(from);
    const child = terminalRun(to);
    t.after(() => settle(parent, child));
    const result = await warmSessionHandoffDispatch(
      {
        slotId,
        taskFile: path.join(root, 'TASK.md'),
        runId: child.id,
        ticketOrPr: 'example/repo#1',
        flowType: 'pr-complete',
        parentRunId: parent.id,
        runner: 'claude',
        model: 'opus',
      },
      () => undefined,
    );
    assert.equal(result.handedOff, false);
    assert.equal(
      !result.handedOff && result.reason,
      changes
        ? 'worker question tool differs or is unknown; fresh dispatch required'
        : 'worker session not alive',
    );
  });

  test(`a branch nudge from an ${from} worker to an ${to} run ${changes ? 'is refused' : 'passes the question-tool check'}`, async (t) => {
    const owner = terminalRun(from);
    const nudged = terminalRun(to);
    t.after(() => settle(owner, nudged));
    liveOwner = owner.id;
    await assert.rejects(
      nudgeDispatch(
        {
          slotId,
          taskFile: path.join(root, 'missing/TASK.md'),
          runId: nudged.id,
          ticketOrPr: 'example/repo#1',
          flowType: 'pr-complete',
        },
        () => undefined,
      ),
      changes ? /question tool/ : /Task file not found/,
    );
  });
}

for (const effective of ['on', undefined] as const)
  test(`warm handoff uses recorded setting ${effective}, not the parent run mode`, async (t) => {
    const parent = terminalRun('autonomous');
    store.updateRun(parent.id, {
      agentContexts: parent.agentContexts!.map((context) => ({
        ...context,
        modelQuestions: effective,
      })),
    });
    const child = terminalRun('autonomous');
    t.after(() => settle(parent, child));
    const result = await warmSessionHandoffDispatch(
      {
        slotId,
        taskFile: path.join(root, 'TASK.md'),
        runId: child.id,
        ticketOrPr: 'example/repo#1',
        flowType: 'pr-complete',
        parentRunId: parent.id,
        runner: 'claude',
        model: 'opus',
      },
      () => undefined,
    );
    assert.equal(result.handedOff, false);
    assert.equal(
      !result.handedOff && result.reason,
      'worker question tool differs or is unknown; fresh dispatch required',
    );
  });
