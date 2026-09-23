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
import {
  collisionDecisionActions,
  handleCollisionDecision,
  resolveEngineDecision,
} from '../run-engine/engine-decisions.js';
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
  const dir = `synthetic-${run.id.slice(0, 8)}`;
  const prior = createRun({
    flowType: 'fix-bug',
    project: 'example-farm',
    ticketOrPr: 'SYNTHETIC-RPC',
  });
  updateRun(prior.id, { status: 'done', taskFile: `/synthetic/${dir}/TASK.md` });
  // Exercise the same engine function that creates a pending collision in a live run.
  const collision = handleCollisionDecision(run.id, run, [dir], dir);
  const decision = run.decisions.find((item) => item.type === 'engine_collision');
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(decision);
    assert.equal(decision.description, `Task dir collision for ${dir}: ${dir}`);
    assert.deepEqual(decision.actions, collisionDecisionActions(run));
    assert.equal(decision.payload?.kind, 'collision');
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
    const resolved = runtime.resolver.resolveSecret(token, 'token');
    assert.equal(resolved.ok, true);
    if (!resolved.ok) throw new Error('Synthetic gateway principal unavailable');
    const validRecord = await beginAssessment({
      ownerId: resolved.principal.id,
      consumer: 'decision-advice',
      subject: {
        run: {
          id: run.id,
          project: run.project,
          step: 'decision-advice',
          snapshotHash: pending.snapshotHash!,
        },
      },
    });
    // A stored action choice is displayed, but the engine gate remains pending.
    // This checks transport and validation, not the quality of a model recommendation.
    await finishAssessment(validRecord, {
      status: 'completed',
      attempted: true,
      provider: 'typesafe',
      returnedModel: 'jev-1.13.0',
      usage: {
        provider: 'typesafe',
        requestedModel: 'jev-1.13.0',
        durationMs: 1,
        inputTokens: 100,
        outputTokens: 5,
      },
      answers: {
        action: {
          type: 'choice',
          choice: 'start-comparison',
          probabilities: { 'start-comparison': 1 },
        },
      },
    });
    const valid = await request(Methods.DECISION_ADVICE_GET, args);
    assert.equal(valid.recommendedActionId, 'start-comparison');
    assert.equal(run.decisions[0]?.resolvedAt, undefined);
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
      provider: 'typesafe',
      returnedModel: 'jev-1.13.0',
      usage: {
        provider: 'typesafe',
        requestedModel: 'jev-1.13.0',
        inputTokens: 30,
        outputTokens: 10,
        durationMs: 1,
      },
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
    assert.equal(invalid.assessment?.error, 'Invalid advisory choice');
    assert.equal(invalid.recommendedActionId, undefined);
    assert.equal(run.decisions[0]?.resolvedAt, undefined);
    resolveEngineDecision(decision.id, 'abort');
    await assert.rejects(collision, /Aborted: task dir collision/);
    assert.equal((await request(Methods.DECISION_ADVICE_GET, args)).reason, 'not-pending');
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (decision && !run.decisions[0]?.resolvedAt) {
      resolveEngineDecision(decision.id, 'abort');
      await assert.rejects(collision, /Aborted: task dir collision/);
    }
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
    await deleteRun(prior.id);
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    if (previousEnabled === undefined) delete process.env.FARMSLOT_DECISION_ADVICE_ENABLED;
    else process.env.FARMSLOT_DECISION_ADVICE_ENABLED = previousEnabled;
  }
});

/** The blinded reference must contain only facts available in the admitted packet. */
test('synthetic collision cases match engine packet and abstain without operator intent', () => {
  const cases = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../../scripts/decision-advice/cases.v1.json', import.meta.url)),
      'utf8',
    ),
  ) as {
    cases: Array<{
      id: string;
      type: string;
      description: string;
      actions: Array<{ id: string; label: string; description: string }>;
    }>;
  };
  const labels = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../../scripts/decision-advice/labels.v1.json', import.meta.url)),
      'utf8',
    ),
  ) as { labels: Record<string, string | null> };
  const collisionCases = cases.cases.filter((item) => item.type === 'engine_collision');
  assert.equal(collisionCases.length, 6);
  for (const item of collisionCases) {
    assert.equal(labels.labels[item.id], 'abstain', item.id);
    assert.deepEqual(
      item.actions,
      collisionDecisionActions({ lane: 'production' }).map(({ id, label, description }) => ({
        id,
        label,
        description,
      })),
      item.id,
    );
    assert.match(item.description, /^Task dir collision for ([\w-]+): [\w, -]+$/);
  }
});
