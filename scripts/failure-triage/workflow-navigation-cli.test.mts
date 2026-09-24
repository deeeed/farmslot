import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main } from './workflow-navigation-cli.mts';
import { reservation, validateConfig, type RunnerConfig } from './workflow-navigation-runner.mts';
import { nextPrompt, startSession, type NavigationCase } from './workflow-navigation.mts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
test('offline CLI seals both plans and reports an incomplete comparison as inconclusive', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'navigation-cli-'));
  try {
    const file = (name: string) => path.join(directory, name);
    const cases: NavigationCase[] = [
      {
        id: 'synthetic-one',
        failure: 'The worker failed before reporting any task activity.',
        sources: [{ id: 'runner.stderr', title: 'Runner stderr', text: 'runner not available' }],
      },
    ];
    await writeFile(file('cases.json'), JSON.stringify(cases));
    await writeFile(
      file('reference.json'),
      JSON.stringify({
        version: 1,
        status: 'frozen',
        references: [
          {
            caseId: 'synthetic-one',
            label: 'environment',
            requiredReadIds: ['runner.stderr'],
            nextCheck: 'Inspect the configured runner.',
            family: 'runner-start',
          },
        ],
      }),
    );
    await main(['seal-advice', file('cases.json'), file('advice-plan.json')]);
    const sealed = JSON.parse(await readFile(file('advice-plan.json'), 'utf8'));
    assert.equal(sealed.cases[0].failure, cases[0].failure);
    const advice = [
      {
        caseId: cases[0].id,
        text: 'Suggested first read: runner.stderr.',
        receipt: {
          responseId: 'fixture-receipt',
          receiptHash: sha('fixture'),
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          providerDurationMs: 20,
          elapsedMs: 30,
          costUsd: 0.0001,
        },
      },
    ];
    const journalRows = [
      {
        kind: 'approved',
        planHash: sealed.hash,
        configHash: sha('config'),
        methodologyHash: sha('advice-method'),
        config: { provider: 'fixture', model: 'mock-advice' },
      },
      { kind: 'started', caseId: 'synthetic-one' },
      { kind: 'finished', ...advice[0] },
      { kind: 'closed', planHash: sealed.hash, stopReason: 'completed', attempts: 1 },
    ];
    const journal = journalRows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(file('advice-journal.jsonl'), journal);
    const provenance = {
      advicePlanHash: sealed.hash,
      configHash: sha('config'),
      provider: 'fixture',
      model: 'mock-advice',
      journalSha256: sha(journal),
    };
    await writeFile(
      file('advice-incomplete.json'),
      JSON.stringify({ stopReason: 'unknown-charge', advice, ...provenance }),
    );
    await assert.rejects(
      () =>
        main([
          'seal-worker',
          file('cases.json'),
          file('advice-plan.json'),
          file('advice-incomplete.json'),
          file('advice-journal.jsonl'),
          file('reference.json'),
          file('invalid.json'),
        ]),
      /provenance/,
    );
    await writeFile(
      file('advice.json'),
      JSON.stringify({ stopReason: 'completed', advice, ...provenance }),
    );
    await main([
      'seal-worker',
      file('cases.json'),
      file('advice-plan.json'),
      file('advice.json'),
      file('advice-journal.jsonl'),
      file('reference.json'),
      file('worker-plan.json'),
    ]);
    const worker = JSON.parse(await readFile(file('worker-plan.json'), 'utf8'));
    assert.equal(worker.advice.length, 1);
    assert.deepEqual([worker.maxTurns, worker.maxReads], [3, 2]);
    await writeFile(file('limits.json'), JSON.stringify({ maxTurns: 4, maxReads: 3 }));
    await main([
      'seal-advice',
      file('cases.json'),
      file('extended-advice-plan.json'),
      file('limits.json'),
    ]);
    const extendedAdvicePlan = JSON.parse(
      await readFile(file('extended-advice-plan.json'), 'utf8'),
    );
    assert.notEqual(extendedAdvicePlan.hash, sealed.hash);
    assert.deepEqual(extendedAdvicePlan.workerLimits, { maxTurns: 4, maxReads: 3 });
    const extendedJournal =
      journalRows
        .map((row) =>
          JSON.stringify(
            row.kind === 'approved' || row.kind === 'closed'
              ? { ...row, planHash: extendedAdvicePlan.hash }
              : row,
          ),
        )
        .join('\n') + '\n';
    await writeFile(file('extended-advice-journal.jsonl'), extendedJournal);
    await writeFile(
      file('extended-advice.json'),
      JSON.stringify({
        stopReason: 'completed',
        advice,
        ...provenance,
        advicePlanHash: extendedAdvicePlan.hash,
        journalSha256: sha(extendedJournal),
      }),
    );
    await assert.rejects(
      () =>
        main([
          'seal-worker',
          file('cases.json'),
          file('extended-advice-plan.json'),
          file('advice.json'),
          file('advice-journal.jsonl'),
          file('reference.json'),
          file('late-budget-change.json'),
        ]),
      /Advice provenance/,
    );
    await main([
      'seal-worker',
      file('cases.json'),
      file('extended-advice-plan.json'),
      file('extended-advice.json'),
      file('extended-advice-journal.jsonl'),
      file('reference.json'),
      file('extended-worker-plan.json'),
    ]);
    const extended = JSON.parse(await readFile(file('extended-worker-plan.json'), 'utf8'));
    assert.deepEqual([extended.maxTurns, extended.maxReads], [4, 3]);
    assert.notEqual(extended.hash, worker.hash);
    await writeFile(file('bad-limits.json'), JSON.stringify({ maxTurns: 4, maxReads: 4 }));
    await assert.rejects(
      () =>
        main([
          'seal-advice',
          file('cases.json'),
          file('bad-advice-plan.json'),
          file('bad-limits.json'),
        ]),
      /Invalid worker limits/,
    );
    const session = { ...startSession(worker, 'synthetic-one', 'baseline'), wallElapsedMs: 12 };
    const config: RunnerConfig = {
      baseUrl: 'https://api.example.test/v1',
      model: 'fixture-worker',
      provider: 'fixture',
      reasoning: 'low',
      maxInputTokens: 4096,
      maxOutputTokens: 64,
      maxTotalTokens: 50000,
      maxTotalUsd: 0.01,
      price: {
        source: 'https://example.test/pricing',
        verifiedAt: new Date().toISOString(),
        inputUsdPerMillion: 0.25,
        outputUsdPerMillion: 2,
        cacheReadMultiplier: 1,
        cacheWriteMultiplier: 1,
      },
    };
    assert.equal(reservation(extended, config).calls, 8);
    const configHash = validateConfig(config);
    const writeSessions = async (provenance: object) =>
      writeFile(
        file('sessions.json'),
        JSON.stringify({ sessions: [session], stopReason: 'unknown-charge', ...provenance }),
      );
    await writeSessions({});
    await main(['blind', file('worker-plan.json'), file('sessions.json'), file('blind.json')]);
    const blind = JSON.parse(await readFile(file('blind.json'), 'utf8'));
    assert.equal(blind.rows.length, 1);
    const method = 'Reviewed synthetic fixture, hidden reference, and journal.';
    await writeFile(file('method.md'), method);
    await writeFile(
      file('quality.json'),
      JSON.stringify({
        version: 1,
        packetHash: blind.hash,
        methodologyHash: sha(method),
        reviewer: 'test-reviewer',
        decisions: blind.rows.map((row: { blindId: string }) => ({
          blindId: row.blindId,
          decision: 'unresolved',
          reason: 'Worker request failed',
        })),
      }),
    );
    const workerRows = [
      { kind: 'approved', planHash: worker.hash, configHash, config, methodologyHash: sha(method) },
      {
        kind: 'started',
        caseId: session.caseId,
        arm: session.arm,
        turn: 1,
        promptHash: sha(nextPrompt(worker, session)),
      },
      {
        kind: 'failed',
        caseId: session.caseId,
        arm: session.arm,
        turn: 1,
        reason: 'provider-http-error',
        httpStatus: 401,
        responseReceived: true,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        durationMs: 2,
        costUsd: null,
      },
      {
        kind: 'session-closed',
        caseId: session.caseId,
        arm: session.arm,
        status: session.status,
        turnCount: 0,
        wallElapsedMs: 12,
      },
      { kind: 'closed', planHash: worker.hash, stopReason: 'unknown-charge', attempts: 1 },
    ];
    const writeWorkerRows = async (rows: readonly object[]) =>
      writeFile(
        file('worker-journal.jsonl'),
        rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
      );
    await writeWorkerRows(workerRows);
    const workerProvenance = {
      planHash: worker.hash,
      configHash,
      provider: config.provider,
      model: config.model,
      methodologyHash: sha(method),
      journalSha256: sha(await readFile(file('worker-journal.jsonl'), 'utf8')),
    };
    await writeSessions(workerProvenance);
    await main([
      'score',
      file('worker-plan.json'),
      file('sessions.json'),
      file('reference.json'),
      file('blind.json'),
      file('quality.json'),
      file('method.md'),
      file('worker-journal.jsonl'),
      file('report.json'),
    ]);
    const report = JSON.parse(await readFile(file('report.json'), 'utf8'));
    assert.equal(report.decision, 'inconclusive');
    assert.equal(report.workerProvider, config.provider);
    assert.equal(report.workerModel, config.model);
    assert.equal(report.workerConfigHash, configHash);
    assert.equal(report.workerMethodologyHash, sha(method));
    assert.equal(report.workerJournalSha256, workerProvenance.journalSha256);
    assert.equal(report.denominator, 1);
    assert.equal(report.completeMetricsPairs, 0);
    assert.equal(report.totals, null);
    assert.deepEqual(report.navigation.named.missing, { baseline: 0, assisted: 1 });
    assert.deepEqual(report.navigation.named.interrupted, { baseline: 1, assisted: 0 });
    assert.deepEqual(report.navigation.named.zeroRead, { baseline: 0, assisted: 0 });
    assert.deepEqual(report.navigation.named.firstReadHits, { baseline: 0, assisted: 0 });
    for (const [name, rows] of [
      ['missing failure', workerRows.filter((row) => row.kind !== 'failed')],
      [
        'wrong count',
        workerRows.map((row) => (row.kind === 'closed' ? { ...row, attempts: 0 } : row)),
      ],
      ['wrong order', [workerRows[0], workerRows[2], workerRows[1], workerRows[3], workerRows[4]]],
      [
        'wrong prompt',
        workerRows.map((row) =>
          row.kind === 'started' ? { ...row, promptHash: sha('wrong') } : row,
        ),
      ],
      [
        'bad metadata',
        workerRows.map((row) => (row.kind === 'failed' ? { ...row, httpStatus: '401' } : row)),
      ],
      [
        'plausible failure change',
        workerRows.map((row) => (row.kind === 'failed' ? { ...row, httpStatus: 403 } : row)),
      ],
      [
        'approved config altered',
        workerRows.map((row) =>
          row.kind === 'approved'
            ? { ...row, config: { ...config, model: 'different-worker' } }
            : row,
        ),
      ],
    ] as const) {
      await writeWorkerRows(rows);
      await assert.rejects(
        () =>
          main([
            'score',
            file('worker-plan.json'),
            file('sessions.json'),
            file('reference.json'),
            file('blind.json'),
            file('quality.json'),
            file('method.md'),
            file('worker-journal.jsonl'),
            file(`rejected-${name}.json`),
          ]),
        /worker journal/,
        name,
      );
    }
    await writeWorkerRows(workerRows);
    for (const [name, provenance] of [
      ['wrong plan', { planHash: sha('another-plan') }],
      ['wrong method', { methodologyHash: sha('another-method') }],
      ['wrong config', { configHash: sha('another-config') }],
      ['wrong provider', { provider: 'another-provider' }],
      ['wrong model', { model: 'another-model' }],
      ['wrong journal hash', { journalSha256: sha('another-journal') }],
    ] as const) {
      await writeSessions({ ...workerProvenance, ...provenance });
      await assert.rejects(
        () =>
          main([
            'score',
            file('worker-plan.json'),
            file('sessions.json'),
            file('reference.json'),
            file('blind.json'),
            file('quality.json'),
            file('method.md'),
            file('worker-journal.jsonl'),
            file(`rejected-${name}.json`),
          ]),
        /worker journal/,
        name,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
