import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPlan, scoreStudy, type PlanOptions } from './workflow-study.mts';
import {
  materializeStudyJournal,
  runStudy,
  verifyJournalApproval,
} from './workflow-study-runner.mts';

const options: PlanOptions = {
  provider: 'fixture',
  baseUrl: 'https://fixture.example',
  priceSource: 'https://example.com/pricing',
  priceApplicability: 'direct',
  priceVerifiedAt: '2026-09-23',
  model: 'fixture-worker',
  reasoning: 'low',
  maxOutputTokens: 256,
  maxInputTokens: 4096,
  maxAttempts: 42,
  maxTotalTokens: 182784,
  maxTotalUsd: 1,
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 1,
  cacheReadMultiplier: 1,
  cacheWriteMultiplier: 1,
};

async function fixture(plan: Awaited<ReturnType<typeof createPlan>>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'triage-study-journal-'));
  const methodologyPath = path.join(dir, 'method.md');
  const independentApprovalPath = path.join(dir, 'approval.json');
  const journalPath = path.join(dir, 'journal.jsonl');
  const methodology = 'Review of the 42 paired synthetic calls and frozen token gate.';
  await writeFile(methodologyPath, methodology);
  await writeFile(
    independentApprovalPath,
    JSON.stringify({
      planHash: plan.planHash,
      methodologyHash: createHash('sha256').update(methodology).digest('hex'),
      reviewer: 'independent-reviewer',
      conclusion: 'approved',
    }),
  );
  return {
    baseUrl: 'https://fixture.example',
    apiKey: 'fixture-only',
    journalPath,
    methodologyPath,
    independentApprovalPath,
  };
}

test('CLI refuses unmatched approval without opening a journal or calling a provider', async () => {
  const plan = await createPlan(options);
  const run = await fixture(plan);
  const planPath = path.join(path.dirname(run.journalPath), 'plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  await writeFile(
    run.independentApprovalPath,
    JSON.stringify({
      planHash: 'wrong',
      methodologyHash: 'wrong',
      reviewer: 'independent-reviewer',
      conclusion: 'approved',
    }),
  );
  const cli = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./workflow-study-runner.mts', import.meta.url)),
      'run',
      planPath,
      run.journalPath,
      run.independentApprovalPath,
      run.methodologyPath,
    ],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, STUDY_API_KEY: 'fixture-only' } },
  );
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Independent methodology approval does not match/);
  await assert.rejects(() => readFile(run.journalPath), /ENOENT/);
});

test('runner refuses unmatched approval before creating a journal or calling a worker', async () => {
  const plan = await createPlan(options);
  const run = await fixture(plan);
  await writeFile(
    run.independentApprovalPath,
    JSON.stringify({
      planHash: 'wrong',
      methodologyHash: 'wrong',
      reviewer: 'someone',
      conclusion: 'approved',
    }),
  );
  let called = 0;
  await assert.rejects(
    () =>
      runStudy(plan, run, async () => {
        called++;
        throw Error('worker called');
      }),
    /approval does not match/,
  );
  assert.equal(called, 0);
  await assert.rejects(() => readFile(run.journalPath), /ENOENT/);
});

test('each row has a synced start and one response; failures and unknown charges survive import', async () => {
  const plan = await createPlan(options);
  const run = await fixture(plan);
  let called = 0;
  await runStudy(plan, run, async (request) => {
    called++;
    assert.equal(request.model, plan.options.model);
    assert.equal(request.reasoning, plan.options.reasoning);
    assert.equal(request.instructions, plan.instructions);
    assert.equal(request.outputSchema?.name, 'failure_triage_worker');
    if (called === 2) throw Error('private transport details must not be serialized');
    return {
      status: 'completed',
      attempted: true,
      requestedModel: request.model,
      returnedModel: request.model,
      responseId: `response_${called}`,
      receiptHash: createHash('sha256').update(String(called)).digest('hex'),
      text: JSON.stringify({
        label: 'unclear',
        nextCheck: 'inspect recorded logs',
        evidenceIds: [],
      }),
      inputTokens: 120,
      outputTokens: 20,
      cacheReadTokens: 12,
      cacheWriteTokens: 0,
      inputAccounting: 'includes-cache',
      durationMs: 20,
    };
  });
  assert.equal(called, 2);
  const text = await readFile(run.journalPath, 'utf8');
  assert.equal(text.trim().split('\n').length, 5);
  assert(!text.includes('fixture-only') && !text.includes('private transport details'));
  await verifyJournalApproval(plan, text, run.independentApprovalPath, run.methodologyPath);
  await assert.rejects(
    () =>
      verifyJournalApproval(
        plan,
        text.slice(text.indexOf('\n') + 1),
        run.independentApprovalPath,
        run.methodologyPath,
      ),
    /matching prior methodology approval/,
  );
  const receipts = materializeStudyJournal(plan, text);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[1].response.error, 'transport-exception-unknown-charge');
  const report = await scoreStudy(plan, receipts);
  assert.equal(report.unknownCharges, 1);
  const studyDir = path.join(path.dirname(run.journalPath), 'study');
  await mkdir(studyDir);
  await writeFile(path.join(studyDir, 'plan.json'), JSON.stringify(plan));
  await writeFile(path.join(studyDir, 'blind-salt'), 'a'.repeat(64));
  const cli = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./workflow-study.mts', import.meta.url)),
      'score-journal',
      studyDir,
      run.journalPath,
      run.independentApprovalPath,
      run.methodologyPath,
    ],
    { encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(
    JSON.parse(await readFile(path.join(studyDir, 'score.json'), 'utf8')).unknownCharges,
    1,
  );
  assert.equal(await readFile(path.join(studyDir, 'journal-snapshot.jsonl'), 'utf8'), text);
  const attemptsPath = path.join(studyDir, 'attempts-snapshot.json');
  const originalAttempts = await readFile(attemptsPath, 'utf8');
  await writeFile(attemptsPath, originalAttempts.replace('response_1', 'response_tampered'));
  const decisionsPath = path.join(studyDir, 'review.json');
  await writeFile(decisionsPath, '[]');
  const tampered = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./workflow-study.mts', import.meta.url)),
      'adjudicate',
      studyDir,
      decisionsPath,
    ],
    { encoding: 'utf8', timeout: 20000 },
  );
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /Attempts snapshot differs from approved runner journal/);
  await writeFile(attemptsPath, originalAttempts);

  assert.equal(report.gateResult.status, 'inconclusive');
  await assert.rejects(
    () =>
      runStudy(plan, run, async () => {
        throw Error('should not run');
      }),
    /EEXIST/,
  );
});

test('interrupted request is counted once as possible charge, never filled in or retried', async () => {
  const plan = await createPlan(options);
  const row = plan.rows[0];
  const journal =
    JSON.stringify({
      version: 1,
      planHash: plan.planHash,
      caseId: row.caseId,
      arm: row.arm,
      promptHash: row.promptHash,
      kind: 'started',
    }) + '\n';
  const torn = materializeStudyJournal(plan, journal + '{\"kind\":\"finished\",\"response\":');
  assert.equal(torn[0].response.error, 'interrupted-unknown-charge');
  const attempts = materializeStudyJournal(plan, journal);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].response.error, 'interrupted-unknown-charge');
  const report = await scoreStudy(plan, attempts);
  assert.equal(report.attempted, 1);
  assert.equal(report.unknownCharges, 1);
  assert.equal(report.missing, 41);
  assert.equal(report.gateResult.status, 'inconclusive');
  assert.throws(() => materializeStudyJournal(plan, journal + journal), /out-of-order|Unfinished/);
});
