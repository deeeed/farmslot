import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(
  process.env.FARMSLOT_REVIEW_BUDGET_OUT ?? 'temp/update-branch-review-budget',
);
await mkdir(evidence, { recursive: true });
const home = await mkdtemp(path.join(os.tmpdir(), 'F130-rpc-'));
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_HOME: home,
  FARMSLOT_RUNS_DIR: path.join(home, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(home, 'projects'),
  FARMSLOT_POOL_DIR: path.join(home, 'pool'),
  FARMSLOT_TEST_STATUS_FILE: path.join(home, 'status.json'),
});
const load = (file: string) => import(pathToFileURL(path.join(root, file)).href);
await mkdir(path.join(home, 'pool'));
await mkdir(path.join(home, 'projects'));
await writeFile(
  path.join(home, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    slots: [],
  }),
);
const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
const person = auth.writer.createPrincipal(
  { type: 'person', displayName: 'Private budget proof' },
  [{ role: 'admin', scope: { kind: 'global' } }],
);
const credential = auth.writer.issueCredential(person.id, 'Disposable local proof');
const grant = auth.writer.exchangePersonCredential(credential.secret, {
  deviceName: 'Local proof',
  deviceKind: 'cli',
});
const { createRun, updateRun, getRun, deleteRun, persistRunNow } = await load(
  'services/gateway/src/runs/store.ts',
);
const budget = await load('services/gateway/src/review/review-round-budget.ts');
const { runActivityView } = await load('packages/review-dispatch/src/run-activity.ts');
const ref = `example/budget-${randomUUID()}#42`;
function fixture(flowType: 'dev' | 'update-branch') {
  const run = createRun(
    { project: 'budget-proof', flowType, mode: 'autonomous', ticketOrPr: ref, runner: 'scripted' },
    { nativeOwnerPrincipalId: person.id, createdByPrincipalId: person.id },
  );
  updateRun(run.id, {
    status: 'human-gating',
    branch: 'owned-update',
    links: [{ label: 'PR', url: `https://github.com/${ref.replace('#', '/pull/')}` }],
    steps: [],
  });
  return getRun(run.id);
}
const parent = fixture('dev'),
  update = fixture('update-branch'),
  activity = fixture('update-branch');
// A structured fixture actor proves the counter projection, not worker liveness.
updateRun(activity.id, {
  status: 'reviewing',
  steps: [{ name: 'review', status: 'running' }],
  agentContexts: [
    {
      id: 'fixture-review',
      role: 'review',
      label: 'Fixture reviewer',
      status: 'working',
      runId: activity.id,
      slotId: null,
      updatedAt: new Date().toISOString(),
    },
  ],
});
function gate(runId: string) {
  const decision = {
    id: randomUUID(),
    type: 'engine_human_gate',
    title: 'Ready',
    description: '',
    actions: [{ id: 'request-review', label: 'Request review', style: 'primary' }],
    createdAt: new Date().toISOString(),
    payload: {
      kind: 'ready',
      prNumber: 42,
      repo: ref.split('#')[0],
      branch: 'owned-update',
      workerReport: '',
      diffStat: { files: 0, additions: 0, deletions: 0 },
    },
  };
  updateRun(runId, { status: 'human-gating', decisions: [decision] });
  return decision;
}
const methods = await load('services/gateway/src/methods/run.ts');
// Only engine continuation is suppressed. Auth, request checks, shared budget,
// decision consumption, persistence and client projections are production code.
mock.module(pathToFileURL(path.join(root, 'services/gateway/src/methods/run.ts')).href, {
  namedExports: {
    ...methods,
    runResolveDecision: (params: unknown, emit: unknown, deps: object) =>
      methods.runResolveDecision(params, emit, { ...deps, resumeRun: async () => {} }),
  },
});
const { createWebSocketServer } = await load('services/gateway/src/server.ts');
const { GatewayClient } = await load('packages/cli/src/gateway-client.ts');
const server = createServer(),
  wss = createWebSocketServer(server, auth);
let connection;
const observations = [];
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  connection = await new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    timeout: 30000,
    credential: { token: grant.accessToken },
  }).connect();
  const readBudget = async (runId: string) => {
    const { run } = await connection.call('run.get', { runId });
    return run.decisions[0].payload.reviewRoundBudget;
  };
  const request = async (runId: string, decisionId: string) =>
    connection.call('run.resolveDecision', {
      runId,
      decisionId,
      actionId: 'request-review',
      selectionData: {
        reviewRequest: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'low', mode: 'cold' },
      },
    });
  for (let i = 0; i < 5; i++) await budget.admitReviewRound(parent.id, `feature-${i}`);
  await budget.admitReviewRound(activity.id, 'activity-first');
  const { run: activityReadback } = await connection.call('run.get', { runId: activity.id });
  assert.equal(runActivityView(activityReadback)?.label, 'Reviewer checking changes · round 1');
  observations.push('shared client activity uses the owning budget from real run.get metadata');
  const parentGate = gate(parent.id),
    updateGate = gate(update.id);
  assert.equal((await readBudget(parent.id)).label, 'Review rounds 5/5');
  assert.equal((await readBudget(update.id)).label, 'Review rounds 0/2');
  await assert.rejects(request(parent.id, parentGate.id), /five review rounds/);
  assert.equal(getRun(parent.id).decisions[0].resolvedAt, undefined);
  await request(update.id, updateGate.id);
  assert.equal(getRun(update.id).decisions[0].resolvedAction, 'request-review');
  observations.push(
    'exhausted feature request refused; maintenance request accepted through authenticated RPC',
  );
  await budget.admitReviewRound(update.id, 'maintenance-1');
  await budget.admitReviewRound(update.id, 'maintenance-1');
  await budget.admitReviewRound(update.id, 'maintenance-2');
  const spentGate = gate(update.id);
  assert.equal((await readBudget(update.id)).label, 'Review rounds 2/2');
  await assert.rejects(request(update.id, spentGate.id), /All 2 review rounds/);
  assert.equal(getRun(update.id).decisions[0].resolvedAt, undefined);
  observations.push(
    'replay reuses receipt; third maintenance request refused before consuming gate',
  );
  await budget.settleReviewRoundNoVerdict(update.id, 'maintenance-2', 'fixture reviewer timeout');
  assert.equal((await readBudget(update.id)).label, 'Review rounds 1/2');
  assert.equal((await readBudget(update.id)).noVerdict, 1);
  assert.equal((await readBudget(parent.id)).used, 5);
  assert.equal((await readBudget(parent.id)).noVerdict, 0);
  await budget.clearReviewRoundSettlement(update.id, 'maintenance-2');
  assert.equal((await readBudget(update.id)).used, 2);
  await persistRunNow(getRun(update.id));
  const saved = JSON.parse(await readFile(path.join(home, 'runs', `${update.id}.json`), 'utf8'));
  assert.equal(saved.reviewRoundOwners['maintenance-1'], update.id);
  assert.equal(saved.reviewRoundAdmissions.length, 8);
  observations.push(
    'refund/recovered verdict and durable owners preserve feature budget and raw receipt IDs',
  );
  await writeFile(
    path.join(evidence, 'result.json'),
    JSON.stringify(
      {
        pass: true,
        observations,
        methods: ['run.get', 'run.resolveDecision'],
        scope:
          'Private authenticated production gateway; fixture admissions through real budget owner; only engine continuation suppressed. No reviewer execution claim.',
        productOperations: 0,
        modelTurns: 0,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ pass: true, observations }));
} finally {
  connection?.close();
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  for (const run of [parent, update, activity]) {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  }
  await rm(home, { recursive: true, force: true });
}
process.exit(0);
