// Manual authenticated framework proof. Uses one disposable native Haiku worker.
// No product slot, run dispatch, publication, selected pin or configured host is touched.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { NativeWorkerSessionBinding, Run } from '@farmslot/protocol';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

import { testGatewayProfile } from '../../lib/test-gateway-identity-source.mts';

if (!process.argv.includes('--live-haiku'))
  throw new Error('Explicit --live-haiku is required for the two cheap model turns');
const withUi = process.argv.includes('--ui');
if (withUi && !process.env.FARMSLOT_CDP_PORT)
  throw new Error('UI proof requires the existing owned browser CDP port');
const source = fileURLToPath(new URL('../../../', import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'derived-acceptance-proof-'));
const output = path.resolve(process.env.FARMSLOT_PROOF_OUTPUT_DIR ?? 'temp/derived-acceptance');
const project = 'acceptance-proof';
const slotId = 'derived-acceptance-private';
const repo = path.join(root, 'projects', project);
const nativeRoot = path.join(root, 'native');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_HOME: root,
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  FARMSLOT_NATIVE_STATE_DIR: nativeRoot,
});
for (const dir of [path.join(root, 'pool'), repo, output]) await mkdir(dir, { recursive: true });
await writeFile(
  path.join(repo, 'project.json'),
  JSON.stringify({ name: project, task_dir: 'tasks', hooks: {}, review: { enabled: false } }),
);
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project,
    platform: 'cli',
    slots: [{ id: slotId, repo, session: slotId }],
  }),
);
const exec = promisify(execFile);
const load = (file: string) => import(new URL(file, new URL('../../../', import.meta.url)).href);
await load('services/gateway/src/runtime/mock-pty.test-support.ts');
const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: root });
const person = auth.writer.createPrincipal(
  { type: 'person', displayName: 'Acceptance proof operator' },
  [{ role: 'admin', scope: { kind: 'global' } }],
);
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = person.id;
const credential = auth.writer.issueCredential(person.id, 'Disposable proof');
const grant = auth.writer.exchangePersonCredential(credential.secret, {
  deviceName: 'Proof',
  deviceKind: 'cli',
});
const store = await load('services/gateway/src/runs/store.ts');
const { initializeAcceptanceRegistration, acceptanceDerivationInstructions } = await load(
  'services/gateway/src/tasks/acceptance-registration.ts',
);
const { syncAcceptanceRegistration } = await load(
  'services/gateway/src/tasks/acceptance-registration-sync.ts',
);
const { ORCHESTRATOR_LOCALITY } = await load('services/gateway/src/core/slot-io.ts');
const { writeTaskDir } = await load('packages/agent-runtime/src/task-init/write.ts');
const { buildHandoffMetadata } = await load(
  'packages/agent-runtime/src/task-init/task-document.ts',
);
const { resolveWorkerTerminalContract } = await load(
  'services/gateway/src/tasks/worker-terminal-contract.ts',
);
const { NativeSessionClient } = await import('@farmslot/agent-runtime/native');
const { matchesProcess } = await load('packages/agent-runtime/src/native/storage.ts');
const native = new NativeSessionClient(nativeRoot);
const { createWebSocketServer } = await load('services/gateway/src/server.ts');
const { GatewayClient } = await load('packages/cli/src/gateway-client.ts');
const server = createServer();
const wss = createWebSocketServer(server, auth);
let client: InstanceType<typeof GatewayClient> | undefined;
let ui: ViteDevServer | undefined;
let route: string | undefined;
let browserEnv: NodeJS.ProcessEnv | undefined;
let binding: NativeWorkerSessionBinding | undefined;
let runId: string | undefined;
const checks: string[] = [];
const browser = async (...args: string[]) => {
  const result = await exec(
    process.execPath,
    [path.join(source, 'apps/command-center/scripts/cdp.mjs'), ...args],
    { cwd: source, env: browserEnv, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
  );
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function waitFor(read: () => Promise<boolean>, label: string, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await read()) return;
    await pause();
  }
  throw new Error(`Timed out: ${label}`);
}
let failure: unknown;
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const gateway = `ws://127.0.0.1:${address.port}/ws`;
  client = await new GatewayClient({
    url: gateway,
    credential: { token: grant.accessToken },
    timeout: 60_000,
  }).connect();
  const run: Run = store.createRun(
    {
      flowType: 'pr-complete',
      mode: 'autonomous',
      project,
      ticketOrPr: 'example/repo#1',
      slotId,
      runner: 'claude',
      model: 'haiku',
      transport: 'native',
    },
    { createdByPrincipalId: person.id, nativeOwnerPrincipalId: person.id },
  );
  runId = run.id;
  const taskDir = path.join(repo, 'tasks/pr-complete', run.id);
  const initial = initializeAcceptanceRegistration(
    run.id,
    [{ id: 'AC-1', text: 'Keep the original requirement visible.' }],
    [
      {
        id: 'comment:1',
        kind: 'review-comment',
        version: 'v1',
        body: 'Record a fixture marker in the task artifacts. This is actionable and needs a state criterion.',
        url: 'https://example.test/comment/1',
      },
      {
        id: 'comment:2',
        kind: 'review-comment',
        version: 'v1',
        body: 'Thanks, this looks good. No work requested.',
        url: 'https://example.test/comment/2',
      },
    ],
    {
      provider: 'github',
      repository: 'example/repo',
      prNumber: 1,
      headSha: 'a'.repeat(40),
      capturedAt: new Date().toISOString(),
    },
  );
  const contract = {
    ...resolveWorkerTerminalContract(null, 'pr-complete', { mode: 'autonomous' }),
    acceptanceContractVersion: 1,
    claimReviewSupported: true,
  };
  const handoff = buildHandoffMetadata({
    attemptId: run.id,
    surface: 'runner-validation',
    project,
    flow: 'pr-complete',
    title: 'Derived acceptance proof',
    sourceKind: 'text',
    ticket: 'example/repo#1',
    terminalContract: contract,
  });
  handoff.executionTemplate = { firstSubtask: 'derive-acceptance' };
  handoff.task = { acceptanceCriteria: ['Keep the original requirement visible.'] };
  await writeTaskDir({
    taskDir,
    taskMarkdown:
      '# Disposable framework proof\n\nOnly work in this task directory. Do not commit, publish, contact external services or complete the root task. Use Bash and file tools.\n\n' +
      acceptanceDerivationInstructions() +
      '\nAfter each accepted child, end your turn. If the child waits for gateway acknowledgement, retry the SAME submitted file until accepted. Never replace registration, handoff or the terminal contract.\n',
    checklistMarkdown: '# Work\n\n- [ ] **1. Derive acceptance**\n- [ ] **2. Wait for operator**\n',
    handoff,
    terminalContract: contract,
    markCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(source, 'packages/agent-runtime/scripts/mark-checklist-step.cjs'))}`,
    fixedMarkCommand: true,
  });
  await writeFile(
    path.join(taskDir, 'inputs/acceptance-registration.json'),
    JSON.stringify({ schemaVersion: 1, generation: 0, registration: initial }),
  );
  store.updateRun(run.id, {
    status: 'monitoring',
    taskFile: path.join(taskDir, 'TASK.md'),
    acceptanceRegistration: initial,
    acceptanceContractVersion: 1,
    ticketData: {
      source: 'manual',
      title: 'Proof',
      description: 'Proof',
      acceptanceCriteria: ['Keep the original requirement visible.'],
      affectedArea: '',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
    steps: [{ name: 'monitor', status: 'running' }],
  });
  await writeFile(
    path.join(root, 'status.json'),
    JSON.stringify({
      slots: [
        {
          slot: slotId,
          current_run_id: run.id,
          task_file: `tasks/pr-complete/${run.id}/TASK.md`,
          lifecycle: 'busy',
          phase: 'working',
        },
      ],
    }),
  );
  // Start the disposable host before sending any worker command. On this host,
  // cold module loading can outlast the client's bounded startup observation.
  const hostStarted = Date.now();
  try {
    await native.list(person.id);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Native host unavailable;'))
      throw error;
    await waitFor(
      async () => {
        try {
          const host = JSON.parse(await readFile(path.join(nativeRoot, 'host.json'), 'utf8'));
          const ready = JSON.parse(await readFile(path.join(nativeRoot, 'ready.json'), 'utf8'));
          return matchesProcess(host.pid, nativeRoot) && matchesProcess(ready.pid, nativeRoot);
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw readError;
        }
      },
      'disposable host becomes ready before worker admission',
      60_000,
    );
  }
  checks.push(
    `Disposable native host ready before model admission in ${Date.now() - hostStarted}ms`,
  );
  const leaseId = randomUUID();
  const session = await native.ensureWorker(
    person.id,
    { sessionId: randomUUID(), runner: 'claude', model: 'haiku', cwd: taskDir },
    { leaseId, safetyTier: 'full-auto', environment: { set: {}, unset: [] } },
  );
  binding = {
    sessionId: session.id,
    executionNodeId: 'local',
    ownerPrincipalId: person.id,
    generation: session.generation,
    leaseId,
    commandId: randomUUID(),
    safetyTier: 'full-auto',
  };
  const target = { sessionId: session.id, generation: session.generation, leaseId };
  store.updateRun(run.id, {
    agentContexts: [
      {
        id: 'primary',
        role: 'primary',
        label: 'Proof worker',
        status: 'working',
        runId: run.id,
        slotId,
        taskFile: path.join(taskDir, 'TASK.md'),
        runner: 'claude',
        model: 'haiku',
        nativeSession: binding,
      },
    ],
  });
  await native.sendWorker(
    person.id,
    target,
    binding.commandId,
    'Read TASK.md. Execute only the initial derive-acceptance child using the frozen sources, then stop your turn. Do not complete the root checklist.',
  );
  const pump = () => syncAcceptanceRegistration(run.id, slotId, ORCHESTRATOR_LOCALITY, taskDir);
  await waitFor(async () => {
    await pump();
    const snap = await native.readWorker(person.id, session.id, leaseId);
    assert.notEqual(snap.session.state, 'failed', snap.session.error);
    return (
      Boolean(store.getRun(run.id)?.acceptanceRegistration?.units[0].result) &&
      snap.session.state === 'idle'
    );
  }, 'real initial derivation');
  const first = (await client.call('run.get', { runId: run.id })).run as Run;
  assert.equal(first.acceptanceRegistration?.original.length, 1);
  assert.equal(first.acceptanceRegistration?.derived.length, 1);
  assert.ok(
    first.acceptanceRegistration?.units[0].result?.classifications.some(
      ({ exclusion }) => exclusion,
    ),
  );
  checks.push(
    'real Haiku classifies frozen actionable and non-actionable sources through the child/gateway acknowledgement',
  );
  const message = {
    runId: run.id,
    slotId,
    operatorMessageId: 'proof-steer',
    text: 'Also preserve a second fixture marker. Register one additional state criterion for this instruction, using its own new derivation child. Stop after the accepted child, without completing the root task.',
    enter: true,
  };
  try {
    const sent = await client.call('terminal.send', message);
    assert.ok(['confirmed', 'queued'].includes(sent.delivery));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('delivery is unconfirmed'))
      throw error;
    checks.push('An uncertain native acknowledgement remains pending for observation');
  }
  await waitFor(async () => {
    await pump();
    return (
      store.getRun(run.id)!.acceptanceRegistration!.units.at(-1)?.delivery?.status === 'confirmed'
    );
  }, 'native operator acceptance receipt');
  const afterSend = store.getRun(run.id)!.acceptanceRegistration!;
  assert.equal(afterSend.units.length, 2);
  await client.call('terminal.send', message);
  assert.equal(store.getRun(run.id)!.acceptanceRegistration!.units.length, 2);
  await assert.rejects(
    client.call('terminal.send', { ...message, text: 'Changed contents' }),
    /changed contents/,
  );
  checks.push('authenticated semantic steering is idempotent and changed-content reuse refuses');
  await waitFor(async () => {
    await pump();
    const snap = await native.readWorker(person.id, session.id, leaseId);
    assert.notEqual(snap.session.state, 'failed', snap.session.error);
    return (
      store.getRun(run.id)!.acceptanceRegistration!.units.every(({ result }) => result) &&
      snap.session.state === 'idle'
    );
  }, 'real operator derivation');
  const final = (await client.call('run.get', { runId: run.id })).run as Run;
  assert.equal(final.acceptanceRegistration?.derived.length, 2);
  assert.deepEqual(
    final.acceptanceRegistration?.derived.map(({ id }) => id),
    ['AC-2', 'AC-3'],
  );
  assert.equal(final.agentContexts?.[0].nativeSession?.sessionId, session.id);
  assert.equal(final.agentContexts?.[0].nativeSession?.generation, session.generation);
  const progress = await client.call('task.progress', { slotId, runId: run.id });
  assert.equal(progress.acceptanceCriteria.length, 3);
  checks.push(
    'same retained native conversation appends AC-3 while AC-1 and AC-2 remain intact; task.progress exposes all three',
  );
  if (withUi) {
    process.env.GATEWAY_PORT = String(address.port);
    ui = await createViteServer({
      root: path.join(source, 'apps/command-center/ui'),
      configFile: path.join(source, 'apps/command-center/ui/vite.config.ts'),
      server: { host: '127.0.0.1', port: 0 },
    });
    await ui.listen();
    const uiAddress = ui.httpServer?.address();
    assert(uiAddress && typeof uiAddress !== 'string');
    testGatewayProfile(root, gateway, credential.secret);
    browserEnv = {
      ...process.env,
      FARMSLOT_GATEWAY_PROFILE: 'proof',
      FARMSLOT_GATEWAY: gateway,
      FARMSLOT_UI_URL: `http://127.0.0.1:${uiAddress.port}`,
    };
    route = `run/${run.id}`;
    await browser('goto', route, '--new');
    assert.equal((await browser('login', route)).authenticated, true);
    await waitFor(
      async () => {
        const read = await browser(
          'eval',
          route!,
          `const walk=r=>[...r.querySelectorAll('*')].flatMap(e=>[e,...(e.shadowRoot?walk(e.shadowRoot):[])]); const nodes=walk(document); return {ids:nodes.filter(e=>e.matches('[data-testid="acceptance-row"]')).map(e=>e.getAttribute('data-ac-id')), overlay:nodes.some(e=>e.localName==='vite-error-overlay')};`,
        );
        assert.equal(read.overlay, false);
        return ['AC-1', 'AC-2', 'AC-3'].every((id) => read.ids.includes(id));
      },
      'real CC acceptance rows',
      60_000,
    );
    await browser('screenshot', route, path.join(output, 'command-center.png'));
    checks.push(
      'Command Center loads all registered acceptance rows through the authenticated gateway',
    );
  }
  await writeFile(
    path.join(output, 'readback.json'),
    JSON.stringify(
      {
        runId: run.id,
        sessionId: session.id,
        generation: session.generation,
        registration: final.acceptanceRegistration,
        progress,
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  failure = error;
} finally {
  const cleanup: unknown[] = [];
  for (const stop of [
    () => (route ? browser('close', route) : Promise.resolve()),
    () => ui?.close(),
    async () => {
      if (binding)
        await native.closeWorker(person.id, {
          sessionId: binding.sessionId,
          generation: binding.generation!,
          leaseId: binding.leaseId,
        });
    },
  ]) {
    try {
      await stop();
    } catch (error) {
      cleanup.push(error);
    }
  }
  client?.close();
  for (const connection of wss.clients) connection.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (runId) {
    try {
      const current = store.getRun(runId)!;
      const snapshot = binding
        ? await native.readWorker(person.id, binding.sessionId, binding.leaseId)
        : undefined;
      if (binding && !snapshot?.session.processStopped)
        throw new Error('Proof worker shutdown is not confirmed');
      store.updateRun(runId, {
        status: 'done',
        agentContexts: current.agentContexts?.map((context) =>
          context.nativeSession
            ? {
                ...context,
                nativeSession: { ...context.nativeSession, closedAt: new Date().toISOString() },
              }
            : context,
        ),
      });
      store.updateRun(runId, { slotId: null, agentContexts: [] });
      await store.deleteRun(runId);
    } catch (error) {
      cleanup.push(error);
    }
  }
  try {
    const host = JSON.parse(await readFile(path.join(nativeRoot, 'host.json'), 'utf8'));
    if (matchesProcess(host.pid, nativeRoot)) {
      process.kill(host.pid, 'SIGTERM');
      await waitFor(
        async () => !matchesProcess(host.pid, nativeRoot),
        'owned native host stops',
        5_000,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanup.push(error);
  }
  const result = {
    pass: !failure && !cleanup.length,
    checks,
    error: failure instanceof Error ? failure.message : failure,
    cleanupErrors: cleanup.map(String),
    scope:
      'Private authenticated gateway, real child CJS and retained native Haiku transport. Production sync cycle is pumped manually; no product run, dispatch or selected configuration.',
    retainedFixture: failure || cleanup.length ? root : undefined,
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  if (!failure && !cleanup.length) await rm(root, { recursive: true, force: true });
  if (failure || cleanup.length) process.exitCode = 1;
}
