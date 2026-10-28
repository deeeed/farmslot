// Private authenticated RPC sequencing proof. The retained instruction adapter and
// worker loop are controlled fixtures; this does not claim real provider delivery.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
const source = process.cwd();
const output = path.resolve(process.argv.at(-1));
await mkdir(output, { mode: 0o700 });
const root = await mkdtemp(path.join(tmpdir(), 'f185-rpc-'));
for (const key of Object.keys(process.env))
  if (key.startsWith('FARMSLOT_') || ['TMUX', 'TMUX_PANE'].includes(key)) delete process.env[key];
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
});
for (const dir of [
  'home',
  'runs',
  'projects/proof',
  'pool',
  'native',
  'repo/.task/dev/proof',
  'projects/proof/tasks/dev/proof/inputs',
])
  await mkdir(path.join(root, dir), { recursive: true });
for (const name of [
  'CLAUDE.md',
  'scripts',
  'services',
  'packages',
  'schemas',
  'node_modules',
  'package.json',
])
  await symlink(path.join(source, name), path.join(root, name));
const moduleUrl = (name) => pathToFileURL(path.join(source, name)).href;
const load = (name) => import(moduleUrl(name));
const save = (name, value) =>
  writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
await save('ownership.json', {
  source,
  fixtureRoot: root,
  pid: process.pid,
  statusFile: process.env.FARMSLOT_TEST_STATUS_FILE,
  runsDir: process.env.FARMSLOT_RUNS_DIR,
  home: process.env.FARMSLOT_HOME,
});
await load('services/gateway/src/runtime/mock-pty.test-support.ts');
const signalFile = path.join(root, 'repo/.task/dev/proof/SIGNAL.json');
const feedbackFile = path.join(root, 'repo/.task/dev/proof/feedback.txt');
const prior = {
  status: 'complete',
  outcome: 'success',
  timestamp: '2026-10-28T00:16:00.000Z',
  attemptId: 'retained-attempt',
  role: 'dev',
  contextId: 'retained-worker',
};
await writeFile(signalFile, JSON.stringify(prior));
await writeFile(path.join(root, 'repo/.task/dev/proof/TASK.md'), '# Retained completion proof\n');
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', hooks: {}, review: { enabled: false }, ci: { enabled: false } }),
);
const slotId = 'completion-proof-slot';
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: hostname(),
    host: 'localhost',
    platform: 'cli',
    project: 'proof',
    slots: [
      { id: slotId, enabled: true, repo: path.join(root, 'repo'), session: slotId, resources: {} },
    ],
  }),
);
await writeFile(path.join(root, 'status.json'), '{"slots":[]}');
const repo = path.join(root, 'repo');
const git = (...args) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
git('init', '-q', '-b', 'fixture');
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
  'test: seed private completion proof',
);
git('update-ref', 'refs/remotes/origin/main', 'HEAD');
let store, monitor, runId, http, wss, client, auth, releaseGate;
let monitorReads = 0,
  completeCalls = 0,
  deliveredContext;
const deadline = (label, read, accept) =>
  (async () => {
    const end = Date.now() + 15000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      assert.ok(Date.now() < end, label);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
const failUnexpected = () => {
  throw new Error('Unexpected proof branch');
};
mock.module(moduleUrl('services/gateway/src/run-engine/post-dispatch-steps.ts'), {
  namedExports: {
    executeMonitorStep: async (id) => {
      for (;;) {
        const current = store.getRun(id);
        if (['cancelled', 'paused'].includes(current.status))
          return { inputs: {}, outputs: { exitReason: 'aborted' } };
        const signal = JSON.parse(await readFile(signalFile, 'utf8'));
        monitorReads++;
        if (monitor.isWorkerSignalFreshForRun(current, signal))
          return { inputs: {}, outputs: { workerSignal: signal } };
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    executeReviewStep: async () => ({ inputs: {}, outputs: { skipped: true } }),
    executeCompleteStep: async () => {
      completeCalls++;
      return { inputs: {}, outputs: { proofReachedComplete: true } };
    },
    executeHumanGateStep: async () => {
      await new Promise((resolve) => {
        releaseGate = resolve;
      });
      return { inputs: {}, outputs: { resolvedAction: 'hold' } };
    },
    holdInteractiveCompletionForOperator: failUnexpected,
    isFlowTerminalStep: () => false,
    readyGateReviewSubjectMatches: () => false,
    persistedUpdateBranchNeedsReview: () => false,
    shouldSkipRetrospectiveAtComplete: () => true,
    baseReviewPolicy: () => 'static-code',
    holdSlotForPublicationGate: failUnexpected,
    rerunReviewIfReviewedInputsChanged: async () => false,
  },
});
const transport = await load('services/gateway/src/runners/operator-instruction.ts');
mock.module(moduleUrl('services/gateway/src/runners/operator-instruction.ts'), {
  namedExports: {
    ...transport,
    deliverOperatorInstruction: async (_run, key, text, _since, contextId) => {
      deliveredContext = contextId;
      await writeFile(feedbackFile, text, { flag: 'wx' });
      await save('delivery.json', { key, contextId, text, fixtureAdapter: true });
      return 'confirmed';
    },
  },
});
monitor = await load('services/gateway/src/run-engine/run-monitor.ts');
mock.module(moduleUrl('services/gateway/src/run-engine/run-monitor.ts'), {
  namedExports: {
    ...monitor,
    probeWorkerSignalForRun: async (id) => {
      const signal = JSON.parse(await readFile(signalFile, 'utf8'));
      const ok = monitor.isWorkerSignalFreshForRun(store.getRun(id), signal);
      return { ok, code: ok ? 'ready' : 'stale', message: 'Fixture source signal', signal };
    },
  },
});
let failure;
const cleanupErrors = [];
const cleanup = [];
const attemptCleanup = async (label, action) => {
  try {
    await action();
    cleanup.push({ label, status: 'PASS' });
  } catch (error) {
    cleanupErrors.push(error);
    cleanup.push({ label, status: 'FAIL', message: error.message });
  }
};
try {
  const { FLOW_STEPS } = await load('packages/protocol/src/index.ts');
  store = await load('services/gateway/src/runs/store.ts');
  const { buildResultDecision } = await load(
    'services/gateway/src/run-completion/result-decision.ts',
  );
  const { retainRunFixture } = await load('services/gateway/src/run-engine/test-fixtures.ts');
  const { rewriteStatusFile, readSlotField } = await load('services/gateway/src/core/state.ts');
  const created = store.createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'proof',
    ticketOrPr: 'FIXTURE-185',
    slotId,
    runner: 'claude',
    transport: 'tmux',
    branch: 'fixture',
  });
  runId = created.id;
  const refusal = 'Declared video is outside the selected recipe attempt.';
  const run = store.updateRun(runId, {
    status: 'needs-decision',
    completionPolicy: 'artifact-only',
    taskFile: path.join(root, 'projects/proof/tasks/dev/proof/TASK.md'),
    engineState: { generation: 7 },
    agentContexts: [
      {
        id: 'retained-worker',
        runId,
        role: 'dev',
        label: 'Retained fixture',
        status: 'idle',
        slotId,
        runner: 'claude',
        runnerSessionId: 'retained-session',
        signalAttemptId: prior.attemptId,
        signalFile: '.task/dev/proof/SIGNAL.json',
      },
    ],
    steps: FLOW_STEPS.dev.map((name) => ({
      name,
      status:
        name === 'complete'
          ? 'failed'
          : ['human-gate', 'finalize', 'ci-watch'].includes(name)
            ? 'pending'
            : 'done',
      ...(name === 'complete' ? { detail: refusal } : {}),
      ...(name === 'monitor'
        ? { outputs: { workerSignal: prior, pushVerification: { verified: true } } }
        : {}),
    })),
    output: {
      capturedAt: prior.timestamp,
      workerFinished: true,
      artifactManifest: [],
      manifestDigest: 'a'.repeat(64),
      reportPath: 'report.md',
    },
  });
  const { resolveWorkerTerminalContract } = await load(
    'services/gateway/src/tasks/worker-terminal-contract.ts',
  );
  const gatewayTask = path.dirname(run.taskFile);
  await writeFile(run.taskFile, '# Retained completion proof\n');
  const terminalContract = {
    ...resolveWorkerTerminalContract(undefined, run.flowType, { mode: run.mode }),
    recordedEvidenceContractVersion: run.recordedEvidenceContractVersion,
  };
  assert.equal(
    terminalContract.recordedEvidenceContractVersion,
    run.recordedEvidenceContractVersion,
  );
  await writeFile(
    path.join(gatewayTask, 'inputs/worker-terminal-contract.json'),
    JSON.stringify(terminalContract),
  );
  await writeFile(
    path.join(gatewayTask, 'inputs/handoff.json'),
    JSON.stringify({ attemptId: run.id, project: run.project, flow: run.flowType }),
  );
  run.decisions = [await buildResultDecision(run, 'complete')];
  await retainRunFixture(run);
  await store.persistRunNow(run, 'completion proof setup before server');
  await rewriteStatusFile(() => ({
    slots: [
      {
        slot: slotId,
        machine: hostname(),
        project: 'proof',
        platform: 'cli',
        enabled: true,
        current_run_id: runId,
        slot_epoch: 1,
        lifecycle: 'held',
        phase: 'awaiting-approval',
        agent: 'idle',
      },
    ],
  }));
  assert.equal(
    await readSlotField(slotId, 'current_run_id'),
    runId,
    'Fixture must own its private slot before the RPC',
  );
  const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
  const { createWebSocketServer } = await load('services/gateway/src/server.ts');
  const { GatewayClient } = await load('packages/cli/src/gateway-client.ts');
  auth = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'home') });
  const principal = auth.writer.createPrincipal(
    { type: 'person', displayName: 'Completion proof' },
    [{ role: 'admin', scope: { kind: 'global' } }],
  );
  const credential = auth.writer.issueCredential(principal.id, 'Owned completion proof');
  const grant = auth.writer.exchangePersonCredential(credential.secret, {
    deviceName: 'Fixture',
    deviceKind: 'cli',
  });
  http = createServer();
  wss = createWebSocketServer(http, auth);
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  client = await new GatewayClient({
    url: `ws://127.0.0.1:${http.address().port}/ws`,
    credential: { token: grant.accessToken },
    timeout: 30000,
  }).connect();
  const originalDispatch = { ...run.steps.find((step) => step.name === 'dispatch') };
  await save('before.json', { runId, generation: 7, prior, fixtureRoot: root });
  await client.call('run.resolveDecision', {
    runId,
    decisionId: run.decisions[0].id,
    actionId: 'send-back',
    reason: 'Correct the declaration and keep accepted evidence.',
  });
  await deadline(
    'Monitor never started before COMPLETE',
    async () => ({ monitorReads, completeCalls }),
    (value) => value.monitorReads >= 3 || value.completeCalls > 0,
  );
  assert.equal(completeCalls, 0, 'COMPLETE must wait for new source evidence');
  assert.equal(deliveredContext, 'retained-worker');
  assert.match(
    await readFile(feedbackFile, 'utf8'),
    /Declared video is outside the selected recipe attempt/,
  );
  const waiting = (await client.call('run.get', { runId, view: 'snapshot' })).run;
  assert.equal(waiting.status, 'monitoring');
  const retainedDispatch = waiting.steps.find((step) => step.name === 'dispatch');
  assert.equal(retainedDispatch.status, 'done');
  assert.equal(retainedDispatch.startedAt, originalDispatch.startedAt);
  assert.equal(retainedDispatch.completedAt, originalDispatch.completedAt);
  assert.equal(
    waiting.agentContexts.find((context) => context.id === 'retained-worker').runnerSessionId,
    'retained-session',
  );
  const persisted = JSON.parse(await readFile(path.join(root, 'runs', `${runId}.json`), 'utf8'));
  assert.equal(monitor.isWorkerSignalFreshForRun(persisted, prior), false);
  await save('waiting.json', {
    run: waiting,
    monitorReads,
    completeCalls,
    persistedOldSignalRejected: true,
  });
  await writeFile(signalFile, JSON.stringify({ ...prior, timestamp: '2026-10-28T00:16:01.000Z' }));
  await deadline(
    'New source signal did not reach COMPLETE',
    async () => completeCalls,
    (count) => count === 1,
  );
  await save('result.json', {
    status: 'PASS',
    runId,
    authenticatedRpc: true,
    exactRefusalDelivered: true,
    oldSignalIgnored: true,
    newSignalReachedComplete: true,
    retainedSession: 'retained-session',
    scope:
      'Gateway RPC sequencing with controlled instruction adapter and file-backed worker fixture; no real provider/pane delivery claim',
  });
} catch (error) {
  failure = error;
  await save('failure.json', {
    message: error.message,
    stack: error.stack,
    runId,
    monitorReads,
    completeCalls,
  });
} finally {
  await attemptCleanup('stop owned fixture engine', async () => {
    if (runId && store?.getRun(runId)) {
      store.updateRun(runId, { status: 'cancelled' });
      releaseGate?.();
      await new Promise(setImmediate);
      await store.persistRunNow(store.getRun(runId), 'completion proof cleanup');
    }
    const { unwatchSlot } = await load('services/gateway/src/tasks/watcher.ts');
    await unwatchSlot(slotId);
  });
  await attemptCleanup('close owned RPC server', async () => {
    client?.close();
    if (wss) {
      for (const connection of wss.clients) connection.terminate();
      await new Promise((resolve) => wss.close(resolve));
    }
    if (http?.listening)
      await new Promise((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
  });
  await attemptCleanup('remove owned temporary root', async () => {
    const { makeOwnerWritable } = await load('services/gateway/src/core/owned-copy.ts');
    await makeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  await save('cleanup.json', {
    status: cleanupErrors.length ? 'FAIL' : 'PASS',
    checks: cleanup,
    ownedServerClosed: !http?.listening,
    nativeOrProviderLaunches: 0,
    fixtureRoot: root,
  });
  if (cleanupErrors.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      'Completion proof cleanup failed',
    );
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    status: 'PASS',
    runId,
    proofRoot: output,
    exactRefusalDelivered: true,
    oldSignalIgnored: true,
    newSignalReachedComplete: true,
  }),
);
