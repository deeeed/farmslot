import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  AGENT_ROLES,
  type AgentContext,
  agentContextTaskFile,
  agentDispatchWindow,
  agentRoleWindow,
  primaryRoleForFlow,
  signalFileForTask,
} from '@farmslot/protocol';

import { poolDir } from '../core/config.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';

import {
  getAgentContexts,
  markAgentContextStatus,
  resolveAgentTarget,
  selectAgentContext,
  summarizeAgentContexts,
  synthesizePrimaryContext,
  upsertAgentContext,
} from './contexts.js';

const testPoolFile = path.join(poolDir, `agent-contexts-fixture-${process.pid}.json`);

before(() => {
  mkdirSync(poolDir, { recursive: true });
  writeFileSync(
    testPoolFile,
    JSON.stringify(
      {
        machine: 'agent-contexts-test',
        project: 'example-browser-farm',
        platform: 'browser',
        os: 'darwin',
        host: 'localhost',
        ssh_user: 'test',
        slots: [
          {
            id: 'runner-browser-1',
            repo: '/tmp/farmslot-agent-contexts',
            session: 'mme-1',
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );
});

after(() => {
  rmSync(testPoolFile, { force: true });
});

async function cleanupRun(runId: string): Promise<void> {
  try {
    updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  } catch {
    // Test teardown only: a run that was already marked terminal or deleted
    // by the test body throws here. We intentionally swallow because the only
    // goal is to leave the run-store clean for the next test, and the test
    // assertions have already run.
    return;
  }
  await deleteRun(runId);
}

test('primaryRoleForFlow maps review and bugfix worker flows to role labels', () => {
  assert.equal(primaryRoleForFlow('review-pr'), 'review');
  assert.equal(primaryRoleForFlow('fix-bug'), 'fix-bug');
  assert.equal(primaryRoleForFlow('dev'), 'dev');
});

test('non-primary roles with dedicated windows have a tmux window mapping', () => {
  const ROLES_WITHOUT_OWN_WINDOW: Set<string> = new Set(['self-review-fix']);
  for (const role of AGENT_ROLES) {
    if (role === 'primary' || ROLES_WITHOUT_OWN_WINDOW.has(role)) continue;
    assert.equal(typeof agentRoleWindow(role), 'string', `${role} must define a window`);
  }
  assert.equal(
    agentRoleWindow('self-review-fix'),
    null,
    'self-review-fix runs in the primary worker window',
  );
  assert.equal(agentRoleWindow('primary'), null, 'primary is not a disposable role window');
  assert.equal(agentDispatchWindow('primary'), 'worker', 'primary dispatch has a canonical target');
});

test('synthesizePrimaryContext stores SIGNAL.json beside TASK.md', async (t) => {
  const run = createRun({
    flowType: 'review-pr',
    project: 'example-browser-farm',
    ticketOrPr: 'example-org/example-browser#1',
    slotId: 'runner-browser-1',
    taskFile: '.task/review/pr-1/TASK.md',
  });
  t.after(() => cleanupRun(run.id));

  const context = synthesizePrimaryContext(run);
  assert.equal(context?.role, 'review');
  assert.equal(context?.signalFile, '.task/review/pr-1/SIGNAL.json');
});

test('synthesizePrimaryContext does not persist orchestrator-absolute task paths', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-absolute`,
    slotId: 'runner-browser-1',
    taskFile: '/tmp/orchestrator/projects/example-browser-farm/tasks/fix/TASK.md',
  });
  t.after(() => cleanupRun(run.id));

  const context = synthesizePrimaryContext(run);
  assert.equal(context?.taskFile, null);
  assert.equal(context?.signalFile, null);
});

test('signalFileForTask only derives sibling signals for scoped task paths', () => {
  assert.equal(signalFileForTask('TASK.md'), null);
  assert.equal(signalFileForTask('.task/review/TASK.md'), '.task/review/SIGNAL.json');
  assert.equal(signalFileForTask('/repo/.task/review/TASK.md'), null);
  assert.equal(signalFileForTask('.task.with.dots/TASK.md'), '.task.with.dots/SIGNAL.json');
});

test('agentContextTaskFile keeps only worker-relative scoped task files', () => {
  assert.equal(agentContextTaskFile('/Users/me/farmslot/projects/app/tasks/fix/TASK.md'), null);
  assert.equal(agentContextTaskFile('TASK.md'), null);
  assert.equal(agentContextTaskFile('.task/review/TASK.md'), '.task/review/TASK.md');
  assert.equal(
    agentContextTaskFile('/orchestrator/TASK.md', '.task/fix/SELF-REVIEW.md'),
    '.task/fix/SELF-REVIEW.md',
  );
  assert.equal(
    agentContextTaskFile('.task/fix/TASK.md', '/orchestrator/SELF-REVIEW.md'),
    '.task/fix/TASK.md',
  );
  assert.equal(
    agentContextTaskFile('.task/fix/TASK.md', '.task/fix/SELF-REVIEW.md'),
    '.task/fix/TASK.md',
  );
});

test('selectAgentContext treats primary selector as the flow-owned worker role', async (t) => {
  const run = createRun({
    flowType: 'review-pr',
    project: 'example-browser-farm',
    ticketOrPr: 'example-org/example-browser#2',
    slotId: 'runner-browser-1',
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Review',
        status: 'working',
        slotId: 'runner-browser-1',
        runId: run.id,
      },
    ],
  });

  assert.equal(selectAgentContext(updateRun(run.id, {}), { role: 'primary' })?.role, 'review');
});

test('selectAgentContext synthesizes flow role when persisted contexts are empty', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-browser-farm',
    ticketOrPr: 'example-org/example-browser#3',
    slotId: 'runner-browser-1',
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, { agentContexts: [] });

  assert.equal(getAgentContexts(updateRun(run.id, {}))[0]?.role, 'dev');
  assert.equal(selectAgentContext(updateRun(run.id, {}), { role: 'primary' })?.role, 'dev');
});

test('selectAgentContext returns null for missing explicit non-primary selectors', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-missing-review`,
    slotId: 'runner-browser-1',
  });
  t.after(() => cleanupRun(run.id));

  assert.equal(selectAgentContext(run, { role: 'review' }), null);
  assert.equal(selectAgentContext(run, { contextId: 'review' }), null);
});

test('selectAgentContext does not promote arbitrary secondary context to primary', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-primary-fallback`,
    slotId: 'runner-browser-1',
  });
  t.after(() => cleanupRun(run.id));
  const updated = updateRun(run.id, {
    agentContexts: [
      {
        id: 'self-review',
        role: 'self-review',
        label: 'Self-review',
        status: 'working',
        slotId: 'runner-browser-1',
        runId: run.id,
      },
    ],
  });

  assert.equal(selectAgentContext(updated, { role: 'primary' }), null);
  assert.equal(selectAgentContext(updated), null);
});

test('summarizeAgentContexts emits an explicit public field allowlist', () => {
  const context: AgentContext = {
    id: 'review',
    role: 'review',
    label: 'Review',
    status: 'working',
    slotId: 'slot-1',
    runId: 'run-1',
    taskFile: '.task/review/TASK.md',
    signalFile: '.task/review/SIGNAL.json',
    runner: 'codex',
    model: 'gpt',
    lastSignalAt: '2026-04-25T00:00:00Z',
    startedAt: '2026-04-25T00:00:00Z',
    updatedAt: '2026-04-25T00:01:00Z',
    completedAt: '2026-04-25T00:02:00Z',
  };
  const summary = summarizeAgentContexts({
    agentContexts: [context],
  });

  assert.deepEqual(
    Object.keys(summary[0]).sort(),
    [
      'ctxPct',
      'id',
      'label',
      'lastSignalAt',
      'model',
      'nudgeCount',
      'role',
      'runId',
      'runner',
      'signalFile',
      'status',
      'target',
      'taskFile',
      'updatedAt',
    ].sort(),
  );
  assert.equal('slotId' in summary[0], false);
  assert.equal('startedAt' in summary[0], false);
  assert.equal('completedAt' in summary[0], false);
});

test('upsertAgentContext keeps independent role contexts across rapid updates', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
    slotId: 'runner-browser-1',
  });
  t.after(() => cleanupRun(run.id));

  await upsertAgentContext(run.id, 'fix-bug', { status: 'working', taskFile: 'fix/TASK.md' });
  await upsertAgentContext(run.id, 'review', { status: 'working', taskFile: 'review/TASK.md' });
  await upsertAgentContext(run.id, 'ci-fix', { status: 'waiting', taskFile: 'ci/TASK.md' });

  const roles = updateRun(run.id, {})
    .agentContexts?.map((ctx) => ctx.role)
    .sort();
  assert.deepEqual(roles, ['ci-fix', 'fix-bug', 'review']);
});

test('upsertAgentContext keeps independent role contexts across concurrent microtasks', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-concurrent`,
    slotId: 'runner-browser-1',
  });
  t.after(() => cleanupRun(run.id));

  await Promise.all([
    Promise.resolve().then(() =>
      upsertAgentContext(run.id, 'fix-bug', { status: 'working', taskFile: 'fix/TASK.md' }),
    ),
    Promise.resolve().then(() =>
      upsertAgentContext(run.id, 'ci-fix', { status: 'waiting', taskFile: 'ci/TASK.md' }),
    ),
  ]);

  const roles = updateRun(run.id, {})
    .agentContexts?.map((ctx) => ctx.role)
    .sort();
  assert.deepEqual(roles, ['ci-fix', 'fix-bug']);
});

test('markAgentContextStatus timestamps terminal states and clears stale completion on restart', async (t) => {
  const run = createRun({
    flowType: 'review-pr',
    project: 'example-browser-farm',
    ticketOrPr: `example-org/example-browser#${Date.now()}`,
    slotId: 'runner-browser-1',
  });
  t.after(() => cleanupRun(run.id));

  await markAgentContextStatus(run.id, 'review', 'complete', {
    lastSignalAt: '2026-04-25T00:00:00Z',
  });
  const completed = updateRun(run.id, {}).agentContexts?.find((ctx) => ctx.role === 'review');
  assert.equal(completed?.status, 'complete');
  assert.ok(completed?.completedAt);

  await markAgentContextStatus(run.id, 'review', 'working');
  const restarted = updateRun(run.id, {}).agentContexts?.find((ctx) => ctx.role === 'review');
  assert.equal(restarted?.status, 'working');
  assert.equal(restarted?.completedAt, undefined);
  assert.equal(restarted?.lastSignalAt, undefined);
});

test('resolveAgentTarget prefers explicit and persisted role targets', async (t) => {
  const direct = await resolveAgentTarget('runner-browser-1', {
    target: 'mme-1:2.0',
    role: 'review',
  });
  assert.deepEqual(direct, {
    target: 'mme-1:2.0',
    session: 'mme-1',
    role: 'review',
    contextId: 'review',
  });

  assert.deepEqual(await resolveAgentTarget('runner-browser-1', { role: 'primary' }), {
    target: 'mme-1',
    session: 'mme-1',
    role: 'primary',
    contextId: 'primary',
  });

  const run = createRun({
    flowType: 'review-pr',
    project: 'example-browser-farm',
    ticketOrPr: `example-org/example-browser#${Date.now()}`,
    slotId: 'runner-browser-1',
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Review',
        status: 'working',
        slotId: 'runner-browser-1',
        runId: run.id,
        target: { session: 'mme-1', window: 'review', pane: '0', target: 'mme-1:review.0' },
      },
    ],
  });

  assert.deepEqual(
    await resolveAgentTarget('runner-browser-1', { runId: run.id, contextId: 'review' }),
    {
      target: 'mme-1:review',
      session: 'mme-1',
      role: 'review',
      contextId: 'review',
    },
  );
  assert.deepEqual(
    await resolveAgentTarget('runner-browser-1', { runId: run.id, role: 'primary' }),
    {
      target: 'mme-1:review',
      session: 'mme-1',
      role: 'review',
      contextId: 'review',
    },
  );
});

test('resolveAgentTarget rejects mismatched explicit target and role selectors', async () => {
  await assert.rejects(
    () => resolveAgentTarget('runner-browser-1', { target: 'mme-1:review', role: 'self-review' }),
    /target mme-1:review belongs to role review, not self-review/,
  );
  await assert.rejects(
    () =>
      resolveAgentTarget('runner-browser-1', {
        target: 'mme-1:self-review',
        role: 'review',
        contextId: 'self-review',
      }),
    /context self-review does not match role review/,
  );
  await assert.rejects(
    () => resolveAgentTarget('runner-browser-1', { target: 'mme-1:ci-fix', contextId: 'review' }),
    /target mme-1:ci-fix belongs to context ci-fix, not review/,
  );
  await assert.rejects(
    () =>
      resolveAgentTarget('runner-browser-1', {
        target: 'mme-1:bugfix',
        contextId: 'bugfix',
      }),
    /target mme-1:bugfix belongs to context fix-bug, not bugfix/,
  );
  await assert.rejects(
    () =>
      resolveAgentTarget('runner-browser-1', {
        target: 'mme-1:rev-claude',
        contextId: 'rev-codex',
        role: 'self-review',
      }),
    /target mme-1:rev-claude belongs to context rev-claude, not rev-codex/,
  );
});

test('resolveAgentTarget refuses ambiguous active runs for explicit non-primary roles', async (t) => {
  const slotId = `ambiguous-slot-${Date.now()}`;
  const first = createRun({
    flowType: 'fix-bug',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-ambiguous-a`,
    slotId,
  });
  const second = createRun({
    flowType: 'fix-bug',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-ambiguous-b`,
    slotId,
  });
  t.after(async () => {
    await cleanupRun(first.id);
    await cleanupRun(second.id);
  });

  // Explicit non-primary role: must fail loudly so the caller sees the
  // ambiguity instead of attaching to whichever run was guessed first.
  await assert.rejects(
    () => resolveAgentTarget(slotId, { role: 'review' }),
    /multiple active runs.*refusing to guess/,
  );
});

test('resolveAgentTarget degrades to bare session for ambiguous primary-role default', async (t) => {
  // The UI passes `role: 'primary'` as the default for unselected role tabs
  // (slot-view → terminal-view._targetParams). This MUST NOT throw on a
  // legacy slot that briefly carries two active runs during recovery — the
  // helper must degrade so the terminal pane stays attached to the bare
  // session view instead of crashing the whole subscribe pipeline.
  const slotId = `ambiguous-slot-primary-${Date.now()}`;
  const first = createRun({
    flowType: 'fix-bug',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-ambig-prim-a`,
    slotId,
  });
  const second = createRun({
    flowType: 'fix-bug',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-ambig-prim-b`,
    slotId,
  });
  t.after(async () => {
    await cleanupRun(first.id);
    await cleanupRun(second.id);
  });

  // The call may still reject for unrelated reasons (loadSlotVars cannot find
  // the synthetic slot in the pool config). What MUST NOT happen is the
  // ambiguity throw cascading out — that is the regression this test guards
  // against.
  let caught: unknown;
  try {
    await resolveAgentTarget(slotId, { role: 'primary' });
  } catch (err) {
    caught = err;
  }
  if (caught) {
    assert.doesNotMatch((caught as Error).message, /multiple active runs.*refusing to guess/);
  }
});

test('resolveAgentTarget rejects missing explicit non-primary roles', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-missing-target`,
    slotId: 'runner-browser-1',
  });
  t.after(() => cleanupRun(run.id));

  await assert.rejects(
    () => resolveAgentTarget('runner-browser-1', { runId: run.id, role: 'review' }),
    /No active agent role review/,
  );
});

test('resolveAgentTarget falls back to bare session for persisted contexts without captured targets', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-null-target`,
    slotId: 'runner-browser-1',
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    agentContexts: [
      {
        id: 'fix-bug',
        role: 'fix-bug',
        label: 'Bugfix',
        status: 'working',
        slotId: 'runner-browser-1',
        runId: run.id,
        target: null,
      },
    ],
  });

  // Contexts without stored targets (legacy or pre-capture) resolve to the bare
  // session rather than guessing a role window that may not exist.
  assert.deepEqual(
    await resolveAgentTarget('runner-browser-1', { runId: run.id, role: 'primary' }),
    {
      target: 'mme-1',
      session: 'mme-1',
      role: 'fix-bug',
      contextId: 'fix-bug',
    },
  );
});

test('upsertAgentContext keeps multiple reviewer contexts independently selectable', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-reviewers`,
    slotId: 'runner-browser-1',
  });
  t.after(() => cleanupRun(run.id));

  await upsertAgentContext(run.id, 'self-review', {
    id: 'rev-codex',
    label: 'rev-codex (gpt-5)',
    status: 'working',
    runner: 'codex',
    model: 'gpt-5',
    target: { session: 'mme-1', window: 'rev-codex', target: 'mme-1:rev-codex' },
  });
  await upsertAgentContext(run.id, 'self-review', {
    id: 'rev-claude',
    label: 'rev-claude (opus)',
    status: 'working',
    runner: 'claude',
    model: 'opus',
    target: { session: 'mme-1', window: 'rev-claude', target: 'mme-1:rev-claude' },
  });

  const updated = updateRun(run.id, {});
  const reviewerIds = updated.agentContexts
    ?.filter((ctx) => ctx.role === 'self-review')
    .map((ctx) => ctx.id)
    .sort();
  assert.deepEqual(reviewerIds, ['rev-claude', 'rev-codex']);
  assert.equal(selectAgentContext(updated, { contextId: 'rev-codex' })?.runner, 'codex');
  assert.equal(selectAgentContext(updated, { contextId: 'rev-claude' })?.runner, 'claude');
  assert.equal(selectAgentContext(updated, { role: 'self-review' })?.id, 'rev-claude');

  assert.deepEqual(
    await resolveAgentTarget('runner-browser-1', {
      runId: run.id,
      contextId: 'rev-codex',
      role: 'self-review',
    }),
    {
      target: 'mme-1:rev-codex',
      session: 'mme-1',
      role: 'self-review',
      contextId: 'rev-codex',
    },
  );
});
