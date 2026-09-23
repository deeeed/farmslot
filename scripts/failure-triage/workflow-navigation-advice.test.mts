import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { navigationReferenceHash, sealPlan } from './workflow-navigation.mts';
import {
  adviceState,
  adviceReservation,
  generateNavigationAdvice,
  sealAdvicePlan,
} from './workflow-navigation-advice.mts';
import type { AssessmentProvider } from '../../services/gateway/src/assessment/provider.js';
import { createTypeSafeProvider } from '../../services/gateway/src/assessment/typesafe.js';
import type { RunnerApproval } from './workflow-navigation-runner.mts';
import type { AdviceConfig } from './workflow-navigation-advice.mts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cases = [
  {
    id: 'runner-start',
    failure: 'The worker exited before it started the assigned task.',
    sources: [
      { id: 'runner.stderr', title: 'Runner stderr', text: 'exec: worker: command not found' },
      { id: 'slot.health', title: 'Slot health', text: 'healthy' },
    ],
  },
];
const config: AdviceConfig = {
  provider: 'fixture',
  model: 'mock-advice',
  minimumConfidence: 0.5,
  maxInputTokens: 2048,
  maxOutputTokens: 64,
  maxTotalTokens: 4096,
  maxTotalUsd: 0.1,
  price: {
    source: 'https://example.org/price',
    verifiedAt: '2026-09-23T00:00:00Z',
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
    cacheReadMultiplier: 1,
    cacheWriteMultiplier: 1,
  },
};
async function approvedPaths(directory: string, planHash: string, configHash: string) {
  const method = 'Reviewer saw only a public synthetic case summary and source titles.';
  const methodologyPath = path.join(directory, 'method.md');
  const approvalPath = path.join(directory, 'approval.json');
  const journalPath = path.join(directory, 'journal.jsonl');
  await writeFile(methodologyPath, method);
  const approval: RunnerApproval = {
    planHash,
    configHash,
    methodologyHash: hash(method),
    reviewer: 'method-reviewer',
    journalPath,
    conclusion: 'approved',
  };
  await writeFile(approvalPath, JSON.stringify(approval));
  return { methodologyPath, approvalPath, journalPath, apiKey: 'fixture-key' };
}

test('advice input cannot contain full evidence or a hidden reference answer', () => {
  const sealed = sealAdvicePlan(cases);
  assert(!JSON.stringify(adviceState(sealed.cases[0])).includes('command not found'));
  assert.throws(
    () => sealAdvicePlan([{ ...cases[0], reference: { label: 'environment' } } as never]),
    /Unexpected case field/,
  );
  assert.throws(
    () => adviceReservation(sealed, { ...config, maxTotalUsd: 0.00001 }),
    /reserved budget/,
  );
  assert.throws(
    () =>
      adviceReservation(sealed, {
        ...config,
        price: { ...config.price, verifiedAt: '2000-01-01T00:00:00Z' },
      }),
    /Verified price required/,
  );
  assert.throws(
    () =>
      adviceReservation(sealed, {
        ...config,
        provider: 'llm-response',
        baseUrl: 'http://127.0.0.1:1',
      }),
    /output cap must match/,
  );
});

test('approval precedes all calls; approved synthetic advice has actual usage and can enter a paired plan', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'navigation-advice-'));
  try {
    const sealed = sealAdvicePlan(cases);
    const budget = adviceReservation(sealed, config);
    const paths = await approvedPaths(directory, sealed.hash, 'wrong-config');
    let calls = 0;
    const mock: AssessmentProvider = {
      id: 'fixture',
      defaultModel: config.model,
      credentialEnv: 'MOCK_KEY',
      capabilities: ['choice'],
      async assess(request) {
        calls++;
        assert.equal(request.model, config.model);
        assert(!JSON.stringify(request.state).includes('command not found'));
        assert.equal(request.questions.first_read.type, 'choice');
        return {
          returnedModel: config.model,
          answers: {
            first_read: {
              type: 'choice',
              choice: 'runner.stderr',
              choices: ['runner.stderr', 'slot.health', 'none'],
              confidence: 0.81,
              probabilities: { 'runner.stderr': 0.86, 'slot.health': 0.1, none: 0.04 },
            },
          },
          usage: {
            requestId: 'advice-response',
            inputTokens: 100,
            outputTokens: 20,
            durationMs: 2,
          },
        };
      },
    };
    await assert.rejects(
      () => generateNavigationAdvice(sealed, config, paths, mock),
      /approval does not match/,
    );
    assert.equal(calls, 0);
    const validPaths = await approvedPaths(directory, sealed.hash, budget.configHash);
    const result = await generateNavigationAdvice(sealed, config, validPaths, mock);
    assert.equal(result.stopReason, 'completed');
    assert.equal(calls, 1);
    assert.equal(result.advice[0].receipt.inputTokens, 100);
    assert.equal(result.advice[0].receipt.costUsd, 0.00012);
    assert.deepEqual(
      {
        advicePlanHash: result.advicePlanHash,
        configHash: result.configHash,
        provider: result.provider,
        model: result.model,
      },
      {
        advicePlanHash: sealed.hash,
        configHash: budget.configHash,
        provider: config.provider,
        model: config.model,
      },
    );
    assert.equal(
      result.advice[0].text,
      'Suggested first read: runner.stderr. Inspect it before drawing a conclusion.',
    );
    assert.equal(
      sealPlan(
        cases,
        result.advice,
        { maxTurns: 3, maxReads: 2 },
        {
          referenceHash: navigationReferenceHash({
            version: 1,
            status: 'reviewed',
            references: [
              {
                caseId: 'runner-start',
                label: 'environment',
                requiredReadIds: ['runner.stderr'],
                nextCheck: 'Inspect runner stderr.',
                family: 'runner-start',
              },
            ],
          }),
          adviceProvenance: {
            advicePlanHash: sealed.hash,
            configHash: budget.configHash,
            provider: 'fixture',
            model: config.model,
            journalSha256: hash(await readFile(paths.journalPath, 'utf8')),
            methodologyHash: hash(await readFile(paths.methodologyPath, 'utf8')),
          },
        },
      ).advice.length,
      1,
    );
    const rows = (await readFile(paths.journalPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      rows.map((row) => row.kind),
      ['approved', 'started', 'finished', 'closed'],
    );
    assert.equal(rows.at(-1).kind, 'closed');
    assert.equal(result.journalSha256, hash(await readFile(paths.journalPath, 'utf8')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('provider abstentions retain paid receipts but give the worker no advice', async () => {
  for (const choice of ['none', 'runner.stderr'] as const) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'navigation-abstention-'));
    try {
      const sealed = sealAdvicePlan(cases);
      const paths = await approvedPaths(
        directory,
        sealed.hash,
        adviceReservation(sealed, config).configHash,
      );
      const mock: AssessmentProvider = {
        id: 'fixture',
        defaultModel: config.model,
        credentialEnv: 'MOCK_KEY',
        capabilities: ['choice'],
        async assess() {
          return {
            returnedModel: config.model,
            answers: {
              first_read: {
                type: 'choice',
                choice,
                choices: ['runner.stderr', 'slot.health', 'none'],
                confidence: choice === 'none' ? 0.9 : 0.1,
              },
            },
            usage: {
              requestId: `abstain-${choice}`,
              inputTokens: 100,
              outputTokens: 20,
              durationMs: 2,
            },
          };
        },
      };
      const result = await generateNavigationAdvice(sealed, config, paths, mock);
      assert.equal(result.stopReason, 'completed');
      assert.equal(result.advice[0].text, null);
      assert.equal(result.advice[0].receipt.inputTokens, 100);
      assert.equal(result.advice[0].receipt.outputTokens, 20);
      assert.equal(result.advice[0].receipt.costUsd, 0.00012);
      assert.equal(result.journalSha256, hash(await readFile(paths.journalPath, 'utf8')));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('TypeSafe adapter sends a Choice to systemone and never transmits unread source text', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'navigation-typesafe-'));
  try {
    const sealed = sealAdvicePlan(cases);
    const typedConfig: AdviceConfig = {
      ...config,
      provider: 'typesafe',
      model: 'jev-1.13.0',
      price: { ...config.price, inputUsdPerMillion: 0.042, outputUsdPerMillion: 0 },
    };
    const paths = await approvedPaths(
      directory,
      sealed.hash,
      adviceReservation(sealed, typedConfig).configHash,
    );
    let requests = 0;
    const adapter = createTypeSafeProvider(async (input, options) => {
      requests++;
      assert.equal(new URL(String(input)).pathname, '/v1/systemone');
      const body = JSON.parse(String(options?.body));
      assert.equal(body.model, typedConfig.model);
      assert.equal(body.questions.first_read.type, 'choice');
      assert.deepEqual(Object.keys(body.questions.first_read.criteria).sort(), [
        'none',
        'runner.stderr',
        'slot.health',
      ]);
      assert(!JSON.stringify(body).includes('command not found'));
      return new Response(
        JSON.stringify({
          model: typedConfig.model,
          answers: {
            first_read: {
              type: 'choice',
              choice: 'runner.stderr',
              confidence: 0.81,
              probabilities: { 'runner.stderr': 0.86, 'slot.health': 0.1, none: 0.04 },
            },
          },
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
        {
          headers: {
            'content-type': 'application/json',
            'x-typesafe-request-id': 'jev-advice-test',
          },
        },
      );
    });
    const result = await generateNavigationAdvice(sealed, typedConfig, paths, adapter);
    assert.equal(requests, 1);
    assert.equal(result.stopReason, 'completed');
    assert.equal(result.advice[0].receipt.responseId, 'jev-advice-test');
    assert.equal(result.advice[0].receipt.cacheReadTokens, null);
    assert.equal(result.advice[0].receipt.costUsd, (100 * 0.042) / 1e6);
    assert.equal(result.advicePlanHash, sealed.hash);
    assert.equal(result.configHash, adviceReservation(sealed, typedConfig).configHash);
    assert.equal(result.provider, typedConfig.provider);
    assert.equal(result.model, typedConfig.model);
    assert.equal(result.journalSha256, hash(await readFile(paths.journalPath, 'utf8')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
