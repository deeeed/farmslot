// Manual public-RPC proof. All mutations stay in disposable state; retained
// production receipts and their output files are inspected read-only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Run } from '@farmslot/protocol';
import type { WebSocketServer } from 'ws';

const source = process.cwd();
const root = mkdtempSync(path.join(tmpdir(), 'output-review-diagnostics-'));
const out = path.resolve(
  process.env.FARMSLOT_OUTPUT_REVIEW_PROOF_OUT ?? 'temp/output-review-diagnostics',
);
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
for (const dir of [
  'scripts',
  'services/gateway',
  'projects',
  'pool',
  'runs',
  'home',
  'task/artifacts',
])
  mkdirSync(path.join(root, dir), { recursive: true });
for (const file of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json'])
  cpSync(path.join(source, file), path.join(root, file));
mkdirSync(out, { recursive: true });
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_BACKLOG_FILE: path.join(root, 'backlog.json'),
  FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, 'capabilities.json'),
  FARMSLOT_DISPATCH_QUEUE_FILE: path.join(root, 'queue.json'),
  FARMSLOT_GATEWAY_TOKEN: 'synthetic-parent-credential-not-for-this-fixture',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  NODE_TEST_CONTEXT: '1',
});
await import('../../../services/gateway/src/runtime/mock-pty.test-support.js');
const store = await import('../../../services/gateway/src/runs/store.js');
const output = await import('../../../services/gateway/src/run-completion/output.js');
const { createRetrospectiveForRun } =
  await import('../../../services/gateway/src/run-completion/retrospective.js');
const { scanArtifacts } =
  await import('../../../services/gateway/src/run-completion/publication-artifacts.js');
await store.loadAllRuns();
await import('../../../services/gateway/src/methods/run.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } =
  await import('../../../services/gateway/src/security/auth.js');
const { createWebSocketServer } = await import('../../../services/gateway/src/server.js');
const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.js');
const server = createServer();
let wss: WebSocketServer | undefined;
try {
  const auth = createGatewayAuthRuntime({
    FARMSLOT_HOME: process.env.FARMSLOT_HOME,
    GATEWAY_HOST: '127.0.0.1',
    FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  });
  initializeGatewayIdentity(auth, { host: '127.0.0.1' });
  wss = createWebSocketServer(server, auth);
  const client = new GatewayClient({
    url: await new Promise<string>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        resolve(`ws://127.0.0.1:${address.port}`);
      }),
    ),
    credential: null,
    timeout: 30000,
  });
  // Verify the exact existing gates without resolving them or rewriting files.
  const retained: unknown[] = [];
  for (const file of JSON.parse(process.env.FARMSLOT_OUTPUT_REVIEW_RECEIPTS ?? '[]') as string[]) {
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    const original: Run = snapshot.run ?? snapshot;
    const review = original.decisions.find(
      (decision) => !decision.resolvedAt && decision.payload?.kind === 'output-review',
    )!;
    assert.ok(review);
    const copy = store.createRun({ flowType: 'dev', project: 'proof', ticketOrPr: 'PROJ-123' });
    store.updateRun(copy.id, {
      flowType: 'qa',
      taskFile: original.taskFile,
      status: 'done',
      output: original.output,
      decisions: [review],
    });
    await output.verifyRunOutputReview(copy.id, review.id);
    retained.push({
      runId: original.id,
      decisionId: review.id,
      digest: original.output!.manifestDigest,
      verified: true,
    });
  }
  const task = path.join(root, 'task');
  writeFileSync(path.join(task, 'artifacts/report.html'), '<h1>Proven QA output</h1>');
  writeFileSync(path.join(task, 'artifacts/qa-result.json'), '{"passed":17}\n');
  const run = store.createRun({ flowType: 'dev', project: 'proof', ticketOrPr: 'PROJ-123' });
  store.updateRun(run.id, {
    flowType: 'qa',
    status: 'done',
    completedAt: new Date().toISOString(),
    completionPolicy: 'artifact-only',
    taskFile: path.join(task, 'TASK.md'),
    metrics: { ...run.metrics, outcome: 'success' },
    steps: [{ name: 'complete', status: 'done' }],
  });
  await output.captureRunOutput(run.id, false);
  const captured = store.getRun(run.id)!;
  const review = captured.decisions.find((decision) => decision.payload?.kind === 'output-review')!;
  writeFileSync(path.join(task, 'artifacts/diff-stat.json'), '{"files":0}\n');
  writeFileSync(path.join(task, 'artifacts/iteration-diff-stat.json'), '{"files":0}\n');
  await createRetrospectiveForRun(run.id);
  const reviewed = await client.call<{ run: Run }>('run.resolveDecision', {
    runId: run.id,
    decisionId: review.id,
    actionId: 'mark-reviewed',
  });
  const close = reviewed.run.decisions.find(
    (decision) => !decision.resolvedAt && decision.payload?.kind === 'output-review',
  )!;
  assert.ok(close);
  const actual = await scanArtifacts(task);
  assert.equal(output.outputManifestDigest(actual), captured.output!.manifestDigest);
  // The former whole-tree digest includes the added diagnostics and fails the
  // same snapshot comparison that prevented both confirmation actions.
  const oldDigest = createHash('sha256')
    .update(
      JSON.stringify(
        [...actual]
          .sort((a, b) => a.path.localeCompare(b.path))
          .map(({ path: file, sha256, sizeBytes }) => ({ path: file, sha256, sizeBytes })),
      ),
    )
    .digest('hex');
  assert.notEqual(oldDigest, captured.output!.manifestDigest);
  writeFileSync(path.join(task, 'artifacts/qa-result.json'), '{"passed":0}\n');
  await assert.rejects(
    client.call('run.resolveDecision', {
      runId: run.id,
      decisionId: close.id,
      actionId: 'close-run',
    }),
    /Run output changed/,
  );
  writeFileSync(path.join(task, 'artifacts/qa-result.json'), '{"passed":17}\n');
  const closed = await client.call<{ run: Run }>('run.resolveDecision', {
    runId: run.id,
    decisionId: close.id,
    actionId: 'close-run',
  });
  assert.ok(closed.run.output?.closedAt);
  assert.equal(closed.run.metrics.outcome, 'success');
  assert.deepEqual(closed.run.steps, captured.steps);
  assert.ok(
    closed.run.decisions.some(
      (decision) => decision.type === 'retrospective' && !decision.resolvedAt,
    ),
  );
  json(path.join(out, 'receipt.json'), {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHash: createHash('sha256')
      .update(readFileSync(path.join(source, 'services/gateway/src/run-completion/output.ts')))
      .digest('hex'),
    retained,
    publicMethods: ['run.resolveDecision'],
    acknowledged: true,
    closed: true,
    changedQaEvidenceRefused: true,
    retrospectivePending: true,
    formerDigestRejected: oldDigest !== captured.output!.manifestDigest,
    liveWrites: 0,
  });
  console.log(
    'Exact retained gates verify read-only; public acknowledgement and close pass while changed QA evidence refuses.',
  );
} finally {
  if (wss) {
    for (const peer of wss.clients) peer.terminate();
    await new Promise<void>((resolve) => wss!.close(() => resolve()));
  }
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
}
