process.env.NODE_TEST_CONTEXT = '1';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { type AcceptanceEvidenceResult, Methods } from '@farmslot/protocol';

import { createRun, deleteRun, updateRun } from '../runs/store.js';
import { createGatewayAuthRuntime, initializeGatewayIdentity } from '../security/auth.js';

/** Real WebSocket dispatch and audit read, with no provider transport. */
test('acceptance evidence RPC refuses stale and unadmitted input and leaves ledger intact', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'acceptance-evidence-rpc-'));
  const oldHome = process.env.FARMSLOT_HOME;
  const oldEnabled = process.env.FARMSLOT_ACCEPTANCE_EVIDENCE_ENABLED;
  const oldAssessmentEnabled = process.env.FARMSLOT_ASSESSMENT_ENABLED;
  const oldProvider = process.env.FARMSLOT_ASSESSMENT_PROVIDER;
  const oldModel = process.env.FARMSLOT_ASSESSMENT_MODEL;
  const oldKey = process.env.CODEX_LB_API_KEY;
  const oldFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (_input, init) => {
    providerCalls++;
    const request = JSON.parse(String(init?.body));
    assert.equal(request.model, 'fixture-model');
    assert.match(JSON.stringify(request), /The output reads ready/);
    return new Response(
      JSON.stringify({
        id: 'resp_synthetic',
        model: 'fixture-model',
        status: 'completed',
        usage: { input_tokens: 210, output_tokens: 12 },
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: JSON.stringify({ answers: { verdict: 'supported' } }) },
            ],
          },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  process.env.FARMSLOT_HOME = home;
  Object.assign(process.env, {
    FARMSLOT_ACCEPTANCE_EVIDENCE_ENABLED: 'true',
    FARMSLOT_ASSESSMENT_ENABLED: 'true',
    FARMSLOT_ASSESSMENT_PROVIDER: 'codex-lb',
    FARMSLOT_ASSESSMENT_MODEL: 'fixture-model',
    CODEX_LB_API_KEY: 'synthetic-test-credential',
  });
  // Provider composition captures fetch on import. This fixture answers in-process;
  // no request reaches a live LLM endpoint.
  const { createWebSocketServer } = await import('../server.js');
  const token = 'synthetic-only-ac-gateway-proof';
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
  const dir = path.join(home, 'tasks', run.id);
  mkdirSync(path.join(dir, 'inputs'), { recursive: true });
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  updateRun(run.id, { taskFile: path.join(dir, 'TASK.md') });
  writeFileSync(
    path.join(dir, 'inputs', 'handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: ['The output reads ready'] } }),
  );
  const ledger = path.join(dir, 'artifacts', 'acceptance-status.json');
  writeFileSync(
    ledger,
    JSON.stringify({
      schemaVersion: 1,
      criteria: [
        {
          id: 'AC-1',
          text: 'The output reads ready',
          verdict: 'weak',
          proofMode: 'state',
          evidence: ['artifacts/output.md'],
          recipeNodes: [],
          updatedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  const originalLedger = readFileSync(ledger, 'utf8');
  writeFileSync(path.join(dir, 'artifacts', 'output.md'), 'The output reads ready.');
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test gateway address');
    const gatewayPort = address.port;
    const cli = fileURLToPath(
      new URL('../../../../apps/command-center/scripts/cdp.mjs', import.meta.url),
    );
    const execute = promisify(execFile);
    async function request(method: string, params: unknown): Promise<unknown> {
      const { stdout } = await execute(
        process.execPath,
        [cli, 'gateway', method, JSON.stringify(params)],
        {
          cwd: home,
          env: {
            ...process.env,
            FARMSLOT_GATEWAY: `ws://127.0.0.1:${gatewayPort}`,
            FARMSLOT_GATEWAY_TOKEN: token,
            FARMSLOT_RPC_TIMEOUT_MS: '15000',
          },
          timeout: 20_000,
        },
      );
      return JSON.parse(stdout);
    }
    const params = { runId: run.id, criterionId: 'AC-1' };
    const preview = (await request(
      Methods.ACCEPTANCE_EVIDENCE_GET,
      params,
    )) as AcceptanceEvidenceResult;
    assert.equal(preview.reason, 'not-admitted');
    assert.match(preview.snapshotHash ?? '', /^[a-f0-9]{64}$/);
    assert.deepEqual(preview.evidence, [
      { id: 'artifacts/output.md', text: 'The output reads ready.' },
    ]);
    const refused = (await request(Methods.ACCEPTANCE_EVIDENCE_ANALYZE, {
      ...params,
      expectedSnapshotHash: 'f'.repeat(64),
    })) as AcceptanceEvidenceResult;
    assert.equal(refused.reason, 'stale');
    assert.equal(
      (
        (await request(Methods.ACCEPTANCE_EVIDENCE_ANALYZE, {
          ...params,
          expectedSnapshotHash: preview.snapshotHash,
        })) as AcceptanceEvidenceResult
      ).reason,
      'not-admitted',
    );
    assert.deepEqual(
      (
        (await request(Methods.ASSESSMENT_LIST, { consumer: 'acceptance-evidence' })) as {
          records: unknown[];
        }
      ).records,
      [],
    );
    assert.equal(providerCalls, 0);
    writeFileSync(
      path.join(home, 'acceptance-evidence-policy.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            ...params,
            snapshotHash: preview.snapshotHash,
            classification: 'synthetic',
            sourceRef: 'synthetic:rpc-fixture',
          },
        ],
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
      }),
    );
    const analyzed = (await request(Methods.ACCEPTANCE_EVIDENCE_ANALYZE, {
      ...params,
      expectedSnapshotHash: preview.snapshotHash,
    })) as AcceptanceEvidenceResult;
    assert.equal(analyzed.verdict, 'supported');
    assert.equal(analyzed.assessment?.attempted, true);
    assert.equal(providerCalls, 1);
    assert.equal(
      ((await request(Methods.ACCEPTANCE_EVIDENCE_GET, params)) as AcceptanceEvidenceResult)
        .verdict,
      'supported',
    );
    assert.equal(providerCalls, 1);
    const history = (await request(Methods.ASSESSMENT_LIST, {
      consumer: 'acceptance-evidence',
    })) as {
      records: Array<{
        id: string;
        consumer: string;
        subject: { run: { criterion: { evidence: Array<{ text: string }> } } };
        result: { usage: { costKind: string } };
      }>;
    };
    assert.equal(history.records.length, 1);
    assert.equal(history.records[0].consumer, 'acceptance-evidence');
    assert.equal(
      history.records[0].subject.run.criterion.evidence[0].text,
      'The output reads ready.',
    );
    assert.equal(history.records[0].result.usage.costKind, 'estimated');
    const byId = (await request(Methods.ASSESSMENT_GET, { id: history.records[0].id })) as {
      id: string;
    };
    assert.equal(byId.id, history.records[0].id);
    assert.equal(readFileSync(ledger, 'utf8'), originalLedger);
    writeFileSync(
      ledger,
      JSON.stringify({
        schemaVersion: 1,
        criteria: [
          {
            id: 'AC-1',
            text: 'The output reads ready',
            verdict: 'weak',
            proofMode: 'mixed',
            evidence: ['artifacts/output.md'],
            recipeNodes: [],
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
    );
    assert.equal(
      ((await request(Methods.ACCEPTANCE_EVIDENCE_GET, params)) as AcceptanceEvidenceResult).reason,
      'non-textual',
    );
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
    rmSync(home, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = oldHome;
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries({
      FARMSLOT_ACCEPTANCE_EVIDENCE_ENABLED: oldEnabled,
      FARMSLOT_ASSESSMENT_ENABLED: oldAssessmentEnabled,
      FARMSLOT_ASSESSMENT_PROVIDER: oldProvider,
      FARMSLOT_ASSESSMENT_MODEL: oldModel,
      CODEX_LB_API_KEY: oldKey,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
