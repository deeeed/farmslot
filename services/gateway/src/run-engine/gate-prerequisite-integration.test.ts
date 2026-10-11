import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { SlotVars } from '../core/config.js';

await import('../runtime/mock-pty.test-support.js');
const { readGateAcceptance, collectRunGateReadiness } = await import('./gate-prerequisites.js');
const { makeRun, deleteTestRunIfPresent } = await import('./test-fixtures.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { resolveWorkerTerminalContract } = await import('../tasks/worker-terminal-contract.js');
const require = createRequire(import.meta.url);
const { setAcceptanceVerdict } =
  require('@farmslot/agent-runtime/scripts/acceptance-ledger.cjs') as {
    setAcceptanceVerdict(
      taskDir: string,
      input: { id: string; verdict: string; proofMode: string; evidence: string[] },
    ): void;
  };

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
    taskFile: path.join(root, 'retained', 'TASK.md'),
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
  const vars = {
    slotId: 'owned-slot',
    host: 'localhost',
    machine: 'local',
    sshTarget: '',
    remoteRepo: root,
    repo: root,
    osType: 'darwin',
    sshUser: '',
  } as SlotVars;
  const contract = resolveWorkerTerminalContract(undefined, 'dev');
  const sources = {
    slot: async () => vars,
    contract: async () => ({
      ...contract,
      acceptance: { ...contract.acceptance, allowWeak: false },
    }),
  };
  const proveAll = () => {
    for (let index = 1; index <= 11; index++)
      setAcceptanceVerdict(taskDir, {
        id: `AC-${index}`,
        verdict: 'proven',
        proofMode: 'state',
        evidence: ['artifacts/output.json'],
      });
  };
  return { run, taskDir, sources, proveAll };
}

test('the current dispatched task refuses 0/11 verdicts even when its retained copy is elsewhere', async (t) => {
  const f = await fixture(t);
  const empty = await readGateAcceptance(f.run, f.sources);
  assert.equal(empty.criteria.length, 11);
  assert.equal(empty.ledger, null);
  assert.ok(empty.issues.length);
  f.proveAll();
  const complete = await readGateAcceptance(f.run, f.sources);
  assert.equal(complete.error, undefined);
  assert.deepEqual(complete.issues, []);
});

test('a foreign criterion replacing a registered row cannot pass the completion guard', async (t) => {
  const f = await fixture(t);
  f.proveAll();
  const file = path.join(f.taskDir, 'artifacts/acceptance-status.json');
  const ledger = JSON.parse(await readFile(file, 'utf8'));
  ledger.criteria[0].id = 'AC-12';
  await writeFile(file, JSON.stringify(ledger));
  const readiness = await collectRunGateReadiness(f.run, null, {
    deterministic: async () => {},
    progress: async () => ({ kind: 'idle' }),
    acceptance: (run) => readGateAcceptance(run, f.sources),
    recordedEvidence: async () => ({
      status: 'valid',
      findings: [],
      summary: { errors: 0, warnings: 0 },
    }),
  });
  assert.equal(readiness.state, 'not-ready');
  assert.ok(readiness.reasons.some((reason) => reason.code === 'acceptance-incomplete'));
});

test('missing current registration does not erase the original task criteria', async (t) => {
  const f = await fixture(t);
  f.proveAll();
  await unlink(path.join(f.taskDir, 'inputs/handoff.json'));
  const result = await readGateAcceptance(f.run, f.sources);
  assert.match(result.error ?? '', /registration is missing or changed/);
});

test('weak verdicts use the existing frozen flow exception', async (t) => {
  const f = await fixture(t);
  f.proveAll();
  setAcceptanceVerdict(f.taskDir, {
    id: 'AC-1',
    verdict: 'weak',
    proofMode: 'state',
    evidence: ['artifacts/output.json'],
  });
  assert.ok((await readGateAcceptance(f.run, f.sources)).issues.length);
  const permitted = await readGateAcceptance(f.run, {
    ...f.sources,
    contract: async () => {
      const contract = await f.sources.contract();
      return { ...contract, acceptance: { ...contract.acceptance, allowWeak: true } };
    },
  });
  assert.deepEqual(permitted.issues, []);
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
  const check = () => collectRunGateReadiness(getRun(run.id)!, null, source);
  assert.ok((await check()).reasons.some((reason) => reason.code === 'review-document-missing'));
  await writeFile(path.join(root, 'artifacts/review.md'), 'A review is finished.');
  assert.equal((await check()).state, 'not-ready');
  await writeFile(
    path.join(root, 'artifacts/review.md'),
    `VERDICT: APPROVE\nCOMMIT: ${'b'.repeat(40)}\n`,
  );
  assert.equal((await check()).state, 'not-ready');
  await writeFile(path.join(root, 'artifacts/review.md'), `VERDICT: APPROVE\nCOMMIT: ${head}\n`);
  assert.equal((await check()).state, 'ready');
});
