import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  blindReviewRows,
  blindReviewPacketHash,
  compareSessions,
  navigationReferenceHash,
  sealPlan,
  type NavigationReference,
} from './workflow-navigation.mts';
import type { MeasuredResponse } from '../../services/gateway/src/llm/measured-response.js';
import {
  reservation,
  priceResponse,
  runNavigationStudy,
  type RunnerApproval,
  type RunnerConfig,
} from './workflow-navigation-runner.mts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const cases = [
  {
    id: 'one',
    failure: 'The worker exited while starting its assigned run.',
    sources: [
      { id: 'runner.stderr', title: 'Runner stderr', text: 'exec: worker: command not found' },
      { id: 'slot.health', title: 'Slot health', text: 'healthy' },
    ],
  },
];
const reference: NavigationReference = {
  version: 1,
  status: 'frozen',
  references: [
    {
      caseId: 'one',
      label: 'environment',
      requiredReadIds: ['runner.stderr'],
      nextCheck: 'Inspect the configured executable.',
      family: 'runner-start',
    },
  ],
};
const provenance = {
  advicePlanHash: sha('advice-plan'),
  configHash: sha('advice-config'),
  provider: 'fixture',
  model: 'mock-advice',
  journalSha256: sha('advice-journal'),
  methodologyHash: sha('advice-method'),
};
const plan = () =>
  sealPlan(
    cases,
    [
      {
        caseId: 'one',
        text: 'Read the runner stderr.',
        receipt: {
          responseId: 'advice-id',
          receiptHash: sha('advice'),
          inputTokens: 3,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          providerDurationMs: 80,
          costUsd: 0.0002,
          elapsedMs: 7,
        },
      },
    ],
    { maxTurns: 3, maxReads: 2 },
    { referenceHash: navigationReferenceHash(reference), adviceProvenance: provenance },
  );
const config: RunnerConfig = {
  baseUrl: 'http://127.0.0.1:1',
  provider: 'fixture',
  model: 'test-model',
  reasoning: 'low',
  maxInputTokens: 4096,
  maxOutputTokens: 64,
  maxTotalTokens: 30000,
  maxTotalUsd: 0.1,
  price: {
    source: 'https://example.org/verified-price',
    verifiedAt: '2026-09-23T00:00:00Z',
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
    cacheReadMultiplier: 1,
    cacheWriteMultiplier: 1,
  },
};
const action = (read: boolean) =>
  JSON.stringify(
    read
      ? { action: 'read_evidence', id: 'runner.stderr', label: '', nextCheck: '', evidenceIds: [] }
      : {
          action: 'answer',
          id: '',
          label: 'environment',
          nextCheck: 'inspect the configured executable',
          evidenceIds: ['runner.stderr'],
        },
  );

async function approvedPaths(directory: string, configHash: string, planHash: string) {
  const methodologyPath = path.join(directory, 'method.md');
  const approvalPath = path.join(directory, 'approval.json');
  const journalPath = path.join(directory, 'journal.jsonl');
  const method = 'Independently reviewed cases, advice and price for this bounded fixture.';
  await writeFile(methodologyPath, method);
  const approval: RunnerApproval = {
    planHash,
    configHash,
    methodologyHash: sha(method),
    reviewer: 'human-reviewer',
    journalPath,
    conclusion: 'approved',
  };
  await writeFile(approvalPath, JSON.stringify(approval));
  return { approvalPath, methodologyPath, journalPath, apiKey: 'injected-test-key' };
}

test('ordinary cache writes can be unreported; premium cache writes require a receipt', () => {
  const response = {
    attempted: true as const,
    status: 'completed' as const,
    requestedModel: config.model,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 10,
    cacheWriteTokens: null,
    inputAccounting: 'includes-cache' as const,
    durationMs: 1,
    responseReceived: true,
  };
  assert.equal(priceResponse(response, config), 0.00012);
  assert.equal(
    priceResponse(response, {
      ...config,
      price: { ...config.price, cacheWriteMultiplier: 1.25 },
    }),
    null,
  );
});

test('invalid independent approval blocks transport and leaves no journal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'navigation-gate-'));
  try {
    const sealed = plan();
    const paths = await approvedPaths(directory, 'wrong-config-hash', sealed.hash);
    let calls = 0;
    await assert.rejects(
      () =>
        runNavigationStudy(sealed, config, paths, async () => {
          calls++;
          throw new Error('must not call');
        }),
      /approval does not match/,
    );
    assert.equal(calls, 0);
    await assert.rejects(() => readFile(paths.journalPath), /ENOENT/);
    await assert.rejects(() => readFile(paths.approvalPath + '.used'), /ENOENT/);
    assert.throws(
      () => reservation(sealed, { ...config, maxTotalUsd: 0.00001 }),
      /reserved budget/,
    );
    assert.throws(
      () =>
        reservation(sealed, {
          ...config,
          price: { ...config.price, verifiedAt: '2000-01-01T00:00:00Z' },
        }),
      /Verified price required/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('approved fixture alternates evidence reads and answers with native receipts in a journal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'navigation-approved-'));
  try {
    const sealed = plan();
    const paths = await approvedPaths(
      directory,
      reservation(sealed, config).configHash,
      sealed.hash,
    );
    let calls = 0;
    const result = await runNavigationStudy(sealed, config, paths, async (request) => {
      const parsed = JSON.parse(request.prompt);
      const read = parsed.actions.length === 0;
      assert.equal(parsed.reads.length, read ? 0 : 1);
      const text = action(read);
      const id = `call-${++calls}`;
      return {
        attempted: true,
        status: 'completed',
        requestedModel: config.model,
        returnedModel: config.model,
        responseId: id,
        receiptHash: sha(id),
        responseReceived: true,
        text,
        inputTokens: 50,
        outputTokens: 25,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputAccounting: 'includes-cache',
        durationMs: 3,
      };
    });
    assert.equal(result.stopReason, 'completed');
    assert.equal(calls, 4);
    assert.deepEqual(
      result.sessions.map((session) => session.status),
      ['answered', 'answered'],
    );
    const rows = (await readFile(paths.journalPath, 'utf8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row));
    assert.equal(rows.filter((row) => row.kind === 'started').length, 4);
    assert.equal(rows.filter((row) => row.kind === 'finished').length, 4);
    assert.equal(rows.at(-1).stopReason, 'completed');
    assert.deepEqual(
      {
        planHash: result.planHash,
        configHash: result.configHash,
        provider: result.provider,
        model: result.model,
        methodologyHash: result.methodologyHash,
        journalSha256: result.journalSha256,
      },
      {
        planHash: sealed.hash,
        configHash: reservation(sealed, config).configHash,
        provider: config.provider,
        model: config.model,
        methodologyHash: sha(await readFile(paths.methodologyPath, 'utf8')),
        journalSha256: sha(await readFile(paths.journalPath, 'utf8')),
      },
    );
    const judgment = {
      version: 1 as const,
      packetHash: blindReviewPacketHash(sealed, result.sessions),
      methodologyHash: sha('worker-method'),
      reviewer: 'test-reviewer',
      decisions: blindReviewRows(sealed, result.sessions).map((row) => ({
        blindId: row.blindId,
        decision: 'accepted' as const,
        reason: 'Supported by read stderr',
      })),
    };
    const comparison = compareSessions(sealed, result.sessions, reference, judgment);
    assert.equal(comparison.equalQualityPairs, 1);
    assert.deepEqual(comparison.pairs[0].tokens, { baseline: 150, assisted: 158 });
    await assert.rejects(
      () =>
        runNavigationStudy(sealed, config, paths, async () => {
          throw new Error('must not repeat');
        }),
      /EEXIST/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an HTTP provider error is not misreported as a worker action', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'navigation-provider-error-'));
  try {
    const sealed = plan();
    const paths = await approvedPaths(
      directory,
      reservation(sealed, config).configHash,
      sealed.hash,
    );
    const result = await runNavigationStudy(sealed, config, paths, async () => ({
      attempted: true,
      status: 'unavailable',
      requestedModel: config.model,
      responseReceived: true,
      httpStatus: 401,
      error: 'provider-http-error',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      inputAccounting: 'includes-cache',
      durationMs: 1,
    }));
    assert.equal(result.stopReason, 'unknown-charge');
    const rows = (await readFile(paths.journalPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(rows[2].reason, 'provider-http-error');
    assert.equal(rows[2].httpStatus, 401);
    assert.equal(rows.at(-1).stopReason, 'unknown-charge');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('transport ambiguity leaves a started attempt and unknown charge in the closed journal', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'navigation-unknown-'));
  try {
    const sealed = plan();
    const paths = await approvedPaths(
      directory,
      reservation(sealed, config).configHash,
      sealed.hash,
    );
    const result = await runNavigationStudy(sealed, config, paths, async () => {
      throw new Error('connection broke after dispatch');
    });
    assert.equal(result.stopReason, 'unknown-charge');
    assert.equal(
      compareSessions(sealed, result.sessions, reference, {
        version: 1,
        packetHash: blindReviewPacketHash(sealed, result.sessions),
        methodologyHash: sha('worker-method'),
        reviewer: 'test-reviewer',
        decisions: blindReviewRows(sealed, result.sessions).map((row) => ({
          blindId: row.blindId,
          decision: 'unresolved' as const,
          reason: 'Request failed',
        })),
      }).equalQualityPairs,
      0,
    );
    const rows = (await readFile(paths.journalPath, 'utf8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row));
    assert.deepEqual(
      rows.map((row) => row.kind),
      ['approved', 'started', 'failed', 'session-closed', 'closed'],
    );
    assert.equal(rows[2].reason, 'transport-unknown-charge');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const completedResponse = (overrides: Partial<MeasuredResponse> = {}): MeasuredResponse => ({
  attempted: true,
  status: 'completed',
  requestedModel: config.model,
  returnedModel: config.model,
  responseId: 'worker-response',
  receiptHash: sha('worker-response'),
  responseReceived: true,
  text: action(true),
  inputTokens: 50,
  outputTokens: 25,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputAccounting: 'includes-cache',
  durationMs: 3,
  ...overrides,
});

test('rejected completed responses have one failed attempt and no finished turn', async (t) => {
  const cases: {
    name: string;
    response: Partial<MeasuredResponse>;
    reason: string;
    stop: string;
  }[] = [
    {
      name: 'invalid action with unknown usage',
      response: { text: '{bad', inputTokens: null },
      reason: 'unverified-response',
      stop: 'unknown-charge',
    },
    {
      name: 'invalid action with known usage',
      response: { text: '{bad' },
      reason: 'invalid-action',
      stop: 'invalid-action',
    },
    {
      name: 'wrong model',
      response: { returnedModel: 'wrong-model' },
      reason: 'unverified-response',
      stop: 'unverified-response',
    },
    {
      name: 'missing response id',
      response: { responseId: undefined },
      reason: 'unverified-response',
      stop: 'unverified-response',
    },
    {
      name: 'invalid receipt hash',
      response: { receiptHash: 'bad-hash' },
      reason: 'unverified-response',
      stop: 'unverified-response',
    },
    {
      name: 'usage over cap',
      response: { outputTokens: config.maxOutputTokens + 1 },
      reason: 'unverified-response',
      stop: 'unverified-response',
    },
    {
      name: 'invalid cache usage',
      response: { cacheReadTokens: -1 },
      reason: 'unverified-response',
      stop: 'unknown-charge',
    },
    {
      name: 'invalid evidence read',
      response: {
        text: JSON.stringify({
          action: 'read_evidence',
          id: 'missing-source',
          label: '',
          nextCheck: '',
          evidenceIds: [],
        }),
      },
      reason: 'invalid-action',
      stop: 'invalid-action',
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'navigation-rejected-'));
      try {
        const sealed = plan();
        const paths = await approvedPaths(
          directory,
          reservation(sealed, config).configHash,
          sealed.hash,
        );
        let calls = 0;
        const result = await runNavigationStudy(sealed, config, paths, async () => {
          calls++;
          return completedResponse(fixture.response);
        });
        assert.equal(calls, 1);
        assert.equal(result.stopReason, fixture.stop);
        assert.equal(result.sessions.length, 1);
        assert.equal(result.sessions[0].turns.length, 0);
        const rows = (await readFile(paths.journalPath, 'utf8'))
          .trim()
          .split('\n')
          .map((row) => JSON.parse(row));
        assert.deepEqual(
          rows.map((row) => row.kind),
          ['approved', 'started', 'failed', 'session-closed', 'closed'],
        );
        assert.equal(rows[2].reason, fixture.reason);
        assert.equal(rows[4].attempts, 1);
        assert.equal(rows[4].stopReason, fixture.stop);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('an incomplete response with an action-shaped provider error is still unknown charge', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'navigation-incomplete-unknown-charge-'));
  try {
    const sealed = plan();
    const paths = await approvedPaths(
      directory,
      reservation(sealed, config).configHash,
      sealed.hash,
    );
    const result = await runNavigationStudy(sealed, config, paths, async () => ({
      attempted: true,
      status: 'unavailable',
      requestedModel: config.model,
      responseReceived: false,
      error: 'invalid-action',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      inputAccounting: 'includes-cache',
      durationMs: 1,
    }));
    const rows = (await readFile(paths.journalPath, 'utf8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row));
    assert.equal(result.stopReason, 'unknown-charge');
    assert.equal(rows[2].reason, 'invalid-action');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('duplicate provider identity rejects the second turn before journaling it as finished', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'navigation-duplicate-'));
  try {
    const sealed = plan();
    const paths = await approvedPaths(
      directory,
      reservation(sealed, config).configHash,
      sealed.hash,
    );
    let calls = 0;
    const result = await runNavigationStudy(sealed, config, paths, async () =>
      completedResponse({ text: action(++calls === 1) }),
    );
    assert.equal(calls, 2);
    assert.equal(result.stopReason, 'unverified-response');
    assert.equal(result.sessions[0].turns.length, 1);
    const rows = (await readFile(paths.journalPath, 'utf8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row));
    assert.deepEqual(
      rows.map((row) => row.kind),
      ['approved', 'started', 'finished', 'started', 'failed', 'session-closed', 'closed'],
    );
    assert.equal(rows[4].reason, 'unverified-response');
    assert.equal(rows[6].attempts, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
