process.env.NODE_TEST_CONTEXT = '1';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { type DecisionAdviceResult, Methods } from '@farmslot/protocol';

import { beginAssessment, finishAssessment } from '../assessment/store.js';
import { createRun, deleteRun, updateRun } from '../runs/store.js';
import { createGatewayAuthRuntime, initializeGatewayIdentity } from '../security/auth.js';
import { createWebSocketServer } from '../server.js';

/** Real gateway WebSocket dispatch through cdp.mjs gateway; zero external provider calls. */
test('decision advice gateway RPC gates on admission and refuses stale snapshots', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'decision-advice-rpc-'));
  const previousHome = process.env.FARMSLOT_HOME;
  const previousEnabled = process.env.FARMSLOT_DECISION_ADVICE_ENABLED;
  process.env.FARMSLOT_HOME = home;
  process.env.FARMSLOT_DECISION_ADVICE_ENABLED = 'true';
  const token = 'synthetic-only-gateway-proof';
  const runtime = createGatewayAuthRuntime({
    FARMSLOT_HOME: home,
    GATEWAY_HOST: '127.0.0.1',
    FARMSLOT_GATEWAY_AUTH_MODE: 'token',
    FARMSLOT_GATEWAY_TOKEN: token,
  });
  initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
  const server = createServer();
  const wss = createWebSocketServer(server, runtime);
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-farm',
    ticketOrPr: 'SYNTHETIC-RPC',
  });
  const decision = {
    id: `rpc-${run.id}`,
    type: 'engine_collision' as const,
    title: 'Synthetic collision',
    description: 'Invented work conflicts with invented task folder.',
    createdAt: new Date().toISOString(),
    actions: [
      {
        id: 'create-new',
        label: 'Create a fresh fixture',
        description: 'Use an isolated new fixture',
        style: 'primary' as const,
      },
      {
        id: 'start-comparison',
        label: 'Start comparison fixture',
        description: 'Compare against the existing fixture',
        style: 'secondary' as const,
      },
      { id: 'abort', label: 'Abort fixture', style: 'danger' as const },
    ],
  };
  updateRun(run.id, { status: 'blocked', decisions: [decision] });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing gateway test address');
    const cli = fileURLToPath(
      new URL('../../../../apps/command-center/scripts/cdp.mjs', import.meta.url),
    );
    const gatewayUrl = `ws://127.0.0.1:${address.port}`;
    const execute = promisify(execFile);
    const request = async (method: string, params: unknown): Promise<DecisionAdviceResult> => {
      const { stdout } = await execute(
        process.execPath,
        [cli, 'gateway', method, JSON.stringify(params)],
        {
          cwd: home,
          env: {
            ...process.env,
            FARMSLOT_GATEWAY: gatewayUrl,
            FARMSLOT_GATEWAY_TOKEN: token,
            FARMSLOT_RPC_TIMEOUT_MS: '15000',
          },
          timeout: 20_000,
        },
      );
      return JSON.parse(stdout) as DecisionAdviceResult;
    };
    const args = { runId: run.id, decisionId: decision.id };
    const pending = await request(Methods.DECISION_ADVICE_GET, args);
    assert.equal(pending.reason, 'not-admitted');
    assert.match(pending.snapshotHash ?? '', /^[a-f0-9]{64}$/);
    const stale = await request(Methods.DECISION_ADVICE_ANALYZE, {
      ...args,
      expectedSnapshotHash: 'f'.repeat(64),
    });
    assert.equal(stale.reason, 'stale');
    writeFileSync(
      path.join(home, 'decision-advice-policy.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            ...args,
            snapshotHash: pending.snapshotHash,
            classification: 'synthetic',
            sourceRef: 'synthetic:rpc-fixture-1',
          },
        ],
        price: {
          version: 1,
          provider: 'typesafe',
          model: 'jev-1.13.0',
          verifiedAt: new Date().toISOString(),
          source: 'https://docs.typesafe.ai/models',
          inputUsdPerMillion: 0.042,
          outputUsdPerMillion: 0,
          maxInputTokens: 65536,
          maxOutputTokens: 512,
        },
        limits: { maxCalls: 1, maxUsd: 0.01 },
      }),
    );
    assert.equal((await request(Methods.DECISION_ADVICE_GET, args)).eligible, true);
    decision.description = 'Changed invented work.';
    updateRun(run.id, { decisions: [decision] });
    assert.equal(
      (
        await request(Methods.DECISION_ADVICE_ANALYZE, {
          ...args,
          expectedSnapshotHash: pending.snapshotHash,
        })
      ).reason,
      'stale',
    );
    assert.equal(run.decisions[0]?.resolvedAt, undefined);
    const current = await request(Methods.DECISION_ADVICE_GET, args);
    const policyPath = path.join(home, 'decision-advice-policy.json');
    const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as {
      entries: Array<{ snapshotHash: string }>;
    };
    policy.entries[0].snapshotHash = current.snapshotHash!;
    writeFileSync(policyPath, JSON.stringify(policy));
    const resolved = runtime.resolver.resolveSecret(token, 'token');
    assert.equal(resolved.ok, true);
    if (!resolved.ok) throw new Error('Synthetic gateway principal unavailable');
    const record = await beginAssessment({
      ownerId: resolved.principal.id,
      consumer: 'decision-advice',
      subject: {
        run: {
          id: run.id,
          project: run.project,
          step: 'decision-advice',
          snapshotHash: current.snapshotHash!,
        },
      },
    });
    await finishAssessment(record, {
      status: 'completed',
      attempted: true,
      answers: {
        action: {
          type: 'choice',
          choice: 'invented-action',
          probabilities: { 'invented-action': 1 },
        },
      },
    });
    const invalid = await request(Methods.DECISION_ADVICE_GET, args);
    assert.equal(invalid.reason, 'assessment-unavailable');
    assert.equal(invalid.recommendedActionId, undefined);
    assert.equal(run.decisions[0]?.resolvedAt, undefined);
    updateRun(run.id, {
      decisions: [{ ...decision, resolvedAt: new Date().toISOString(), resolvedAction: 'abort' }],
    });
    assert.equal((await request(Methods.DECISION_ADVICE_GET, args)).reason, 'not-pending');
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    if (previousEnabled === undefined) delete process.env.FARMSLOT_DECISION_ADVICE_ENABLED;
    else process.env.FARMSLOT_DECISION_ADVICE_ENABLED = previousEnabled;
  }
});
