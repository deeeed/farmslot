import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { retainFixtureTask } from '../../../../packages/run-bundle/src/retained.test-support.js';

await import('../runtime/mock-pty.test-support.js');
const { readGateAcceptance, collectRunGateReadiness } = await import('./gate-prerequisites.js');
const { makeRun, deleteTestRunIfPresent } = await import('./test-fixtures.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { runBundleStore } = await import('../run-completion/retained-artifacts.js');
const require = createRequire(import.meta.url);
const {
  setDerivedClaims,
  writeAcceptanceLedger,
  readAcceptanceLedger,
  acceptanceContractIssues,
} = require('@farmslot/agent-runtime/scripts/acceptance-ledger.cjs');
const { engineClaims } = require('../../../../packages/agent-runtime/test/acceptance-fixtures.cjs');

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gate-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskDir = path.join(root, 'tasks', 'owned');
  await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  const criteria = Array.from({ length: 11 }, (_, index) => `Criterion ${index + 1}`);
  await writeFile(
    path.join(taskDir, 'inputs/handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: criteria } }),
  );
  await writeFile(path.join(taskDir, 'artifacts/output.json'), JSON.stringify({ ok: true }));
  const run = {
    ...makeRun({
      id: randomUUID(),
      ticketData: {
        title: 'Authority test',
        description: '',
        acceptanceCriteria: criteria,
        source: 'manual',
        affectedArea: '',
        stepsToReproduce: [],
        screenshots: [],
        labels: [],
      },
    }),
    taskFile: path.join(taskDir, 'TASK.md'),
    slotId: 'owned-slot',
    agentContexts: [
      {
        id: 'primary',
        role: 'primary' as const,
        runId: 'run-1',
        slotId: 'owned-slot',
        label: 'Worker',
        status: 'complete' as const,
        taskFile: 'tasks/owned/TASK.md',
      },
    ],
  };
  run.agentContexts[0].runId = run.id;
  const capture = async () => retainFixtureTask(root, run, await runBundleStore(true));
  await capture();
  const proveAll = () => setDerivedClaims(taskDir, engineClaims(criteria));
  return { run, taskDir, capture, proveAll };
}

test('captured task registration refuses 0/11 verdicts until a new engine projection is retained', async (t) => {
  const f = await fixture(t);
  const empty = await readGateAcceptance(f.run);
  assert.equal(empty.criteria.length, 11);
  assert.equal(empty.ledger, null);
  assert.ok(empty.issues.length);
  f.proveAll();
  await f.capture();
  const complete = await readGateAcceptance(f.run);
  assert.equal(complete.error, undefined);
  assert.deepEqual(complete.issues, []);
});

test('a foreign criterion replacing a registered row cannot pass the completion guard', async (t) => {
  const f = await fixture(t);
  f.proveAll();
  await f.capture();
  const file = path.join(f.taskDir, 'artifacts/acceptance-status.json');
  const ledger = JSON.parse(await readFile(file, 'utf8'));
  ledger.criteria[0].id = 'AC-12';
  await writeFile(file, JSON.stringify(ledger));
  await f.capture();
  const readiness = await collectRunGateReadiness(f.run, null, {
    deterministic: async () => {},
    progress: async () => ({ kind: 'idle' }),
    acceptance: (run) => readGateAcceptance(run),
  });
  assert.equal(readiness.state, 'not-ready');
  assert.ok(readiness.reasons.some((reason) => reason.code === 'acceptance-incomplete'));
});

test('missing current registration does not erase the original task criteria', async (t) => {
  const f = await fixture(t);
  f.proveAll();
  await f.capture();
  await unlink(path.join(f.taskDir, 'inputs/handoff.json'));
  await f.capture();
  const result = await readGateAcceptance(f.run);
  assert.match(result.error ?? '', /registration is missing or changed/);
});

test('weak engine verdicts defer to package review while terminal checks keep their explicit exception', async (t) => {
  const f = await fixture(t);
  f.proveAll();
  await f.capture();
  const claims = readAcceptanceLedger(f.taskDir);
  claims.criteria[0].verdict = 'weak';
  writeAcceptanceLedger(f.taskDir, claims);
  await f.capture();
  assert.ok(acceptanceContractIssues(f.taskDir, { require: true, allowWeak: false }).length);
  assert.deepEqual((await readGateAcceptance(f.run)).issues, []);
  assert.deepEqual(acceptanceContractIssues(f.taskDir, { require: true, allowWeak: true }), []);
});

test('static review gate validates its exact admitted report through the owner readers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gate-review-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await mkdir(path.join(root, 'inputs'), { recursive: true });
  const run = createRun({
    flowType: 'review-pr',
    project: 'gate-review',
    ticketOrPr: 'REVIEW-RESULT',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, { taskFile: path.join(root, 'TASK.md'), status: 'human-gating' });
  const head = 'a'.repeat(40);
  await writeFile(
    path.join(root, 'inputs/commit.json'),
    JSON.stringify({ source: 'github-pr', headSha: head }),
  );
  const source = {
    deterministic: async () => {},
    acceptance: async () => ({ criteria: [], ledger: null, issues: [] }),
    progress: async () => ({ kind: 'idle' as const }),
  };
  const check = async () => {
    await retainFixtureTask(root, getRun(run.id)!, await runBundleStore(true));
    return collectRunGateReadiness(getRun(run.id)!, null, source);
  };
  assert.ok((await check()).reasons.some((reason) => reason.code === 'review-document-missing'));
  await writeFile(path.join(root, 'artifacts/review.md'), 'A review is finished.');
  assert.equal((await check()).state, 'not-ready');
  await writeFile(
    path.join(root, 'artifacts/review.md'),
    `VERDICT: APPROVE\nCOMMIT: ${'b'.repeat(40)}\n`,
  );
  assert.equal((await check()).state, 'not-ready');
  await writeFile(path.join(root, 'artifacts/review.md'), `VERDICT: APPROVE\nCOMMIT: ${head}\n`);
  await writeFile(
    path.join(root, 'artifacts/review-result.json'),
    JSON.stringify({ schemaVersion: 1, verdict: 'pass', recommendation: 'APPROVE', issues: [] }),
  );
  assert.equal((await check()).state, 'ready');
});
