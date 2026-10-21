// Manual loopback RPC proof. Creates no farm dispatch, worker or reviewer.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  Methods,
  runClaimOverrideSnapshotIdentity,
  type RunOverrideClaimResult,
} from '@farmslot/protocol';

await import('../../runtime/mock-pty.test-support.js');

const proofRoot = await mkdtemp(path.join(os.tmpdir(), 'claim-override-rpc-'));
process.env.NODE_TEST_CONTEXT = '1';
process.env.FARMSLOT_PROJECTS_DIR = path.join(proofRoot, 'projects');
process.env.FARMSLOT_RUNS_DIR = path.join(proofRoot, 'runs');
process.env.FARMSLOT_POOL_DIR = path.join(proofRoot, 'pool');
process.env.FARMSLOT_TEST_STATUS_FILE = path.join(proofRoot, 'status.json');
await mkdir(path.join(proofRoot, 'projects/test-project'), { recursive: true });
await writeFile(
  path.join(proofRoot, 'projects/test-project/project.json'),
  JSON.stringify({ name: 'test-project', default_branch: 'main' }),
);
const { fixture } = await import('./claim-overrides.test.js');
const { getRun, updateRun } = await import('../../runs/store.js');
const { captureRunOutput } = await import('../../run-completion/output.js');
const { resolveWorkerTerminalContract } = await import('../../tasks/worker-terminal-contract.js');
const { buildHandoffMetadata } =
  await import('../../../../../packages/agent-runtime/src/task-init/task-document.js');

test('authenticated override RPC returns a refreshed gate without starting a review', async (t) => {
  t.after(() => rm(proofRoot, { recursive: true, force: true }));
  const f = await fixture(t);
  const task = path.dirname(f.run.taskFile!);
  const mode = f.run.mode ?? 'interactive';
  const contract = resolveWorkerTerminalContract({}, f.run.flowType, { mode });
  contract.recordedEvidenceContractVersion = f.run.recordedEvidenceContractVersion ?? 0;
  const handoff = buildHandoffMetadata({
    attemptId: f.run.id,
    surface: 'cli',
    project: f.run.project,
    flow: f.run.flowType,
    title: 'Claim override protocol proof',
    sourceKind: 'text',
    acceptanceCriteria: [f.input.claims!.criteria[0].text],
    terminalContract: contract,
  });
  await mkdir(path.join(task, 'inputs'), { recursive: true });
  await Promise.all(
    Object.entries({
      'TASK.md': '# Claim override protocol proof\n',
      'inputs/handoff.json': JSON.stringify(handoff),
      'inputs/worker-terminal-contract.json': JSON.stringify(contract),
      'artifacts/acceptance-status.json': JSON.stringify(f.input.claims),
      'artifacts/latest-valid-recipe-run.json': JSON.stringify({
        version: 1,
        relativeArtifactRoot: 'recipe-runs/attempt',
      }),
      'artifacts/report.md': 'Isolated claim override proof.\n',
      'artifacts/pr-description.md': '## Summary\n\nIsolated claim override proof.\n',
    }).map(([file, bytes]) => writeFile(path.join(task, file), bytes)),
  );
  updateRun(f.run.id, { mode });
  await captureRunOutput(f.run.id, false, true);
  const ledgerBefore = await readFile(path.join(task, 'artifacts/acceptance-status.json'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'claim-override-auth-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { createGatewayAuthRuntime } = await import('../../security/auth.js');
  const { createWebSocketServer } = await import('../../server.js');
  const { GatewayClient } = await import('../../../../../packages/cli/src/gateway-client.js');
  const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
  const person = runtime.writer.createPrincipal(
    { type: 'person', displayName: 'Protocol fixture' },
    [{ role: 'admin', scope: { kind: 'global' } }],
  );
  const credential = runtime.writer.issueCredential(person.id, 'Disposable fixture');
  const grant = runtime.writer.exchangePersonCredential(credential.secret, {
    deviceName: 'Loopback fixture',
    deviceKind: 'cli',
  });
  const server = createServer();
  const wss = createWebSocketServer(server, runtime);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    timeout: 10000,
    credential: { token: grant.accessToken },
  });
  const result = await client.call<RunOverrideClaimResult>(Methods.RUN_OVERRIDE_CLAIM, {
    ...f.params,
    snapshotIdentity: runClaimOverrideSnapshotIdentity(f.decision),
  });
  const current = getRun(f.run.id)!;
  const gate = current.decisions.find(({ id }) => id === f.decision.id);
  assert.ok(gate?.payload?.kind === 'ready' && gate.payload.prPackage);
  assert.equal(gate.resolvedAt, undefined);
  assert.notEqual(gate.payload.prPackage.packageHash, f.prepared.packageHash);
  assert.deepEqual(gate.payload.prPackage.claimOverrideReceiptIds, [result.receipt.id]);
  assert.equal(result.receipt.approver.principalId, person.id);
  assert.equal(current.agentContexts?.length ?? 0, 0);
  assert.equal(current.reviewRoundAdmissions?.length ?? 0, 0);
  assert.deepEqual(
    await readFile(path.join(task, 'artifacts/acceptance-status.json')),
    ledgerBefore,
  );
  assert.ok(gate.payload.gateReadiness);
  assert.ok(
    !gate.payload.gateReadiness.reasons.some(
      ({ code }) => code === 'evidence-override-refresh-required',
    ),
  );
});
