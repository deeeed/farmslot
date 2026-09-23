process.env.NODE_TEST_CONTEXT = '1';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAssessmentProviderRegistry } from '../assessment/provider.js';
import { assessmentRecords } from '../assessment/store.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';
import { runWithSessionOriginator } from '../security/work-originator.js';

import { acceptanceEvidenceAnalyze, acceptanceEvidenceGet } from './acceptance-evidence.js';

const principal = {
  id: 'acceptance-evidence-test',
  subject: { type: 'person' as const, displayName: 'Tester' },
  roles: [],
};
const withPrincipal = <T>(operation: () => T) => runWithSessionOriginator(principal, operation);

function fixture(t: import('node:test').TestContext) {
  const home = mkdtempSync(path.join(tmpdir(), 'acceptance-evidence-'));
  const previous = Object.fromEntries(
    [
      'FARMSLOT_HOME',
      'FARMSLOT_ACCEPTANCE_EVIDENCE_ENABLED',
      'FARMSLOT_ASSESSMENT_ENABLED',
      'FARMSLOT_ASSESSMENT_PROVIDER',
      'FARMSLOT_ASSESSMENT_MODEL',
      'CODEX_LB_API_KEY',
    ].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    FARMSLOT_HOME: home,
    FARMSLOT_ACCEPTANCE_EVIDENCE_ENABLED: 'true',
    FARMSLOT_ASSESSMENT_ENABLED: 'true',
    FARMSLOT_ASSESSMENT_PROVIDER: 'codex-lb',
    FARMSLOT_ASSESSMENT_MODEL: 'fixture-model',
    CODEX_LB_API_KEY: 'synthetic-test-credential',
  });
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-farm',
    ticketOrPr: 'SYNTHETIC-AC',
  });
  const dir = path.join(home, 'tasks', run.id);
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  updateRun(run.id, { taskFile: path.join(dir, 'TASK.md') });
  writeFileSync(
    path.join(dir, 'inputs', 'handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: ['The output reads ready'] } }),
  );
  const ledger = path.join(dir, 'artifacts', 'acceptance-status.json');
  const body = (proofMode: string = 'state', evidence = ['artifacts/output.md']) =>
    JSON.stringify({
      schemaVersion: 1,
      criteria: [
        {
          id: 'AC-1',
          text: 'The output reads ready',
          verdict: 'weak',
          proofMode,
          evidence,
          recipeNodes: [],
          updatedAt: new Date().toISOString(),
        },
      ],
    });
  writeFileSync(ledger, body());
  writeFileSync(path.join(dir, 'artifacts', 'output.md'), 'The output reads ready.');
  t.after(async () => {
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const params = { runId: run.id, criterionId: 'AC-1' };
  const policy = async () => {
    const selected = await withPrincipal(() => acceptanceEvidenceGet(params));
    assert.equal(selected.reason, 'not-admitted');
    const entry = {
      ...params,
      snapshotHash: selected.snapshotHash,
      classification: 'synthetic',
      sourceRef: 'synthetic:ac-fixture',
    };
    const value = {
      version: 1,
      entries: [entry],
      price: {
        version: 1,
        provider: 'codex-lb',
        model: 'fixture-model',
        verifiedAt: new Date().toISOString(),
        source: 'https://example.org/prices',
        inputUsdPerMillion: 0.05,
        outputUsdPerMillion: 0,
        maxInputTokens: 8192,
        maxOutputTokens: 500,
      },
      limits: { maxCalls: 2, maxUsd: 0.001 },
    };
    writeFileSync(path.join(home, 'acceptance-evidence-policy.json'), JSON.stringify(value));
    return selected.snapshotHash!;
  };
  return { home, run, dir, ledger, body, params, policy };
}

test('large admitted text is refused before reserve or provider dispatch', async (t) => {
  const { home, dir, ledger, body, params, policy } = fixture(t);
  const evidencePaths = Array.from({ length: 4 }, (_, index) => `artifacts/part-${index}.md`);
  writeFileSync(ledger, body('state', evidencePaths));
  for (const file of evidencePaths) writeFileSync(path.join(dir, file), 'x'.repeat(4096));
  await policy();
  const entry = JSON.parse(
    readFileSync(path.join(home, 'acceptance-evidence-policy.json'), 'utf8'),
  );
  entry.entries[0].snapshotHash = (
    await withPrincipal(() => acceptanceEvidenceGet(params))
  ).snapshotHash;
  writeFileSync(path.join(home, 'acceptance-evidence-policy.json'), JSON.stringify(entry));
  let calls = 0;
  const registry = createAssessmentProviderRegistry([
    {
      id: 'codex-lb',
      defaultModel: 'fixture-model',
      credentialEnv: 'CODEX_LB_API_KEY',
      capabilities: ['choice'],
      async assess() {
        calls++;
        throw new Error('oversized packet must not reach provider');
      },
    },
  ]);
  const result = await withPrincipal(() =>
    acceptanceEvidenceAnalyze(
      { ...params, expectedSnapshotHash: entry.entries[0].snapshotHash },
      registry,
    ),
  );
  assert.equal(result.reason, 'price-unavailable');
  assert.equal(calls, 0);
  assert.equal((await assessmentRecords(principal.id)).length, 0);
});

test('a provider-enforced output cap admits paid output and records actual usage', async (t) => {
  const { home, params, policy } = fixture(t);
  const hash = await policy();
  const file = path.join(home, 'acceptance-evidence-policy.json');
  const configured = JSON.parse(readFileSync(file, 'utf8'));
  configured.price.outputUsdPerMillion = 0.1;
  configured.price.maxOutputTokens = 2048;
  writeFileSync(file, JSON.stringify(configured));
  let calls = 0;
  const noBound = createAssessmentProviderRegistry([
    {
      id: 'codex-lb',
      defaultModel: 'fixture-model',
      credentialEnv: 'CODEX_LB_API_KEY',
      capabilities: ['choice'],
      async assess() {
        calls++;
        throw new Error('missing output cap must be refused before transport');
      },
    },
  ]);
  assert.equal(
    (
      await withPrincipal(() =>
        acceptanceEvidenceAnalyze({ ...params, expectedSnapshotHash: hash }, noBound),
      )
    ).reason,
    'price-unavailable',
  );
  assert.equal(calls, 0);
  const bounded = createAssessmentProviderRegistry([
    {
      ...noBound.get('codex-lb')!,
      maxOutputTokens: 2048,
      async assess() {
        calls++;
        return {
          returnedModel: 'fixture-model',
          answers: {
            verdict: {
              type: 'choice' as const,
              choice: 'supported',
              choices: ['supported', 'contradicted', 'insufficient'],
            },
          },
          usage: { inputTokens: 100, outputTokens: 4, durationMs: 15 },
        };
      },
    },
  ]);
  const result = await withPrincipal(() =>
    acceptanceEvidenceAnalyze({ ...params, expectedSnapshotHash: hash }, bounded),
  );
  assert.equal(result.verdict, 'supported');
  assert.equal(result.assessment?.usage?.costUsd, (100 * 0.05 + 4 * 0.1) / 1_000_000);
  assert.equal(calls, 1);
});

test('paid output is refused when usage is missing or policy under-reserves the provider cap', async (t) => {
  const { home, params, policy } = fixture(t);
  const hash = await policy();
  const file = path.join(home, 'acceptance-evidence-policy.json');
  const configured = JSON.parse(readFileSync(file, 'utf8'));
  configured.price.outputUsdPerMillion = 0.1;
  configured.price.maxOutputTokens = 2048;
  writeFileSync(file, JSON.stringify(configured));
  let calls = 0;
  const missingOutputUsage = createAssessmentProviderRegistry([
    {
      id: 'codex-lb',
      defaultModel: 'fixture-model',
      credentialEnv: 'CODEX_LB_API_KEY',
      capabilities: ['choice'],
      maxOutputTokens: 2048,
      async assess() {
        calls++;
        return {
          returnedModel: 'fixture-model',
          answers: {
            verdict: {
              type: 'choice' as const,
              choice: 'supported',
              choices: ['supported', 'contradicted', 'insufficient'],
            },
          },
          usage: { inputTokens: 100, durationMs: 15 },
        };
      },
    },
  ]);
  const missing = await withPrincipal(() =>
    acceptanceEvidenceAnalyze({ ...params, expectedSnapshotHash: hash }, missingOutputUsage),
  );
  assert.equal(missing.reason, 'assessment-unavailable');
  assert.equal(missing.assessment?.error, 'spend-bound-unverifiable');
  assert.equal(calls, 1);

  const second = fixture(t);
  const secondHash = await second.policy();
  const secondFile = path.join(second.home, 'acceptance-evidence-policy.json');
  const secondPolicy = JSON.parse(readFileSync(secondFile, 'utf8'));
  secondPolicy.price.outputUsdPerMillion = 0.1;
  secondPolicy.price.maxOutputTokens = 500;
  writeFileSync(secondFile, JSON.stringify(secondPolicy));
  const tooHigh = await withPrincipal(() =>
    acceptanceEvidenceAnalyze(
      { ...second.params, expectedSnapshotHash: secondHash },
      missingOutputUsage,
    ),
  );
  assert.equal(tooHigh.reason, 'price-unavailable');
  assert.equal(calls, 1);
});

test('only an admitted state proof can reach the provider; snapshots become stale and the ledger remains authoritative', async (t) => {
  const { home, dir, ledger, body, params, policy } = fixture(t);
  let calls = 0;
  const registry = createAssessmentProviderRegistry([
    {
      id: 'codex-lb',
      defaultModel: 'fixture-model',
      credentialEnv: 'CODEX_LB_API_KEY',
      capabilities: ['choice'],
      async assess() {
        calls++;
        return {
          returnedModel: 'fixture-model',
          answers: {
            verdict: {
              type: 'choice',
              choice: 'supported',
              choices: ['supported', 'contradicted', 'insufficient'],
            },
          },
          usage: { inputTokens: 100, outputTokens: 4, durationMs: 15 },
        };
      },
    },
  ]);
  const first = await withPrincipal(() => acceptanceEvidenceGet(params));
  assert.equal(first.reason, 'not-admitted');
  const hash = await policy();
  assert.equal(
    (
      await withPrincipal(() =>
        acceptanceEvidenceAnalyze({ ...params, expectedSnapshotHash: 'f'.repeat(64) }, registry),
      )
    ).reason,
    'stale',
  );
  writeFileSync(ledger, body('visual'));
  assert.equal((await withPrincipal(() => acceptanceEvidenceGet(params))).reason, 'non-textual');
  assert.equal(
    (
      await withPrincipal(() =>
        acceptanceEvidenceAnalyze({ ...params, expectedSnapshotHash: hash }, registry),
      )
    ).reason,
    'non-textual',
  );
  writeFileSync(ledger, body('mixed'));
  assert.equal((await withPrincipal(() => acceptanceEvidenceGet(params))).reason, 'non-textual');
  const unknownMode = JSON.parse(body());
  delete unknownMode.criteria[0].proofMode;
  writeFileSync(ledger, JSON.stringify(unknownMode));
  assert.equal((await withPrincipal(() => acceptanceEvidenceGet(params))).reason, 'non-textual');
  writeFileSync(ledger, body('state', ['artifacts/screenshot.png']));
  assert.equal((await withPrincipal(() => acceptanceEvidenceGet(params))).reason, 'non-textual');
  writeFileSync(ledger, body('state', ['artifacts/missing.md']));
  assert.equal(
    (await withPrincipal(() => acceptanceEvidenceGet(params))).reason,
    'no-text-evidence',
  );
  writeFileSync(path.join(home, 'outside.md'), 'Not task evidence');
  symlinkSync(path.join(home, 'outside.md'), path.join(dir, 'artifacts', 'linked.md'));
  writeFileSync(ledger, body('state', ['artifacts/linked.md']));
  assert.equal(
    (await withPrincipal(() => acceptanceEvidenceGet(params))).reason,
    'no-text-evidence',
  );
  writeFileSync(ledger, body());
  writeFileSync(path.join(dir, 'artifacts', 'output.md'), 'Changed proof text.');
  assert.equal(
    (
      await withPrincipal(() =>
        acceptanceEvidenceAnalyze({ ...params, expectedSnapshotHash: hash }, registry),
      )
    ).reason,
    'stale',
  );
  writeFileSync(path.join(dir, 'artifacts', 'output.md'), 'The output reads ready.');
  const ledgerBeforeCall = readFileSync(ledger, 'utf8');
  assert.equal(
    (
      await withPrincipal(() =>
        acceptanceEvidenceAnalyze({ ...params, expectedSnapshotHash: hash }, registry),
      )
    ).verdict,
    'supported',
  );
  assert.equal(calls, 1);
  const stored = (await assessmentRecords(principal.id)).filter(
    (r) => r.consumer === 'acceptance-evidence',
  );
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].subject.run?.admission, {
    classification: 'synthetic',
    sourceRef: 'synthetic:ac-fixture',
  });
  assert.equal(stored[0].subject.run?.criterion?.text, 'The output reads ready');
  assert.equal(stored[0].subject.run?.criterion?.evidence[0].text, 'The output reads ready.');
  assert.equal(stored[0].result?.usage?.costKind, 'estimated');
  assert.equal(
    (
      await withPrincipal(() =>
        acceptanceEvidenceAnalyze({ ...params, expectedSnapshotHash: hash }, registry),
      )
    ).verdict,
    'supported',
  );
  assert.equal(calls, 1);
  assert.equal(readFileSync(ledger, 'utf8'), ledgerBeforeCall);
  assert.ok(
    readFileSync(path.join(home, 'assessments', `${stored[0].id}.json`), 'utf8').includes(
      'acceptance-evidence',
    ),
  );
});

test('disabled, malformed provider answer and reserved concurrent calls cannot publish a verdict', async (t) => {
  const { home, params, policy } = fixture(t);
  const hash = await policy();
  let calls = 0;
  const registry = createAssessmentProviderRegistry([
    {
      id: 'codex-lb',
      defaultModel: 'fixture-model',
      credentialEnv: 'CODEX_LB_API_KEY',
      capabilities: ['choice'],
      async assess() {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          returnedModel: 'fixture-model',
          answers: { verdict: { type: 'choice', choice: 'invalid', choices: ['invalid'] } },
          usage: { inputTokens: 200, outputTokens: 5, durationMs: 20 },
        };
      },
    },
  ]);
  const policyFile = path.join(home, 'acceptance-evidence-policy.json');
  const savedPolicy = JSON.parse(readFileSync(policyFile, 'utf8'));
  writeFileSync(
    policyFile,
    JSON.stringify({ ...savedPolicy, price: { ...savedPolicy.price, outputUsdPerMillion: 0.5 } }),
  );
  assert.equal(
    (
      await withPrincipal(() =>
        acceptanceEvidenceAnalyze({ ...params, expectedSnapshotHash: hash }, registry),
      )
    ).reason,
    'price-unavailable',
  );
  assert.equal(calls, 0);
  writeFileSync(policyFile, JSON.stringify(savedPolicy));
  delete process.env.FARMSLOT_ACCEPTANCE_EVIDENCE_ENABLED;
  assert.equal((await withPrincipal(() => acceptanceEvidenceGet(params))).reason, 'disabled');
  process.env.FARMSLOT_ACCEPTANCE_EVIDENCE_ENABLED = 'true';
  const [a, b] = await Promise.all([
    withPrincipal(() =>
      acceptanceEvidenceAnalyze({ ...params, expectedSnapshotHash: hash }, registry),
    ),
    withPrincipal(() =>
      acceptanceEvidenceAnalyze({ ...params, expectedSnapshotHash: hash }, registry),
    ),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(
    new Set([a.reason, b.reason]),
    new Set(['assessment-unavailable', 'assessment-pending']),
  );
  assert.equal(
    (await withPrincipal(() => acceptanceEvidenceGet(params))).reason,
    'assessment-unavailable',
  );
});

test('two bounded text artifacts can exceed 4 KiB together without a false preview', async (t) => {
  const { home, dir, ledger, body, params, policy } = fixture(t);
  writeFileSync(path.join(dir, 'artifacts', 'output.md'), 'A'.repeat(3000));
  writeFileSync(path.join(dir, 'artifacts', 'extra.md'), 'B'.repeat(2000));
  writeFileSync(ledger, body('state', ['artifacts/output.md', 'artifacts/extra.md']));
  const originalLedger = readFileSync(ledger, 'utf8');
  const hash = await policy();
  const policyFile = path.join(home, 'acceptance-evidence-policy.json');
  const admitted = JSON.parse(readFileSync(policyFile, 'utf8'));
  admitted.price.maxInputTokens = 16384;
  admitted.limits.maxUsd = 0.01;
  writeFileSync(policyFile, JSON.stringify(admitted));
  let calls = 0;
  const registry = createAssessmentProviderRegistry([
    {
      id: 'codex-lb',
      defaultModel: 'fixture-model',
      credentialEnv: 'CODEX_LB_API_KEY',
      capabilities: ['choice'],
      async assess() {
        calls++;
        return {
          returnedModel: 'fixture-model',
          answers: {
            verdict: {
              type: 'choice',
              choice: 'insufficient',
              choices: ['supported', 'contradicted', 'insufficient'],
            },
          },
          usage: { inputTokens: 2000, outputTokens: 4, durationMs: 15 },
        };
      },
    },
  ]);
  const result = await withPrincipal(() =>
    acceptanceEvidenceAnalyze({ ...params, expectedSnapshotHash: hash }, registry),
  );
  assert.equal(result.verdict, 'insufficient');
  assert.equal(calls, 1);
  assert.equal(readFileSync(ledger, 'utf8'), originalLedger);
});
