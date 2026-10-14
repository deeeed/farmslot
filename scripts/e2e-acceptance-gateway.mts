#!/usr/bin/env tsx
import { testGatewayIdentity } from './lib/test-gateway-identity.mjs';
/** Manual public-RPC proof. Disposable inputs are seeded before startup; no runner is launched. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import type { RunRecipeRunsForRunResult, TaskProgressResult } from '@farmslot/protocol';
import { criteria, proveLedgerCutover } from './e2e-acceptance-ledger.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const work =
  process.env.FARMSLOT_LEDGER_PROOF_ROOT ??
  mkdtempSync(path.join(tmpdir(), 'ledger-gateway-proof-'));
const root = path.join(work, 'root');
const checkout = path.join(root, 'checkout');
const project = 'ledger-proof';
const runsDir = path.join(root, '.runs');
const retainedRunFile = existsSync(runsDir)
  ? readdirSync(runsDir).find((file) => /^[a-f0-9-]{36}\.json$/.test(file))
  : undefined;
const runId = retainedRunFile ? retainedRunFile.slice(0, -5) : randomUUID();
const slotId = 'ledger-proof-slot';
const taskDir = path.join(checkout, 'tasks/current');
const retained = path.join(root, 'projects', project, 'tasks/current');
const out = path.resolve(process.env.FARMSLOT_LEDGER_PROOF_OUT ?? 'temp/ledger-cutover-proof');
let child: ChildProcess | undefined;
const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function waitFor(ready: () => boolean, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Gateway did not become ready. Inspect the retained gateway log.');
}
try {
  mkdirSync(checkout, { recursive: true });
  const proof = retainedRunFile
    ? {
        claims: JSON.parse(
          readFileSync(path.join(taskDir, 'artifacts/acceptance-status.json'), 'utf8'),
        ),
      }
    : await proveLedgerCutover(taskDir, checkout);
  for (const directory of [root, checkout]) {
    if (!existsSync(path.join(directory, '.git/refs/heads/proof'))) {
      execFileSync('git', ['init', '--quiet', directory]);
      execFileSync('git', [
        '-C',
        directory,
        'fetch',
        '--quiet',
        '--update-shallow',
        source,
        'HEAD',
      ]);
      execFileSync('git', ['-C', directory, 'symbolic-ref', 'HEAD', 'refs/heads/proof']);
      execFileSync('git', ['-C', directory, 'update-ref', 'refs/heads/proof', 'FETCH_HEAD']);
    }
  }
  writeJson(path.join(root, 'services/gateway/package.json'), { name: 'proof', version: '0.0.0' });
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable ledger proof\n');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
  writeJson(path.join(root, 'projects', project, 'project.json'), {
    name: project,
    runtime_dir: 'tasks',
    task_dir_name: 'tasks',
    hooks: {},
  });
  writeJson(path.join(root, 'pool/local.json'), {
    schema_version: 2,
    machine: hostname(),
    host: 'localhost',
    ssh_user: userInfo().username,
    os: process.platform,
    project,
    platform: 'cli',
    slots: [
      {
        id: slotId,
        project,
        platform: 'cli',
        repo: checkout,
        session: slotId,
        enabled: true,
        mode: 'dispatch',
      },
    ],
  });
  writeJson(path.join(root, 'pool/status-local.json'), {
    slots: [{ slot: slotId, lifecycle: 'held', phase: 'occupied', current_run_id: runId }],
  });
  const { cpSync } = await import('node:fs');
  cpSync(taskDir, retained, { recursive: true });
  const now = new Date().toISOString();
  writeJson(path.join(root, '.runs', `${runId}.json`), {
    id: runId,
    familyId: randomUUID(),
    parentRunId: null,
    familyRootTicketOrPr: 'LEDGER-PROOF',
    lane: 'production',
    variant: null,
    flowType: 'ci-fix',
    mode: 'interactive',
    status: 'done',
    project,
    ticketOrPr: 'LEDGER-PROOF',
    slotId,
    branch: 'fix/ledger-proof',
    recordedEvidenceContractVersion: 1,
    taskFile: path.join(retained, 'TASK.md'),
    createdAt: now,
    updatedAt: now,
    ticketData: {
      title: 'Ledger proof',
      description: '',
      source: 'manual',
      acceptanceCriteria: criteria,
    },
    metrics: {
      runner: 'scripted',
      model: null,
      nudgeCount: 0,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    steps: [],
    decisions: [],
    agentContexts: [
      {
        id: 'primary',
        role: 'primary',
        runId,
        slotId,
        label: 'Worker',
        status: 'complete',
        taskFile: 'tasks/current/TASK.md',
        runner: 'scripted',
      },
    ],
  });
  const port = await freePort();
  const env = {
    ...process.env,
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(work, 'home'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
    FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, '.runs/capabilities.json'),
    FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
    FARMSLOT_GATEWAY_PROFILE:
      (testGatewayIdentity(path.join(work, 'home'), `ws://127.0.0.1:${port}`), 'proof'),
    FARMSLOT_GATEWAY_PASSWORD: '',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    FARMSLOT_DEMO_POOL: '0',
    NODE_TEST_CONTEXT: '1',
    TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
  };
  mkdirSync(out, { recursive: true });
  const logFile = path.join(out, 'gateway.log');
  const { openSync, closeSync } = await import('node:fs');
  const log = openSync(logFile, 'w');
  try {
    child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--experimental-test-module-mocks',
        '--import',
        path.join(source, 'services/gateway/src/runtime/mock-pty.test-support.ts'),
        path.join(source, 'services/gateway/src/index.ts'),
      ],
      { cwd: source, env, stdio: ['ignore', log, log] },
    );
  } finally {
    closeSync(log);
  }
  await waitFor(() => {
    if (child?.exitCode !== null)
      throw new Error('Gateway exited: ' + readFileSync(logFile, 'utf8'));
    return readFileSync(logFile, 'utf8').includes('Gateway daemon listening');
  });
  const rpc = (method: string, params: unknown) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(source, 'apps/command-center/scripts/cdp.mjs'),
          'gateway',
          method,
          JSON.stringify(params),
        ],
        { cwd: source, env, encoding: 'utf8', timeout: 30_000 },
      ),
    );
  const progress = rpc('task.progress', { slotId, runId }) as TaskProgressResult;
  assert.equal(progress.acceptanceStatus?.schemaVersion, 2);
  assert.deepEqual(
    progress.acceptanceCriteria?.map((row) => row.id),
    ['AC-1', 'AC-2', 'AC-3'],
  );
  assert.deepEqual(
    progress.acceptanceStatus?.criteria.map((row) => row.verdict),
    ['proven', 'proven', 'proven'],
  );
  assert.equal(progress.acceptanceEvidenceLinks, undefined);
  const evidence = rpc('run.recipeRunsForRun', {
    runId,
    includeRecordedEvidence: true,
  }) as RunRecipeRunsForRunResult;
  assert.ok(evidence.recordedEvidence?.input, JSON.stringify(evidence));
  const model = createEvidenceReviewModel({
    contractVersion: evidence.recordedEvidence.contractVersion,
    package: evidence.recordedEvidence.input,
    criteria: progress.acceptanceCriteria,
    ledger: progress.acceptanceStatus,
    artifactPrefix: evidence.recordedEvidence.artifactPrefix,
    readErrors: evidence.recordedEvidence.errors,
  });
  assert.deepEqual(model.errors, []);
  assert.equal(model.packageStatus?.status, 'Valid');
  assert.equal(model.summary.proven, 3);
  assert.equal(model.claims[0].status?.verdict, 'proven');
  writeJson(path.join(out, 'result.json'), {
    status: 'pass',
    runId,
    selectedRecipeRunId: proof.claims.recipeRunId,
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: source,
      encoding: 'utf8',
    }).trim(),
    checks: [
      'public CLI negative assertion fails',
      'missing engine claim refuses completion',
      'manual writes refuse without changing bytes',
      'schema2 complete accepted',
      'public task.progress preserves the engine projection',
      'public run.recipeRunsForRun validates selected package',
    ],
    recording: proof.claims.recording.status,
    root,
    out,
  });
  console.log(JSON.stringify({ status: 'pass', runId, out, root }, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 900))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  // Retain this manual proof directory for inspection. It belongs only to this isolated validation run.
}
