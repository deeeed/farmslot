// Own two short-lived gateway processes; never restart the operator gateway.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
assert.equal(process.env.FARMSLOT_ASSESSMENT_VALIDATION, '1');
const port = Number(process.env.FARMSLOT_ASSESSMENT_RESTART_PORT);
assert.ok(
  Number.isInteger(port) && port > 1024 && port < 65536,
  'Set a free isolated FARMSLOT_ASSESSMENT_RESTART_PORT',
);
try {
  await fetch(`http://127.0.0.1:${port}/health`);
  throw new Error('Restart proof port is already occupied');
} catch (error) {
  if (!(error instanceof TypeError)) throw error;
}
const home = await mkdtemp(path.join(tmpdir(), 'assessment-proof-restart-'));
const env = {
  ...process.env,
  FARMSLOT_HOME: home,
  FARMSLOT_POOL_DIR: path.join(home, 'pool'),
  GATEWAY_PORT: String(port),
  GATEWAY_HOST: '127.0.0.1',
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  FARMSLOT_ASSESSMENT_ENABLED: 'false',
  FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
  TSX_TSCONFIG_PATH: 'services/gateway/tsconfig.json',
};
delete env.FARMSLOT_GATEWAY_TOKEN;
delete env.FARMSLOT_GATEWAY_PASSWORD;
let child, log;
function rpc(method, params = {}) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['apps/command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
      { env, encoding: 'utf8' },
    ),
  );
}
async function start() {
  log = await open(path.join(home, 'gateway.log'), 'a');
  child = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
    env,
    stdio: ['ignore', log.fd, log.fd],
  });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null)
      throw new Error(`Proof gateway exited ${child.exitCode}; log ${home}/gateway.log`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    } // Connection refusal is expected during startup.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Proof gateway did not become ready');
}
async function stop() {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  await log?.close();
  log = undefined;
}
try {
  execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/assessment-validation/seed.mts', '--alias'],
    {
      env,
      stdio: 'pipe',
    },
  );
  await start();
  const alias = rpc('assessment.list').records.find(
    (r) => r.status === 'completed' && r.result?.requestedModel === 'latest',
  );
  assert.ok(alias, 'Alias completion fixture must exist');
  const accounting = rpc('assessment.report', { assessmentId: alias.id });
  assert.equal(accounting.records.length, 3);
  assert.equal(accounting.summary.callsWithUsage, 2);
  assert.deepEqual(
    accounting.summary.modelTotals.map(({ consumer, provider, model, calls }) => ({
      consumer,
      provider,
      model,
      calls,
    })),
    [{ consumer: 'review-intake', provider: 'fixture', model: 'latest', calls: 3 }],
  );
  assert.equal(accounting.summary.uniqueCases, 2);
  assert.ok(accounting.records.some((r) => r.status === 'unavailable'));
  const paired = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/assessment-validation/evaluate-pair.mts', accounting.reportId],
    { env, encoding: 'utf8' },
  );
  console.log(paired.trim());
  const record = rpc('assessment.list').records.find((r) => r.status === 'completed');
  const updated = rpc('assessment.feedback', {
    id: record.id,
    expectedRevision: 0,
    questionId: 'risk',
    verdict: 'correct',
    adviceUsed: false,
    adviceShown: true,
    evidenceRef: 'fixture:restart',
  });
  const frozen = rpc('assessment.report', { assessmentId: record.id });
  await stop();
  await start();
  assert.deepEqual(rpc('assessment.get', { id: record.id }).feedback, updated.feedback);
  assert.deepEqual(rpc('assessment.report', { id: frozen.reportId }), frozen);
  assert.ok(rpc('assessment.list').records.some((r) => r.status === 'interrupted'));
  console.log(
    JSON.stringify({
      failedAliasAttemptRetained: true,
      restartPreservedFeedback: true,
      restartPreservedReport: true,
      interruptedVisible: true,
    }),
  );
} finally {
  await stop();
  await rm(home, { recursive: true, force: true });
}
