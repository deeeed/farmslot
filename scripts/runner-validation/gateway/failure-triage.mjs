import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

assert.equal(process.env.FARMSLOT_ASSESSMENT_VALIDATION, '1');
assert.ok(
  process.argv.slice(2).every((arg) => ['--keep', '--keep-no-call', '--live-smoke'].includes(arg)),
  'Unknown proof option',
);
const smoke = process.argv.includes('--live-smoke');
const keep = process.argv.includes('--keep') || process.argv.includes('--keep-no-call');
assert.ok(!(smoke && keep), 'Live smoke must stop its gateway');
const liveKey = process.env.TYPESAFE_API_KEY?.trim() || process.env.TYPESCRIPT_API_KEY?.trim();
if (smoke) assert.ok(liveKey, 'A live provider credential is required');
let liveTransport = false;
const out = process.env.TRIAGE_PILOT_PROOF_OUT;
const port = Number(process.env.TRIAGE_PILOT_PROOF_PORT);
assert.ok(out && Number.isInteger(port) && port > 1024 && port < 65536);
await mkdir(out, { mode: 0o700 });
const root = path.join(out, 'root'),
  home = path.join(out, 'home'),
  logs = path.join(out, 'logs'),
  runs = path.join(out, 'runs');
for (const dir of [
  path.join(root, 'scripts'),
  path.join(root, 'services/gateway'),
  path.join(root, 'pool'),
  home,
  logs,
  runs,
])
  await mkdir(dir, { recursive: true });
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated gateway fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
await writeFile(
  path.join(root, 'services/gateway/package.json'),
  '{"name":"fixture","version":"0.0.0"}',
);
execFileSync('git', ['init', '--initial-branch=fixture-proof', root], { stdio: 'pipe' });
execFileSync(
  'git',
  [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'test: initialize isolated gateway fixture',
  ],
  { stdio: 'pipe' },
);
const sourcePath = path.join(root, '.omx/logs/validation/failure.log');
await mkdir(path.dirname(sourcePath), { recursive: true });
const id = randomUUID(),
  now = new Date().toISOString();
const run = {
  id,
  familyId: id,
  lane: 'validation',
  mode: 'validation',
  flowType: 'dev',
  status: 'running',
  project: 'triage-fixture',
  ticketOrPr: 'synthetic failure',
  createdAt: now,
  updatedAt: now,
  steps: [
    {
      name: 'validation',
      status: 'failed',
      startedAt: now,
      completedAt: now,
      detail: 'Recorded fixture failure',
      outputs: { logPath: sourcePath },
    },
  ],
  decisions: [],
  metrics: {
    nudgeCount: 0,
    model: 'scripted',
    runner: 'scripted',
    runnerSessionId: null,
    runnerSessionPath: null,
  },
  slotId: null,
  taskFile: null,
  branch: null,
  allowedSlots: null,
  safetyTier: 'sandboxed',
  agentContexts: [],
  tags: [],
};
const runFile = path.join(runs, `${id}.json`);
await writeFile(runFile, JSON.stringify(run));
let source =
  'Error: configured executable is unavailable\nAuthorization: Bearer triage-canary-private\n';
await writeFile(sourcePath, source);
await writeFile(path.join(out, 'mode'), 'valid');
await writeFile(path.join(out, 'requests.jsonl'), '');
const env = {
  ...process.env,
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: home,
  FARMSLOT_RUNS_DIR: runs,
  FARMSLOT_LOG_DIR: logs,
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_GATEWAY_AUTH_MODE: 'token',
  FARMSLOT_GATEWAY_TOKEN: randomUUID(),
  GATEWAY_HOST: '127.0.0.1',
  GATEWAY_PORT: String(port),
  FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
  FARMSLOT_RPC_TIMEOUT_MS: '20000',
  FARMSLOT_ASSESSMENT_ENABLED: 'true',
  FARMSLOT_ASSESSMENT_PROVIDER: 'typesafe',
  FARMSLOT_ASSESSMENT_MODEL: 'jev-1.13.0',
  TYPESAFE_API_KEY: 'triage-fixture-key',
  TSX_TSCONFIG_PATH: path.resolve('services/gateway/tsconfig.json'),
};
delete env.TYPESCRIPT_API_KEY;
delete env.FARMSLOT_EXTRA_LOG_DIRS;
delete env.FARMSLOT_ASSESSMENT_MAX_STATE_BYTES;
delete env.FARMSLOT_GATEWAY_PASSWORD;
function rpc(method, params = {}, token = env.FARMSLOT_GATEWAY_TOKEN) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
      {
        env: { ...env, FARMSLOT_GATEWAY_TOKEN: token },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 8 * 1024 * 1024,
      },
    ),
  );
}
function asyncRpc(method, params) {
  const child = spawn(
    process.execPath,
    ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let data = '',
    error = '';
  child.stdout.on('data', (b) => (data += b));
  child.stderr.on('data', (b) => (error += b));
  return once(child, 'exit').then(([code]) => {
    if (code !== 0) throw new Error(error);
    return JSON.parse(data);
  });
}
let gateway, log;
let keepReady = false;
async function start() {
  log = await open(path.join(out, 'gateway.log'), 'a');
  gateway = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      ...(liveTransport
        ? []
        : ['--import', path.resolve('scripts/runner-validation/fixtures/triage-transport.mts')]),
      'services/gateway/src/index.ts',
    ],
    { env, stdio: ['ignore', log.fd, log.fd] },
  );
  let lastHealth = 'not contacted';
  for (let i = 0; i < 150; i++) {
    if (gateway.exitCode !== null || gateway.signalCode !== null)
      throw new Error('Gateway fixture exited');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
      lastHealth = `HTTP ${response.status}`;
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      lastHealth = `Fetch failed: ${e.cause?.code ?? e.message}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Gateway fixture failed readiness: ${lastHealth}`);
}
async function stop(signal = 'SIGTERM') {
  if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
    const ended = once(gateway, 'exit');
    gateway.kill(signal);
    await ended;
  }
  await log?.close();
  log = undefined;
}
const count = async () =>
  (await readFile(path.join(out, 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
    .length;
try {
  try {
    await fetch(`http://127.0.0.1:${port}/health`);
    throw new Error('Proof port occupied');
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
  }
  await start();
  const authorityBefore = JSON.stringify(rpc('run.get', { runId: id }).run);
  assert.equal(rpc('intelligence.triage.get', { runId: id }).availability, 'disabled');
  assert.equal(await count(), 0);
  const setup = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
    import { readFileSync } from 'node:fs';
    import { triageFailureHash, registeredFailureLogs } from './services/gateway/src/intelligence/triage/snapshot.ts';
    import { textDigest } from './services/gateway/src/assessment/failure-triage/packet.ts';
    const r=JSON.parse(readFileSync(${JSON.stringify(runFile)},'utf8'));
    console.log(JSON.stringify({failureHash:triageFailureHash(r,r.steps[0]),logId:(await registeredFailureLogs(r.steps[0])).find(e=>e.path.endsWith('/failure.log')).id,digest:textDigest(readFileSync(${JSON.stringify(sourcePath)},'utf8'))}));
  `,
      ],
      { env, encoding: 'utf8' },
    ),
  );
  const draftFile = path.join(out, 'approval-draft.json');
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/failure-triage/draft-approval.mts',
      '--run-json',
      runFile,
      '--source',
      setup.logId,
      '--origin',
      'synthetic',
      '--reference',
      'fixture:gateway-triage-proof',
      '--out',
      draftFile,
    ],
    { env, stdio: 'pipe' },
  );
  const draft = JSON.parse(await readFile(draftFile, 'utf8'));
  assert.equal(draft.approval.failureHash, setup.failureHash);
  assert.equal(draft.approval.sources[0].digest, setup.digest);
  assert.ok(!JSON.stringify(draft).includes('triage-canary-private'));
  const price = JSON.parse(
    await readFile(
      process.env.TRIAGE_PILOT_PRICE_FILE ?? 'scripts/failure-triage/prices.json',
      'utf8',
    ),
  );
  const policy = {
    enabled: true,
    projects: ['triage-fixture'],
    receiptDirectory: path.resolve('scripts/failure-triage/results/v2-held-out'),
    maxCalls: 5,
    maxUsd: 0.1,
    price: { ...price, verifiedAt: now, source: 'https://example.invalid/simulated-pricing' },
    approvals: [
      {
        runId: id,
        project: 'triage-fixture',
        step: 'validation',
        failureHash: setup.failureHash,
        sources: [{ logId: setup.logId, digest: setup.digest }],
        origin: { kind: 'synthetic', reference: 'fixture:gateway-triage-proof' },
      },
    ],
  };
  const savePolicy = () => writeFile(path.join(home, 'triage-policy.json'), JSON.stringify(policy));
  async function advanceSnapshot() {
    source += 'Observation sequence: ' + Date.now() + '\n';
    await writeFile(sourcePath, source);
    policy.approvals[0].sources[0].digest = createHash('sha256').update(source).digest('hex');
    await savePolicy();
  }
  await savePolicy();
  await writeFile(
    path.join(home, 'assessment-config.json'),
    JSON.stringify({ maxStateBytes: 512 }),
  );
  assert.equal(rpc('intelligence.triage.get', { runId: id }).availability, 'unavailable');
  assert.equal(await count(), 0, 'Oversized input must be rejected before reservation');
  assert.equal(rpc('assessment.summary').attemptedCalls, 0);
  await writeFile(path.join(home, 'assessment-config.json'), '{}');
  const ready = rpc('intelligence.triage.get', { runId: id });
  assert.equal(ready.availability, 'ready', JSON.stringify(ready));
  assert.throws(() =>
    rpc('intelligence.triage.analyze', {
      runId: id,
      snapshotHash: ready.snapshotHash,
      path: '/private',
    }),
  );
  const params = { runId: id, snapshotHash: ready.snapshotHash };
  const [first, second] = await Promise.all([
    asyncRpc('intelligence.triage.analyze', params),
    asyncRpc('intelligence.triage.analyze', params),
  ]);
  assert.equal(first.record.id, second.record.id);
  assert.equal(await count(), 1);
  assert.equal(first.record.status, 'completed');
  assert.equal(second.record.status, 'completed');
  assert.ok(
    first.advice.evidence[0].sourceId.startsWith('runtime-'),
    'Canonical nested runtime log was not admitted',
  );
  assert.equal(first.advice.nextCheck, 'inspect_prepare');
  assert.equal(
    first.record.result.answers.nextCheck.choice,
    'inspect_external_response',
    'Raw output preserved separately',
  );
  assert.equal(rpc('intelligence.triage.analyze', params).record.id, first.record.id);
  assert.equal(await count(), 1);
  const evidence = rpc('intelligence.triage.get', { runId: id, includeEvidence: true });
  assert.ok(evidence.input);
  assert.ok(!JSON.stringify(evidence).includes('triage-canary-private'));
  const feedback = rpc('intelligence.triage.feedback', {
    id: first.record.id,
    expectedRevision: 0,
    questionId: 'cause',
    verdict: 'correct',
    adviceShown: true,
    adviceUsed: false,
    evidenceRef: 'fixture:known-configuration-failure',
  });
  assert.equal(feedback.feedback.length, 1);
  assert.equal(rpc('assessment.summary').attemptedCalls, 1);
  await writeFile(sourcePath, source + 'changed');
  const stale = rpc('intelligence.triage.get', { runId: id });
  assert.equal(stale.availability, 'rejected-data');
  assert.equal(stale.stale, true);
  assert.equal(rpc('intelligence.triage.analyze', params).availability, 'rejected-data');
  assert.equal(await count(), 1);
  await writeFile(sourcePath, source);
  await stop();
  await start();
  assert.equal(rpc('intelligence.triage.analyze', params).record.id, first.record.id);
  assert.equal(await count(), 1);
  policy.maxCalls = 6;
  await savePolicy();
  assert.equal(rpc('intelligence.triage.get', { runId: id }).snapshotHash, params.snapshotHash);
  assert.equal(rpc('intelligence.triage.analyze', params).record.id, first.record.id);
  assert.equal(await count(), 1, 'Budget edits must not rebill cached advice');
  await advanceSnapshot();
  await writeFile(path.join(out, 'mode'), 'hang');
  const next = rpc('intelligence.triage.get', { runId: id });
  const interrupted = asyncRpc('intelligence.triage.analyze', {
    runId: id,
    snapshotHash: next.snapshotHash,
  }).then(
    () => false,
    () => true,
  );
  for (let i = 0; i < 50 && (await count()) < 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await count(), 2);
  const running = rpc('intelligence.triage.get', { runId: id });
  assert.equal(running.record.status, 'started');
  assert.match(running.reason, /already running/);
  await stop('SIGKILL');
  assert.equal(await interrupted, true);
  await writeFile(path.join(out, 'mode'), 'valid');
  await start();
  const uncertain = rpc('intelligence.triage.analyze', {
    runId: id,
    snapshotHash: next.snapshotHash,
  });
  assert.equal(uncertain.record.status, 'interrupted');
  assert.equal(await count(), 2);
  const retried = rpc('intelligence.triage.analyze', {
    runId: id,
    snapshotHash: next.snapshotHash,
    retryOf: uncertain.record.id,
  });
  assert.equal(retried.record.status, 'completed');
  assert.equal(
    rpc('intelligence.triage.analyze', { runId: id, snapshotHash: next.snapshotHash }).record.id,
    retried.record.id,
    'A normal request must reuse the successful retry, not regress to its interrupted parent',
  );
  assert.notEqual(retried.record.id, uncertain.record.id);
  assert.equal(await count(), 3);
  policy.maxCalls = 3;
  await advanceSnapshot();
  const limited = rpc('intelligence.triage.get', { runId: id });
  assert.equal(
    rpc('intelligence.triage.analyze', { runId: id, snapshotHash: limited.snapshotHash })
      .availability,
    'budget-blocked',
  );
  assert.equal(await count(), 3);
  assert.equal(
    JSON.stringify(rpc('run.get', { runId: id }).run),
    authorityBefore,
    'Canonical run changed',
  );
  policy.maxCalls = 60;
  policy.maxUsd = 0.000001;
  await savePolicy();
  const dollar = rpc('intelligence.triage.get', { runId: id });
  assert.equal(
    rpc('intelligence.triage.analyze', { runId: id, snapshotHash: dollar.snapshotHash })
      .availability,
    'budget-blocked',
  );
  policy.maxUsd = 0.1;
  policy.price.verifiedAt = '2000-01-01T00:00:00Z';
  await savePolicy();
  assert.equal(rpc('intelligence.triage.get', { runId: id }).availability, 'unavailable');
  policy.price.verifiedAt = now;
  policy.enabled = false;
  await savePolicy();
  assert.equal(rpc('intelligence.triage.get', { runId: id }).availability, 'disabled');
  policy.enabled = true;
  policy.projects = ['unrelated'];
  await savePolicy();
  assert.equal(rpc('intelligence.triage.get', { runId: id }).availability, 'rejected-data');
  policy.projects = ['triage-fixture'];
  await savePolicy();
  const operator = rpc('principal.create', {
    subject: { type: 'person', displayName: 'triage-proof-operator' },
    roles: [{ role: 'operator', scope: { kind: 'global' } }],
  }).principal;
  const credential = rpc('credential.issue', {
    principalId: operator.id,
    displayName: 'triage-proof-operator',
  });
  if (credential.adminGrant) env.FARMSLOT_GATEWAY_TOKEN = credential.adminGrant.secret;
  rpc('nodes.list', {}, credential.secret); // Prove this is an authenticated operator, not a bad token.
  assert.throws(() => rpc('intelligence.triage.get', { runId: id }, credential.secret));
  assert.throws(() =>
    rpc(
      'intelligence.triage.analyze',
      { runId: id, snapshotHash: next.snapshotHash },
      credential.secret,
    ),
  );
  assert.equal(await count(), 3);
  for (const mode of ['wrong-model', 'missing-model', 'malformed']) {
    policy.price.verifiedAt = new Date(Date.parse(policy.price.verifiedAt) - 1000).toISOString();
    await savePolicy();
    await writeFile(path.join(out, 'mode'), mode);
    const view = rpc('intelligence.triage.get', { runId: id });
    assert.equal(view.availability, 'ready', JSON.stringify(view));
    const rejected = rpc('intelligence.triage.analyze', {
      runId: id,
      snapshotHash: view.snapshotHash,
    });
    assert.equal(rejected.record.status, 'unavailable', mode);
    assert.equal(rejected.advice, undefined, mode);
    assert.equal(rejected.record.result.usage?.costUsd, undefined, mode);
    assert.equal(rejected.retryAllowed, true, mode);
  }
  await writeFile(path.join(out, 'mode'), 'valid');
  // Historical no-call records are setup fixtures. Restart proves operator recovery
  // through production RPCs without injecting browser or live process state.
  await stop();
  for (const status of ['skipped', 'disabled']) {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(path.join(home, 'assessments'));
    const records = await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => ({
          file: path.join(home, 'assessments', f),
          value: JSON.parse(await readFile(path.join(home, 'assessments', f), 'utf8')),
        })),
    );
    const latest = records.sort((a, b) => b.value.startedAt.localeCompare(a.value.startedAt))[0];
    latest.value.status = status;
    latest.value.result = {
      status,
      attempted: false,
      provider: env.FARMSLOT_ASSESSMENT_PROVIDER,
      requestedModel: env.FARMSLOT_ASSESSMENT_MODEL,
    };
    await writeFile(latest.file, JSON.stringify(latest.value));
    await start();
    const beforeRetry = rpc('intelligence.triage.get', { runId: id });
    assert.equal(beforeRetry.retryAllowed, true, status);
    assert.match(beforeRetry.reason, /No provider call was made/, status);
    const callsBefore = await count();
    assert.equal(
      rpc('intelligence.triage.analyze', { runId: id, snapshotHash: beforeRetry.snapshotHash })
        .record.status,
      status,
    );
    assert.equal(await count(), callsBefore, 'No automatic replay of a no-call record');
    const retried = rpc('intelligence.triage.analyze', {
      runId: id,
      snapshotHash: beforeRetry.snapshotHash,
      retryOf: beforeRetry.record.id,
    });
    assert.equal(retried.record.status, 'completed', status);
    assert.equal(await count(), callsBefore + 1);
    await stop();
  }
  const key = env.TYPESAFE_API_KEY;
  delete env.TYPESAFE_API_KEY;
  await start();
  assert.equal(rpc('intelligence.triage.get', { runId: id }).availability, 'missing-key');
  await stop();
  env.TYPESAFE_API_KEY = key;
  env.FARMSLOT_ASSESSMENT_MODEL = 'unevaluated-model';
  await start();
  assert.equal(rpc('intelligence.triage.get', { runId: id }).availability, 'unsupported-model');
  await stop();
  env.FARMSLOT_ASSESSMENT_MODEL = 'jev-1.13.0';
  await start();
  assert.equal(await count(), 8);
  assert.equal(JSON.stringify(rpc('run.get', { runId: id }).run), authorityBefore);
  await stop();
  const secondRun = structuredClone(run);
  secondRun.steps.push({ ...secondRun.steps[0], name: 'second-failure' });
  const secondFailureHash = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import {triageFailureHash} from './services/gateway/src/intelligence/triage/snapshot.ts'; const run=${JSON.stringify(secondRun)}; console.log(triageFailureHash(run,run.steps[1]));`,
    ],
    { env, encoding: 'utf8' },
  ).trim();
  policy.approvals.push({
    ...policy.approvals[0],
    step: 'second-failure',
    failureHash: secondFailureHash,
  });
  await writeFile(runFile, JSON.stringify(secondRun));
  await savePolicy();
  await start();
  const secondStep = rpc('intelligence.triage.get', { runId: id });
  assert.equal(secondStep.availability, 'ready');
  assert.equal(secondStep.step, 'second-failure');
  assert.equal(secondStep.record, undefined, 'Never display another failed step’s saved advice');
  assert.equal(await count(), 8);
  await stop();
  policy.approvals.pop();
  await writeFile(runFile, JSON.stringify(run));
  await savePolicy();
  await start();
  // Exercise a real admitted RPC reply beyond the price envelope, then verify
  // the retained receipt and that another snapshot cannot start a new request.
  await advanceSnapshot();
  await writeFile(path.join(out, 'mode'), 'over-bound');
  const beforeBound = rpc('intelligence.triage.get', { runId: id });
  assert.equal(beforeBound.availability, 'ready');
  const overspend = rpc('intelligence.triage.analyze', {
    runId: id,
    snapshotHash: beforeBound.snapshotHash,
  });
  assert.equal(overspend.record.status, 'unavailable');
  assert.equal(overspend.record.result.error, 'spend-bound-exceeded');
  assert.equal(overspend.record.result.attempted, true);
  assert.equal(overspend.record.result.answers, undefined);
  assert.equal(overspend.record.result.usage.inputTokens, 70000);
  assert.equal(overspend.record.result.usage.outputTokens, 30);
  assert.equal(overspend.record.result.usage.costKind, 'estimated');
  assert.equal(
    overspend.record.result.usage.costUsd,
    (70000 * policy.price.inputUsdPerMillion) / 1_000_000,
  );
  assert.equal(await count(), 9);
  await writeFile(path.join(out, 'mode'), 'valid');
  await advanceSnapshot();
  const boundView = rpc('intelligence.triage.get', { runId: id });
  const bound = rpc('intelligence.triage.analyze', {
    runId: id,
    snapshotHash: boundView.snapshotHash,
  });
  assert.equal(bound.availability, 'budget-blocked');
  assert.match(bound.reason, /exceeded this price snapshot/);
  assert.equal(await count(), 9);
  await stop();
  source = source.slice(0, source.indexOf('Observation sequence:'));
  await writeFile(sourcePath, source);
  policy.approvals[0].sources[0].digest = createHash('sha256').update(source).digest('hex');
  await savePolicy();
  await start();
  const proof = {
    passed: true,
    mode: 'simulated',
    providerCalls: 9,
    overBoundUsageRetained: true,
    modelIdentityEnforced: true,
    unrelatedBudgetEditPreservesCache: true,
    latestFailedStepDoesNotBorrowAdvice: true,
    spendBoundReasonDistinct: true,
    malformedOutputRejected: true,
    inputLimitPreflight: true,
    noCallExplicitRetry: true,
    missingKeyAndUnknownModelRejected: true,
    failedStepInRunningRun: true,
    externalProviderCalls: 0,
    duplicateCoalesced: true,
    cachedAcrossRestart: true,
    interruptedNotReplayed: true,
    explicitRetry: true,
    budgetEnforced: true,
    authorityUnchanged: true,
    nestedRuntimeSourceAdmitted: true,
    unauthorizedRoleRejected: true,
    disabledAndUnrelatedProjectRejected: true,
    dollarBudgetAndStalePriceEnforced: true,
  };
  await writeFile(path.join(out, 'proof.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(proof));
  if (smoke) {
    await stop();
    // A separate, explicitly authorized wiring smoke. It is never benchmark evidence.
    liveTransport = true;
    env.TYPESAFE_API_KEY = liveKey;
    policy.price = price;
    await savePolicy();
    await start();
    const view = rpc('intelligence.triage.get', { runId: id });
    assert.equal(view.availability, 'ready', view.reason);
    assert.equal(view.stale, true, 'Live smoke must use a fresh policy snapshot');
    const result = rpc('intelligence.triage.analyze', {
      runId: id,
      snapshotHash: view.snapshotHash,
    });
    const receipt = {
      kind: 'synthetic-wiring-smoke',
      efficacyEvidence: false,
      runId: id,
      status: result.record?.status,
      result: result.record?.result,
      advice: result.advice,
    };
    await writeFile(path.join(out, 'live-smoke.json'), JSON.stringify(receipt, null, 2), {
      mode: 0o600,
    });
    assert.equal(result.record?.status, 'completed', 'Inspect saved live smoke result');
    assert.equal(result.record.result.attempted, true);
    assert.equal(result.record.result.returnedModel, env.FARMSLOT_ASSESSMENT_MODEL);
    assert.equal(JSON.stringify(rpc('run.get', { runId: id }).run), authorityBefore);
    console.log(
      JSON.stringify({ liveSmoke: true, status: receipt.status, efficacyEvidence: false }),
    );
  }
  if (process.argv.includes('--keep-no-call')) {
    const latest = rpc('intelligence.triage.get', { runId: id }).record;
    await stop();
    latest.status = 'skipped';
    latest.result = {
      status: 'skipped',
      attempted: false,
      provider: env.FARMSLOT_ASSESSMENT_PROVIDER,
      requestedModel: env.FARMSLOT_ASSESSMENT_MODEL,
    };
    await writeFile(path.join(home, 'assessments', latest.id + '.json'), JSON.stringify(latest));
    await start();
  }
  if (keep) {
    await writeFile(
      path.join(out, 'ui-session.json'),
      JSON.stringify({
        runId: id,
        gateway: env.FARMSLOT_GATEWAY,
        token: env.FARMSLOT_GATEWAY_TOKEN,
        pid: gateway.pid,
      }),
      { mode: 0o600 },
    );
    keepReady = true;
  }
} finally {
  if (keepReady) {
    gateway.unref();
    await log?.close();
  } else await stop();
}
