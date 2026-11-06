// Opt-in isolated REVIEW hold and real extension RPC proof. No model or farm allocation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import { isRecord, type RunExtendReviewBudgetResult, type RunGetResult } from '@farmslot/protocol';

import type { PostDispatchStepContext } from './post-dispatch-steps.js';
assert.equal(process.env.FARMSLOT_REVIEW_BUDGET_HOLD_LIVE, '1');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const out = process.env.FARMSLOT_REVIEW_BUDGET_HOLD_OUT;
assert(out);
const root = await mkdtemp(path.join(os.tmpdir(), 'f430-budget-rpc-'));
await mkdir(out, { recursive: true });
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: root,
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
});
for (const name of [
  'scripts',
  'packages',
  'services',
  'node_modules',
  'schemas',
  'package.json',
  'CLAUDE.md',
])
  await symlink(path.join(source, name), path.join(root, name));
await mkdir(path.join(root, 'pool'));
await mkdir(path.join(root, 'projects/budget'), { recursive: true });
const repo = path.join(root, 'repo');
await mkdir(repo);
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'owned-change');
await writeFile(path.join(repo, 'README.md'), 'Owned budget fixture.');
git('add', '.');
git(
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
  'commit',
  '-qm',
  'fixture',
);
const head = git('rev-parse', 'HEAD');
const slot = 'budget-slot';
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: os.hostname(),
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project: 'budget',
    platform: 'cli',
    slots: [{ id: slot, repo, resources: {} }],
  }),
);
await writeFile(
  path.join(root, 'projects/budget/project.json'),
  JSON.stringify({ name: 'budget', hooks: {}, review: { enabled: true } }),
);
await import('../runtime/mock-pty.test-support.js');
const store = await import('../runs/store.js');
const { statusFile } = await import('../core/state.js');
const { recordedReviewRounds } = await import('../review/recorded-review-rounds.test-support.js');
const { assertReviewRoundAvailable } = await import('../review/review-round-budget.js');
const { executeReviewStep } = await import('./post-dispatch-steps.js');
const { ResultDecisionHoldError, holdRunForResultDecision } =
  await import('../run-completion/result-decision.js');
const { retainRunFixture } = await import('./test-fixtures.js');
const { createGatewayAuthRuntime } = await import('../security/auth.js');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: root });
const principal = auth.writer.createPrincipal({ type: 'service', displayName: 'Budget proof' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
const token = auth.writer.issueCredential(principal.id, 'Disposable proof');
const { createWebSocketServer, initServerGlobals, resetServerGlobalsForTests } =
  await import('../server.js');
const server = createServer((_q, r) => {
  r.writeHead(404);
  r.end();
});
const wss = createWebSocketServer(server, auth);
initServerGlobals();
let socket: WebSocket | undefined;
let runId: string | undefined;
try {
  const run = store.createRun({
    project: 'budget',
    flowType: 'fix-bug',
    mode: 'autonomous',
    ticketOrPr: 'BUDGET-REPRO',
  });
  runId = run.id;
  const task = path.join(root, 'task');
  await mkdir(path.join(task, 'artifacts'), { recursive: true });
  await writeFile(path.join(task, 'TASK.md'), '# Budget fixture');
  await writeFile(
    path.join(task, 'artifacts/report.md'),
    'Delivered result waiting for its reviewer.',
  );
  store.updateRun(run.id, {
    status: 'reviewing',
    slotId: slot,
    branch: 'owned-change',
    taskFile: path.join(task, 'TASK.md'),
    ...recordedReviewRounds(Array.from({ length: 5 }, (_, i) => `spent-${i}`)),
    steps: [
      {
        name: 'monitor',
        status: 'done',
        outputs: { workerSignal: { status: 'complete' }, pushVerification: { verified: true } },
      },
      { name: 'review', status: 'running' },
      { name: 'complete', status: 'pending' },
    ],
    output: {
      workerFinished: true,
      capturedAt: new Date().toISOString(),
      artifactManifest: [],
      manifestDigest: 'captured-fixture',
      reportPath: 'artifacts/report.md',
    },
  });
  const captured = store.getRun(run.id);
  assert(captured);
  await retainRunFixture(captured);
  await writeFile(
    statusFile,
    JSON.stringify({
      updated_at: new Date().toISOString(),
      slots: [
        {
          slot,
          machine: os.hostname(),
          project: 'budget',
          platform: 'cli',
          current_run_id: run.id,
          slot_epoch: 7,
          lifecycle: 'busy',
          phase: 'working',
        },
      ],
    }),
  );
  const heldContext: PostDispatchStepContext = {
    activeMonitors: new Map(),
    blockedRunError: (m: string) => new Error(m),
    broadcastFn: () => {},
    createEngineDecision: async () => assert.fail('no alternate decision'),
    executeNoChangeGate: async () => {},
    executePublishGateReviewPlan: async () => ({ reviewIds: [] }),
    executeReadyGate: async () => assert.fail('no publication'),
    executeReviewGate: async () => {},
    getDiffStat: async () => ({ files: 1, additions: 1, deletions: 0 }),
    interactiveLightweightSkipOutputs: () => ({}),
    isHumanGateEnabled: async () => true,
    monitorTerminalError: () => new Error('no monitor'),
    refreshRunLinks: async () => {},
    stepPartialIO: new Map(),
    deferTerminalSlotRelease: () => assert.fail('budget stop must not release'),
    executeReviewForRun: async () => {
      const current = store.getRun(run.id);
      assert(current);
      await assertReviewRoundAvailable(current);
      throw new Error('spent budget admitted');
    },
  };
  let refusal: InstanceType<typeof ResultDecisionHoldError> | undefined;
  try {
    await executeReviewStep(run.id, heldContext);
  } catch (error) {
    assert(error instanceof ResultDecisionHoldError);
    refusal = error;
  }
  assert(refusal);
  store.updateRunStep(run.id, 'review', {
    status: 'failed',
    detail: refusal.message,
    inputs: refusal.stepInputs,
    outputs: refusal.stepOutputs,
  });
  await holdRunForResultDecision(run.id, 'review', refusal.message);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert(address && typeof address !== 'string');
  socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const client = socket;
  await new Promise<void>((r, j) => {
    client.once('open', r);
    client.once('error', j);
  });
  let next = 0;
  const rpc = <T = unknown>(method: string, params: unknown) =>
    new Promise<T>((resolve, reject) => {
      const id = String(++next);
      const listener = (bytes: Buffer) => {
        const f = JSON.parse(bytes.toString());
        if (f.type !== 'res' || f.id !== id) return;
        clearTimeout(timer);
        client.off('message', listener);
        f.ok ? resolve(f.payload) : reject(new Error(f.error?.message));
      };
      const timer = setTimeout(() => {
        client.off('message', listener);
        reject(new Error('RPC deadline'));
      }, 15000);
      client.on('message', listener);
      client.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  await rpc('auth.connect', { clientKind: 'ui', token: token.secret });
  const before = (await rpc<RunGetResult>('run.get', { runId: run.id })).run;
  assert.equal(before.status, 'needs-decision');
  assert.equal(before.slotId, slot);
  const card = before.decisions.find((d) => d.payload?.kind === 'result-decision' && !d.resolvedAt);
  assert(card?.payload?.kind === 'result-decision');
  const accept = card.payload.actions.find((action) => action.id === 'accept-result');
  assert(accept);
  assert.equal(accept.available, true);
  assert.equal(accept.requiresReason, true);
  const row = async () => {
    const data: unknown = JSON.parse(await readFile(statusFile, 'utf8'));
    assert(isRecord(data) && Array.isArray(data.slots));
    const lease: unknown = data.slots.find(
      (value: unknown) => isRecord(value) && value.slot === slot,
    );
    assert(isRecord(lease));
    return lease;
  };
  assert.equal((await row()).current_run_id, run.id);
  assert.equal(git('rev-parse', 'HEAD'), head);
  const grant = await rpc<RunExtendReviewBudgetResult>('run.extendReviewBudget', {
    runId: run.id,
    requestId: 'proof-grant',
    expectedLimit: 5,
    limit: 6,
    headSha: head,
    scopeBrief: 'One scoped correction and its review.',
  });
  assert.equal(grant.budget.remaining, 1);
  const after = (await rpc<RunGetResult>('run.get', { runId: run.id })).run;
  assert.equal(after.status, 'needs-decision');
  assert.equal((await row()).current_run_id, run.id);
  assert.equal(after.slotId, slot);
  const refreshed = after.decisions.find(
    (d) => d.payload?.kind === 'result-decision' && !d.resolvedAt,
  );
  assert(refreshed?.payload?.kind === 'result-decision');
  assert(refreshed.payload.actions.find((a) => a.id === 'send-back')?.available);
  await writeFile(
    path.join(out, 'receipt.json'),
    JSON.stringify(
      {
        pass: true,
        runId: run.id,
        head,
        slot,
        statusBeforeGrant: before.status,
        statusAfterGrant: after.status,
        slotOwnerUnchanged: true,
        checkoutHeadUnchanged: true,
        remaining: grant.budget.remaining,
        pendingDecisionId: refreshed.id,
        acceptRequiresReason: accept.requiresReason,
        reviewVerdictInvented: Boolean(
          after.steps.find((s) => s.name === 'review')?.outputs?.verdict,
        ),
        lease: await row(),
      },
      null,
      2,
    ),
  );
} finally {
  socket?.terminate();
  resetServerGlobalsForTests();
  if (runId) {
    store.updateRun(runId, { status: 'cancelled' });
    await store.deleteRun(runId);
  }
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true });
}
