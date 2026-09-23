import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

assert.equal(process.env.FARMSLOT_ASSESSMENT_VALIDATION, '1');
assert.ok(process.argv.slice(2).every((a) => ['--keep', '--live-smoke'].includes(a)));
const out = process.env.ASSESSMENT_PROVIDER_PROOF_OUT;
const port = Number(process.env.ASSESSMENT_PROVIDER_PROOF_PORT);
assert.ok(out && Number.isInteger(port) && port > 1024 && port < 65536);
assert.ok(!(process.argv.includes('--keep') && process.argv.includes('--live-smoke')));
const realKey = process.env.CODEX_LB_API_KEY;
if (process.argv.includes('--live-smoke'))
  assert.ok(realKey, 'Existing answering-provider credential required');
await mkdir(out, { mode: 0o700 });
const root = path.join(out, 'root'),
  home = path.join(out, 'home');
for (const directory of ['scripts', 'services/gateway', 'pool', 'runs', 'logs'])
  await mkdir(path.join(root, directory), { recursive: true });
await mkdir(home);
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated provider validation\n');
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
    'test: initialize provider fixture',
  ],
  { stdio: 'pipe' },
);
const env = {
  ...process.env,
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: home,
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_LOG_DIR: path.join(root, 'logs'),
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_GATEWAY_AUTH_MODE: 'token',
  FARMSLOT_GATEWAY_TOKEN: randomUUID(),
  GATEWAY_PORT: String(port),
  GATEWAY_HOST: '127.0.0.1',
  FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
  TYPESAFE_API_KEY: 'provider-fixture-key',
  CODEX_LB_API_KEY: 'provider-fixture-lb-key',
  TSX_TSCONFIG_PATH: path.resolve('services/gateway/tsconfig.json'),
};
for (const key of [
  'FARMSLOT_GATEWAY_PASSWORD',
  'FARMSLOT_EXTRA_LOG_DIRS',
  'FARMSLOT_ASSESSMENT_ENABLED',
  'FARMSLOT_ASSESSMENT_PROVIDER',
  'FARMSLOT_ASSESSMENT_MODEL',
  'FARMSLOT_ASSESSMENT_TIMEOUT_MS',
  'FARMSLOT_ASSESSMENT_MAX_STATE_BYTES',
])
  delete env[key];
const configuration = { enabled: false, provider: 'typesafe', model: 'jev-1.13.0', timeoutMs: 500 };
const configure = () =>
  writeFile(path.join(home, 'assessment-config.json'), JSON.stringify(configuration));
await configure();
await writeFile(path.join(out, 'mode'), 'valid');
await writeFile(path.join(out, 'requests.jsonl'), '');
let child,
  log,
  live = false,
  keep = false;
const count = async () =>
  (await readFile(path.join(out, 'requests.jsonl'), 'utf8')).split('\n').filter(Boolean).length;
function rpc(method, params = {}) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
}
async function start() {
  log = await open(path.join(out, 'gateway.log'), 'a');
  child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      ...(!live
        ? ['--import', path.resolve('scripts/assessment-validation/provider-transport.mts')]
        : []),
      'services/gateway/src/index.ts',
    ],
    { env, stdio: ['ignore', log.fd, log.fd] },
  );
  // Under busy development hosts, module startup can exceed 15s. Keep the
  // health check bounded and fail immediately if the child exits.
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Provider proof gateway exited');
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Provider gateway readiness failed');
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const done = once(child, 'exit');
    child.kill('SIGTERM');
    await done;
  }
  await log?.close();
  log = undefined;
}
try {
  try {
    await fetch(`http://127.0.0.1:${port}/health`);
    throw new Error('Proof port occupied');
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  await start();
  const status = rpc('assessment.status');
  assert.equal(status.enabled, false);
  assert.deepEqual(status.providers.map((p) => p.id).sort(), ['codex-lb', 'typesafe']);
  assert.equal(await count(), 0);
  const native = rpc('assessment.test', { provider: 'typesafe', model: 'jev-1.13.0' });
  assert.equal(native.status, 'completed');
  assert.equal(native.answers.color.probabilities.blue, 0.9);
  const ordinary = rpc('assessment.test', { provider: 'codex-lb', model: 'gpt-6-luna' });
  assert.equal(ordinary.status, 'completed');
  assert.equal(ordinary.answers.color.choice, 'blue');
  assert.deepEqual(ordinary.answers.color.choices, ['blue', 'red']);
  assert.equal(ordinary.answers.color.probabilities, undefined);
  assert.equal(ordinary.usage.cacheReadTokens, 10);
  assert.equal(await count(), 2);
  for (const mode of ['native-wrong-model', 'native-missing-model']) {
    await writeFile(path.join(out, 'mode'), mode);
    const rejected = rpc('assessment.test', { provider: 'typesafe', model: 'jev-1.13.0' });
    assert.equal(rejected.status, 'unavailable', mode);
    assert.equal(rejected.error, 'Assessment provider response failed validation', mode);
    assert.equal(rejected.attempted, true, mode);
    assert.equal(rejected.usage?.inputTokens, 100, mode);
  }
  await writeFile(path.join(out, 'mode'), 'native-invalid');
  const nativeRejected = rpc('assessment.test', { provider: 'typesafe', model: 'jev-1.13.0' });
  assert.equal(nativeRejected.status, 'unavailable');
  assert.equal(nativeRejected.attempted, true);
  assert.equal(nativeRejected.usage.inputTokens, 321);
  assert.equal(nativeRejected.usage.outputTokens, 30);
  assert.equal(
    rpc('assessment.get', { id: nativeRejected.assessmentId }).result.usage.inputTokens,
    321,
  );
  await writeFile(path.join(out, 'mode'), 'native-invalid-usage');
  const invalidUsage = rpc('assessment.test', { provider: 'typesafe', model: 'jev-1.13.0' });
  assert.equal(invalidUsage.status, 'unavailable');
  assert.equal(invalidUsage.attempted, true);
  assert.equal(invalidUsage.usage.inputTokens, undefined);
  assert.equal(invalidUsage.usage.outputTokens, 30);
  assert.equal(
    rpc('assessment.get', { id: invalidUsage.assessmentId }).result.status,
    'unavailable',
  );
  await writeFile(path.join(out, 'mode'), 'native-http-error');
  const nativeHttpError = rpc('assessment.test', { provider: 'typesafe', model: 'jev-1.13.0' });
  assert.equal(nativeHttpError.status, 'unavailable');
  assert.equal(nativeHttpError.error, 'Assessment provider response failed validation');
  assert.equal(nativeHttpError.attempted, true);
  assert.equal(nativeHttpError.usage?.inputTokens, 100);
  assert.equal(nativeHttpError.usage?.outputTokens, 20);
  assert.equal(nativeHttpError.usage?.requestId, 'typesafe_503_fixture');
  assert.ok(nativeHttpError.usage?.durationMs >= 0);
  assert.equal(
    rpc('assessment.get', { id: nativeHttpError.assessmentId }).result.usage.inputTokens,
    100,
  );
  for (const [provider, model, mode] of [
    ['typesafe', 'jev-1.13.0', 'native-missing-usage'],
    ['codex-lb', 'gpt-6-luna', 'ordinary-missing-usage'],
  ]) {
    await writeFile(path.join(out, 'mode'), mode);
    const missing = rpc('assessment.test', { provider, model });
    assert.equal(missing.status, 'unavailable', mode);
    assert.equal(missing.attempted, true, mode);
    assert.equal(missing.usage?.inputTokens, undefined, mode);
    assert.equal(missing.usage?.costUsd, undefined, mode);
    assert.equal(missing.usage?.outputTokens, 20, mode);
    assert.equal(
      rpc('assessment.get', { id: missing.assessmentId }).result.usage.inputTokens,
      undefined,
    );
  }
  await writeFile(path.join(out, 'mode'), 'valid');
  const feedback = rpc('assessment.feedback', {
    id: ordinary.assessmentId,
    expectedRevision: 0,
    questionId: 'color',
    verdict: 'incorrect',
    correctedAnswer: 'red',
    adviceShown: true,
    adviceUsed: false,
    evidenceRef: 'fixture:provider-proof',
  });
  assert.equal(feedback.feedback.at(-1).correctedAnswer, 'red');
  for (const mode of [
    'invalid',
    'wrong-model',
    'invalid-tail',
    'early-invalid-tail',
    'ordinary-oversized-body',
    'ordinary-after-headers-timeout',
    'timeout',
  ]) {
    await writeFile(path.join(out, 'mode'), mode);
    const failed = rpc('assessment.test', { provider: 'codex-lb', model: 'gpt-6-luna' });
    assert.equal(failed.status, 'unavailable', mode);
    assert.equal(failed.attempted, true);
    if (
      mode === 'timeout' ||
      mode === 'early-invalid-tail' ||
      mode === 'ordinary-oversized-body' ||
      mode === 'ordinary-after-headers-timeout'
    ) {
      assert.equal(failed.usage?.inputTokens, undefined);
      if (mode !== 'timeout')
        assert.equal(failed.error, 'Assessment provider response failed validation');
    } else {
      assert.equal(failed.usage?.inputTokens, 120, mode);
      assert.equal(failed.usage?.outputTokens, 20, mode);
    }
  }
  assert.equal(await count(), 16, 'No hidden retry or provider fallback');
  const rejected = rpc('assessment.list', { limit: 10 });
  const rejectedRow = rejected.records.find(
    (record) =>
      record.result?.status === 'unavailable' && record.result?.usage?.inputTokens === 120,
  );
  assert.ok(rejectedRow, 'A malformed answer must retain native usage in history');
  assert.equal(rejectedRow.result.usage.outputTokens, 20);
  assert.equal(rejectedRow.result.usage.cacheReadTokens, 10);
  const invalidTail = rejected.records.find(
    (record) =>
      record.result?.status === 'unavailable' &&
      record.result?.usage?.requestId === 'resp_fixture' &&
      record.result?.usage?.inputTokens === 120 &&
      record.result?.usage?.cacheWriteTokens === undefined,
  );
  assert.ok(invalidTail, 'A broken SSE tail must retain received terminal usage');
  await writeFile(path.join(out, 'mode'), 'valid');
  configuration.enabled = true;
  configuration.provider = 'codex-lb';
  configuration.model = 'gpt-6-luna';
  await configure();
  const price = JSON.parse(await readFile('scripts/failure-triage/prices.json', 'utf8'));
  await writeFile(
    path.join(home, 'triage-policy.json'),
    JSON.stringify({
      enabled: true,
      projects: ['fixture'],
      receiptDirectory: path.resolve('scripts/failure-triage/results/v2-held-out'),
      maxCalls: 1,
      maxUsd: 0.1,
      price,
      approvals: [],
    }),
  );
  assert.equal(
    rpc('intelligence.triage.get', { runId: randomUUID() }).availability,
    'unsupported-model',
  );
  assert.equal(await count(), 16, 'An adapter must not inherit another provider’s evaluation gate');
  await stop();
  delete env.CODEX_LB_API_KEY;
  await start();
  assert.equal(rpc('assessment.status').keyAvailable, false);
  const missing = rpc('assessment.test', { provider: 'codex-lb', model: 'gpt-6-luna' });
  assert.equal(missing.status, 'skipped');
  assert.equal(missing.attempted, false);
  assert.equal(await count(), 16);
  assert.equal(rpc('assessment.get', { id: ordinary.assessmentId }).feedback.length, 1);
  await stop();
  env.CODEX_LB_API_KEY = 'provider-fixture-lb-key';
  await start();
  const proof = {
    passed: true,
    mode: 'simulated',
    providerCalls: 16,
    nativeRejectedUsageRetained: true,
    invalidNativeUsageRejected: true,
    nativeHttpErrorReceiptRetained: true,
    earlyMalformedSseReceiptRetained: true,
    nativeModelIdentityRejected: true,
    postHeaderBodyAndTimeoutReceiptsRetained: true,
    missingNativeAndOrdinaryUsageRejected: true,
    externalProviderCalls: 0,
    nativeAndOrdinaryAnswers: true,
    plainChoiceFeedback: true,
    cacheUsagePreserved: true,
    failedResponseUsagePreserved: true,
    noRetriesOrFallback: true,
    missingKeySkipped: true,
    independentConsumerGate: true,
    restartPreservedFeedback: true,
  };
  await writeFile(path.join(out, 'proof.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
  if (process.argv.includes('--live-smoke')) {
    await stop();
    live = true;
    env.CODEX_LB_API_KEY = realKey;
    configuration.timeoutMs = 30000;
    await configure();
    await start();
    const result = rpc('assessment.test', { provider: 'codex-lb', model: 'gpt-6-luna' });
    await writeFile(
      path.join(out, 'live-smoke.json'),
      JSON.stringify({ efficacyEvidence: false, result }, null, 2),
      { mode: 0o600 },
    );
    assert.equal(result.status, 'completed', 'Inspect the saved synthetic connection result');
    assert.equal(result.answers.color.choice, 'blue');
    assert.equal(result.answers.color.probabilities, undefined);
    console.log(
      JSON.stringify({ liveSmoke: true, status: result.status, efficacyEvidence: false }),
    );
  }
  if (process.argv.includes('--keep')) {
    await writeFile(
      path.join(out, 'ui-session.json'),
      JSON.stringify({
        gateway: env.FARMSLOT_GATEWAY,
        token: env.FARMSLOT_GATEWAY_TOKEN,
        pid: child.pid,
        recordId: ordinary.assessmentId,
      }),
      { mode: 0o600 },
    );
    keep = true;
  }
} finally {
  if (keep) {
    child.unref();
    await log?.close();
  } else await stop();
}
