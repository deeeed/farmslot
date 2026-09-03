import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RetrospectivePayload, RunDecision } from '@farmslot/protocol';

import { createRetrospective, initRunCompletion } from '../run-completion/orchestrator.js';
import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import { buildFamilyObservabilitySnapshotFromRuns } from './snapshot.js';
import { makeRun, writeArtifact } from './test-fixtures.js';

test('snapshot backfills retrospective payload for unresolved legacy decisions', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-observability-retro-backfill-'));
  const taskDir = path.join(base, 'root');
  await writeArtifact(taskDir, 'TASK.md', '# Root task');
  await writeArtifact(
    taskDir,
    'artifacts/report.md',
    '## Summary\nLegacy report summary\nMore detail',
  );
  await writeArtifact(taskDir, 'artifacts/learnings.md', 'Legacy learning');

  const snapshot = await buildFamilyObservabilitySnapshotFromRuns([
    makeRun({
      id: 'retro-run',
      familyId: 'family-retro',
      familyRootTicketOrPr: 'owner/repo#42',
      ticketOrPr: 'owner/repo#42',
      taskFile: path.join(taskDir, 'TASK.md'),
      steps: [
        { name: 'self-review', status: 'done', outputs: { verdict: 'pass' } },
        {
          name: 'ci-watch',
          status: 'done',
          outputs: {
            result: 'passed',
            checkSummary: { passed: 3, failed: 0, pending: 0, skipped: 0, total: 3 },
          },
        },
      ],
      decisions: [
        {
          id: 'retro-decision',
          type: 'retrospective',
          title: 'Review retrospective',
          description: 'update-branch run completed (success)',
          actions: [
            { id: 'accept', label: 'Accept for Learning', style: 'primary' },
            { id: 'rework', label: 'Reject Learning', style: 'secondary' },
            { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
          ],
          createdAt: '2026-04-25T00:00:00.000Z',
        },
      ],
    }),
  ]);

  const decision = snapshot.runs[0].decisions?.find((entry) => entry.id === 'retro-decision');
  assert(decision);
  const payload = decision.payload as {
    kind?: string;
    outcome?: string;
    workerLearnings?: string;
    reportExcerpt?: string;
    selfReviewVerdict?: string;
    ciWatch?: { result?: string };
  };
  assert.equal(payload.kind, 'retrospective');
  assert.equal(payload.outcome, 'success');
  assert.equal(payload.selfReviewVerdict, 'pass');
  assert.equal(payload.workerLearnings, 'Legacy learning');
  assert.match(payload.reportExcerpt ?? '', /Legacy report summary/);
  assert.equal(payload.ciWatch?.result, 'passed');
});

test('createRetrospective broadcasts root supersession before follow-up new (atomic ordering)', async (t) => {
  // Always reset broadcast wiring after this test, even on assertion failure,
  // so subsequent tests don't observe events captured here.
  t.after(() => initRunCompletion(() => {}));
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-retro-broadcast-order-'));
  const rootDir = path.join(base, 'root');
  const followDir = path.join(base, 'follow');
  await writeArtifact(rootDir, 'TASK.md', '# root');
  await writeArtifact(rootDir, 'artifacts/learnings.md', 'Original lesson');
  await writeArtifact(followDir, 'TASK.md', '# follow');
  await writeArtifact(followDir, 'artifacts/learnings.md', 'Reviewer-driven lesson');
  await writeArtifact(
    followDir,
    'artifacts/comments-triage.json',
    JSON.stringify([{ triage: 'REAL', fixed_in_commit: 'abc1234', path: 'src/a.ts' }]),
  );

  const root = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-browser-farm',
    ticketOrPr: 'PROJ-broadcast-order',
  });
  updateRun(root.id, {
    status: 'done',
    taskFile: path.join(rootDir, 'TASK.md'),
    decisions: [
      {
        id: randomUUID(),
        type: 'retrospective',
        title: 'Root retro',
        description: 'pending',
        actions: [{ id: 'accept', label: 'Accept for Learning', style: 'primary' }],
        createdAt: new Date().toISOString(),
      } satisfies RunDecision,
    ],
  });

  const followUp = createRun({
    flowType: 'pr-complete',
    mode: 'autonomous',
    project: 'example-browser-farm',
    ticketOrPr: 'owner/repo#1',
    parentRunId: root.id,
    familyId: root.id,
    familyRootTicketOrPr: 'PROJ-broadcast-order',
  });
  updateRun(followUp.id, {
    status: 'done',
    taskFile: path.join(followDir, 'TASK.md'),
  });
  // Drop the persisted JSONs so other tests don't see leaked PROJ-broadcast-order.
  t.after(async () => {
    await deleteRun(root.id);
    await deleteRun(followUp.id);
  });

  const events: Array<{
    event: string;
    payload: { runId?: string; decisionId?: string; actionId?: string };
  }> = [];
  initRunCompletion((event, payload) => {
    events.push({
      event,
      payload: payload as { runId?: string; decisionId?: string; actionId?: string },
    });
  });

  await createRetrospective(followUp, null);

  // Filter to the two key broadcasts; ignore intermediate RUN_UPDATED.
  const keyEvents = events.filter(
    (e) => e.event === 'run.decision.resolved' || e.event === 'run.decision.new',
  );
  // Root retrospective resolution should land before the follow-up's new decision.
  const resolvedIdx = keyEvents.findIndex(
    (e) =>
      e.event === 'run.decision.resolved' &&
      e.payload.runId === root.id &&
      e.payload.actionId === 'superseded',
  );
  const newIdx = keyEvents.findIndex(
    (e) => e.event === 'run.decision.new' && e.payload.runId === followUp.id,
  );
  assert.notEqual(resolvedIdx, -1, 'expected root supersession event');
  assert.notEqual(newIdx, -1, 'expected follow-up new-decision event');
  assert.ok(
    resolvedIdx < newIdx,
    `expected root supersession before follow-up new (resolved=${resolvedIdx} new=${newIdx})`,
  );
});

test('createRetrospective is idempotent for concurrent calls on the same run', async (t) => {
  t.after(() => initRunCompletion(() => {}));
  const base = await mkdtemp(path.join(os.tmpdir(), 'run-retro-idempotency-'));
  const taskDir = path.join(base, 'task');
  await writeArtifact(taskDir, 'TASK.md', '# task');
  await writeArtifact(taskDir, 'artifacts/learnings.md', 'One durable lesson.');

  const run = createRun({
    flowType: 'pr-complete',
    mode: 'autonomous',
    project: 'example-browser-farm',
    ticketOrPr: 'owner/repo#2',
  });
  updateRun(run.id, {
    status: 'done',
    taskFile: path.join(taskDir, 'TASK.md'),
  });
  t.after(async () => deleteRun(run.id));

  await Promise.all([createRetrospective(run, null), createRetrospective(run, null)]);

  const retrospectives = getRun(run.id)!.decisions.filter(
    (decision) => decision.type === 'retrospective' && !decision.resolvedAt,
  );
  assert.equal(retrospectives.length, 1);
});

test('createRetrospective emits terminal update-branch family retro with review-comment triage', async (t) => {
  t.after(() => initRunCompletion(() => {}));
  const base = await mkdtemp(path.join(os.tmpdir(), 'family-retro-merge-terminal-'));
  const rootDir = path.join(base, 'root');
  const prCompleteDir = path.join(base, 'pr-complete');
  const mergeDir = path.join(base, 'update-branch');
  await writeArtifact(rootDir, 'TASK.md', '# root');
  await writeArtifact(rootDir, 'artifacts/learnings.md', 'Root missed value parity.');
  await writeArtifact(prCompleteDir, 'TASK.md', '# follow');
  await writeArtifact(
    prCompleteDir,
    'artifacts/learnings.md',
    'Cursor caught the alternate render path.',
  );
  await writeArtifact(
    prCompleteDir,
    'artifacts/comments-triage.json',
    JSON.stringify([
      {
        triage: 'REAL',
        fixed_in_commit: 'abc1234',
        path: 'src/perps/value.ts',
        source_kind: 'bot',
        author_login: 'cursor[bot]',
      },
      { triage: 'OUT_OF_SCOPE', path: 'src/noise.ts', source_kind: 'bot' },
    ]),
  );
  await writeArtifact(mergeDir, 'TASK.md', '# merge');
  await writeArtifact(mergeDir, 'artifacts/report.md', '## Summary\nMerged after conflict fix.');

  const root = createRun({
    flowType: 'fix-bug',
    mode: 'autonomous',
    project: 'example-browser-farm',
    ticketOrPr: 'PROJ-terminal-family',
  });
  updateRun(root.id, {
    status: 'done',
    taskFile: path.join(rootDir, 'TASK.md'),
    decisions: [
      {
        id: randomUUID(),
        type: 'retrospective',
        title: 'Root retro',
        description: 'pending',
        actions: [{ id: 'accept', label: 'Accept for Learning', style: 'primary' }],
        createdAt: new Date().toISOString(),
      } satisfies RunDecision,
    ],
  });

  const prComplete = createRun({
    flowType: 'pr-complete',
    mode: 'autonomous',
    project: 'example-browser-farm',
    ticketOrPr: 'owner/repo#1',
    parentRunId: root.id,
    familyId: root.id,
    familyRootTicketOrPr: 'PROJ-terminal-family',
  });
  updateRun(prComplete.id, {
    status: 'done',
    taskFile: path.join(prCompleteDir, 'TASK.md'),
    completedAt: '2026-04-25T01:00:00.000Z',
  });

  const mergeMain = createRun({
    flowType: 'update-branch',
    mode: 'autonomous',
    project: 'example-browser-farm',
    ticketOrPr: 'owner/repo#1',
    parentRunId: prComplete.id,
    familyId: root.id,
    familyRootTicketOrPr: 'PROJ-terminal-family',
  });
  updateRun(mergeMain.id, {
    status: 'done',
    taskFile: path.join(mergeDir, 'TASK.md'),
    completedAt: '2026-04-25T02:00:00.000Z',
    steps: [{ name: 'ci-watch', status: 'done', outputs: { result: 'passed' } }],
  });
  t.after(async () => {
    await deleteRun(root.id);
    await deleteRun(prComplete.id);
    await deleteRun(mergeMain.id);
  });

  await createRetrospective(mergeMain, '## Summary\nMerged after conflict fix.');

  const storedRoot = getRun(root.id)!;
  const storedMerge = getRun(mergeMain.id)!;
  assert.equal(
    storedRoot.decisions.find((d) => d.type === 'retrospective')?.resolvedAction,
    'superseded',
  );
  const retro = storedMerge.decisions.find((d) => d.type === 'retrospective');
  assert(retro);
  assert.match(retro.title, /^Family retrospective/);
  assert.equal(retro.payload?.kind, 'retrospective');
  const payload = retro.payload as RetrospectivePayload;
  assert.equal(payload.rootRunId, root.id);
  assert.match(payload.workerLearnings ?? '', /Root missed value parity/);
  assert.match(payload.workerLearnings ?? '', /Cursor caught the alternate render path/);
  assert.match(payload.workerLearnings ?? '', /botAddressed=1/);
  assert.equal(payload.commentsTriageSummary?.real, 1);
  assert.equal(payload.commentsTriageSummary?.outOfScope, 1);
  assert.equal(payload.ciWatch?.result, 'passed');
});
