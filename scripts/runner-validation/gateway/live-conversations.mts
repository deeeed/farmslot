/** Isolated authenticated CC proof. Run from Aqua; never points at the operator gateway. */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  NativeSessionInfo,
  NativeSessionReadResult,
  NativeSessionDeltaPayload,
  NativeSessionSubscribeResult,
  NativeSessionCatalogResult,
  NativeWorkerControlTarget,
} from '@farmslot/protocol';

import { CdpWebPage } from '../../../packages/recipe-runner/src/runtime/cdp.js';

if (process.platform === 'darwin')
  assert.equal(
    execFileSync('/bin/launchctl', ['managername'], { encoding: 'utf8' }).trim(),
    'Aqua',
    'Start this proof from the login GUI context',
  );
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.resolve(process.argv[2] ?? '/tmp/live-conversations-proof');
const root = await mkdtemp(path.join(tmpdir(), 'live-conversations-proof-'));
const reuseFiles = JSON.parse(process.env.FARMSLOT_STREAM_PROOF_REUSE ?? '[]') as string[];
await mkdir(output, { recursive: true });
for (const directory of ['scripts', 'services/gateway', 'pool', 'projects'])
  await mkdir(path.join(root, directory), { recursive: true });
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated live conversation proof\n');
await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    project: 'stream-proof',
    host: 'localhost',
    platform: 'cli',
    slots: [],
    review_workspaces: { max_concurrent: 6 },
  }),
);
await writeFile(
  path.join(root, 'status.json'),
  JSON.stringify({
    checkedAt: new Date().toISOString(),
    slots: [],
    summary: {
      total: 0,
      ready: 0,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  }),
);
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: '',
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  FARMSLOT_OPERATOR_CHECKOUT: path.join(root, 'checkout'),
  FARMSLOT_STREAM_COUNTER_DIRECTORY: path.join(root, 'counters'),
});
const counterFixture = fileURLToPath(
  new URL('../fixtures/native-stream-counters.mjs', import.meta.url),
);
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--import=' + counterFixture]
  .filter(Boolean)
  .join(' ');
await import('../fixtures/native-stream-counters.mjs');
const reusedIds: string[] = [];
for (const file of reuseFiles) {
  const retained = JSON.parse(fs.readFileSync(file, 'utf8')) as { root: string; closed: string[] };
  for (const id of retained.closed) {
    assert(/^[0-9a-f-]{36}$/.test(id));
    const target = path.join(root, 'native/sessions');
    await mkdir(target, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(target, id + '.journal'),
      fs.readFileSync(path.join(retained.root, 'native/sessions', id + '.journal')),
      { mode: 0o600 },
    );
    reusedIds.push(id);
  }
}
const checkout = path.join(root, 'checkout');
await mkdir(checkout, { recursive: true });
await mkdir(path.join(checkout, 'docs'), { recursive: true });
await writeFile(path.join(checkout, 'docs/ROADMAP-next.md'), '# Private proof: no queued work\n');
await writeFile(
  path.join(checkout, 'CLAUDE.md'),
  '# Private proof checkout\nDo not modify files or contact any production services.\n',
);
execFileSync('git', ['init', '-q', checkout]);
execFileSync('git', ['-C', checkout, 'add', 'CLAUDE.md']);
execFileSync('git', [
  '-C',
  checkout,
  '-c',
  'user.name=Proof',
  '-c',
  'user.email=proof@localhost',
  'commit',
  '-qm',
  'Private proof fixture',
]);
const { createGatewayAuthRuntime } = await import('../../../services/gateway/src/security/auth.js');
const { createWebSocketServer, initServerGlobals, resetServerGlobalsForTests } =
  await import('../../../services/gateway/src/server.js');
const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.js');
const { createServer: createVite } = await import('vite');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME });
const roles = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
const owner = auth.writer.createPrincipal(
  { type: 'service', displayName: 'Proof executor' },
  roles,
  'proof-executor',
);
const ownerCredential = auth.writer.issueCredential(owner.id, 'Private bootstrap');
await writeFile(path.join(root, 'companion.secret'), ownerCredential.secret, { mode: 0o600 });
auth.writer.createPrincipal(
  { type: 'person', displayName: 'Proof operator' },
  roles,
  'proof-operator',
);
auth.writer.retirePrincipals(['proof-operator']);
const person = auth.writer.createPrincipal(
  { type: 'person', displayName: 'Proof operator' },
  roles,
  'proof-operator',
  { reuseRetiredId: true },
);
const credential = auth.writer.issueCredential(person.id, 'Private browser');
await writeFile(path.join(root, 'operator.secret'), credential.secret, { mode: 0o600 });
const grant = auth.writer.exchangePersonCredential(credential.secret, {
  deviceName: 'Proof RPC',
  deviceKind: 'cli',
});
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
// Start only the private host from this Aqua process before arming source observation.
// This keeps observation startup separate from the tool-policy and workspace claims.
const { NativeSessionClient } =
  await import('../../../packages/agent-runtime/src/native/client.js');
await new NativeSessionClient(path.join(root, 'native')).warm();
const server = createServer();
const wss = createWebSocketServer(server, auth);
initServerGlobals();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const client = new GatewayClient({
  url: `ws://127.0.0.1:${address.port}/ws`,
  credential: { token: grant.accessToken },
  timeout: 60_000,
});
const connection = await client.connect();
await writeFile(
  path.join(output, 'connection.json'),
  JSON.stringify({
    root,
    gatewayUrl: `ws://127.0.0.1:${address.port}/ws`,
    credentialFile: path.join(root, 'companion.secret'),
    operatorCredentialFile: path.join(root, 'operator.secret'),
  }),
  { mode: 0o600 },
);
const cdp = `http://127.0.0.1:${Number(process.env.FARMSLOT_CDP_PORT ?? 19223)}`;
let page: CdpWebPage | undefined;
let tabId: string | undefined;
let vite: Awaited<ReturnType<typeof createVite>> | undefined;
const sessions: NativeSessionInfo[] = [];
const managed = process.env.FARMSLOT_STREAM_PROOF_MANAGED === '1';
const workerTargets = new Map<string, NativeWorkerControlTarget>();
const initialCommands = new Map<string, string>();
const privateNative = new NativeSessionClient(path.join(root, 'native'));
const findView = `(() => { const find = root => { const match = root.querySelector('native-session-view'); if (match) return match; for (const element of root.querySelectorAll('*')) { if (element.shadowRoot) { const nested = find(element.shadowRoot); if (nested) return nested; } } }; return find(document); })()`;
const results: Record<string, unknown> = { root, productionServicesChanged: false, proofs: [] };
async function until(
  check: () => boolean | Promise<boolean>,
  description: string,
  timeout = 60_000,
) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < end, 'Timed out: ' + description);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
const screenshot = async (name: string) => {
  assert(page);
  const shot = await page.session.call<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
  });
  await writeFile(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
};
const read = (id: string) =>
  connection.call('native.session.read', {
    sessionId: id,
    executionNodeId: 'local',
    ...(workerTargets.has(id) ? { worker: workerTargets.get(id) } : {}),
    limit: 500,
  }) as Promise<NativeSessionReadResult>;
interface RunnerProof {
  runner: string;
  model?: string;
  sessionId?: string;
  version?: string;
  frames: NativeSessionDeltaPayload[];
  bytes: number;
  textBeforeCompletion: boolean;
  visibleBeforeCompletion: boolean;
  error?: string;
}
const proofs: RunnerProof[] = [];
results.proofs = proofs;
results.managed = managed;
const activeSubscriptions = new Set<string>();
let activeProof: RunnerProof | undefined;
let completed = false;
const stopEvents = connection.onEvent((frame) => {
  if (frame.event !== 'native.session.delta') return;
  const payload = frame.payload as NativeSessionDeltaPayload;
  if (!activeSubscriptions.has(payload.subscriptionId) || !activeProof) return;
  activeProof.frames.push(payload);
  activeProof.bytes += Buffer.byteLength(JSON.stringify(payload));
  if (payload.kind !== 'delta' && payload.kind !== 'replay') return;
  for (const event of payload.page.events) {
    if (event.type === 'text.delta' && !completed) activeProof.textBeforeCompletion = true;
    if (event.type === 'turn.completed') completed = true;
  }
});
try {
  vite = await createVite({
    configFile: path.join(repo, 'apps/command-center/ui/vite.config.ts'),
    envDir: path.join(root, 'no-env'),
    cacheDir: path.join(root, 'vite-cache'),
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 5191,
      strictPort: true,
      proxy: {
        '/ws': { target: `http://127.0.0.1:${address.port}`, ws: true },
        '/api': { target: `http://127.0.0.1:${address.port}` },
      },
    },
  });
  await vite.listen();
  const target: unknown = await (
    await fetch(cdp + '/json/new?' + encodeURIComponent('http://127.0.0.1:5191/'), {
      method: 'PUT',
    })
  ).json();
  assert(
    target &&
      typeof target === 'object' &&
      'id' in target &&
      typeof target.id === 'string' &&
      'webSocketDebuggerUrl' in target &&
      typeof target.webSocketDebuggerUrl === 'string',
  );
  tabId = target.id;
  page = await CdpWebPage.connectToTarget({
    id: target.id,
    type: 'page',
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
  });
  await page.session.call('Page.bringToFront');
  await page.session.call('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const browserErrors: unknown[] = [];
  results.browserErrors = browserErrors;
  page.session.on('Runtime.exceptionThrown', (event) => browserErrors.push(event.exceptionDetails));
  await page.waitForSelector('.auth-input', { timeoutMs: 60_000 });
  await page.setInput('.auth-input', credential.secret);
  await page.click('.auth-submit');
  await page.waitForSelector('[data-testid=copilot-target]', { timeoutMs: 60_000 });
  assert.equal(await page.evaluate('location.hash.split("?")[0]'), '#copilot');
  results.defaultHome = true;
  if (
    await page.evaluate("[...document.querySelectorAll('whats-new-modal')].some(view => view.open)")
  )
    await page.clickText('Got it');
  const catalog = (await connection.call(
    'native.session.catalog',
    {},
  )) as NativeSessionCatalogResult;
  results.installedRunners = catalog.runners.map((row) => row.runner);
  const selected = process.env.FARMSLOT_STREAM_PROOF_RUNNERS?.split(',').filter(Boolean) ?? [
    'codex',
    'pi',
    'cursor',
    'grok',
    'opencode',
    'claude',
  ];
  const models: Record<string, string> = {
    codex: 'gpt-6-luna',
    claude: 'haiku',
    pi: process.env.FARMSLOT_PI_PROOF_MODEL ?? 'litellm/DeepSeek-V4-Flash',
    cursor: 'auto',
    opencode: process.env.FARMSLOT_OPENCODE_PROOF_MODEL ?? 'litellm/DeepSeek-V4-Flash',
  };
  for (const runner of selected) {
    const proof: RunnerProof = {
      runner,
      model: models[runner],
      frames: [],
      bytes: 0,
      textBeforeCompletion: false,
      visibleBeforeCompletion: false,
    };
    proofs.push(proof);
    activeProof = proof;
    completed = false;
    try {
      assert(
        catalog.runners.some((row) => row.runner === runner),
        runner + ' is not available in catalog',
      );
      let info: NativeSessionInfo;
      if (managed) {
        const workspace = path.join(root, 'workspaces', runner);
        await mkdir(workspace, { recursive: true });
        const leaseId = crypto.randomUUID();
        info = await privateNative.ensureWorker(
          owner.id,
          {
            sessionId: crypto.randomUUID(),
            runner,
            model: models[runner],
            cwd: workspace,
            executionNodeId: 'local',
            mode: 'default',
          },
          {
            leaseId,
            environment: { set: {}, unset: [] },
            safetyTier: 'sandboxed',
            approvalPolicy: 'never',
          },
        );
        sessions.push(info);
        const { createRun, updateRun, updateRunAgentContexts } =
          await import('../../../services/gateway/src/runs/store.js');
        // Private fixture records establish the real broker's run/context/lease checks.
        // No run dispatch, prepare, worker monitor, or production record is created.
        const run = createRun(
          {
            flowType: 'dev',
            project: 'stream-proof',
            ticketOrPr: 'STREAM-' + runner,
            runner,
            transport: 'native',
            mode: 'interactive',
          },
          { nativeOwnerPrincipalId: owner.id },
        );
        await mkdir(path.join(workspace, 'artifacts'), { recursive: true });
        updateRun(run.id, {
          reviewWorkspace: {
            workspaceId: crypto.randomUUID(),
            machine: 'local',
            executionNodeId: 'local',
            checkoutPath: workspace,
            taskPath: workspace,
            artifactPath: path.join(workspace, 'artifacts'),
          },
        });
        const commandId = crypto.randomUUID();
        initialCommands.set(info.id, commandId);
        updateRunAgentContexts(run.id, () => [
          {
            id: 'review',
            role: 'review',
            label: 'Stream proof reviewer',
            status: 'working',
            slotId: null,
            runId: run.id,
            runner,
            nativeSession: {
              sessionId: info.id,
              executionNodeId: 'local',
              generation: info.generation,
              leaseId,
              commandId,
              ownerPrincipalId: owner.id,
            },
          },
        ]);
        workerTargets.set(info.id, {
          runId: run.id,
          contextId: 'review',
          generation: info.generation,
          leaseId,
        });
      } else {
        info = (
          (await connection.call('native.session.create', {
            runner,
            model: models[runner],
            cwd: homedir(),
            executionNodeId: 'local',
            mode: 'default',
            approvalMode: 'ask',
          })) as { session: NativeSessionInfo }
        ).session;
      }
      const created = { session: info };
      if (!managed) sessions.push(info);
      proof.sessionId = info.id;
      proof.version = info.version;
      const selection = {
        sessionId: info.id,
        executionNodeId: 'local',
        ...(workerTargets.has(info.id) ? { worker: workerTargets.get(info.id) } : {}),
      };
      const first = (await connection.call(
        'native.session.subscribe',
        selection,
      )) as NativeSessionSubscribeResult;
      const second = (await connection.call(
        'native.session.subscribe',
        selection,
      )) as NativeSessionSubscribeResult;
      activeSubscriptions.add(first.subscriptionId);
      activeSubscriptions.add(second.subscriptionId);
      await page.session.call('Page.navigate', {
        url: managed
          ? 'http://127.0.0.1:5191/#terminal?' +
            new URLSearchParams({ run: workerTargets.get(info.id)!.runId, contextId: 'review' })
          : 'http://127.0.0.1:5191/#native?' +
            new URLSearchParams({ sessionId: info.id, executionNodeId: 'local' }),
      });
      await page.waitForSelector(
        managed ? '[data-testid=native-worker-label]' : '[data-testid=native-message]',
        { timeoutMs: 60_000 },
      );
      await page.waitForExpression(`${findView}?.historyObservation?.status === 'ready'`, {
        timeoutMs: 60_000,
      });
      const commandId = initialCommands.get(info.id) ?? crypto.randomUUID();
      const text =
        'Output the integers from 1 to 160, one per line, with no commentary and no tool calls.';
      const worker = workerTargets.get(info.id);
      if (worker)
        await privateNative.sendWorker(
          owner.id,
          { sessionId: info.id, generation: worker.generation, leaseId: worker.leaseId },
          commandId,
          text,
        );
      else await connection.call('native.session.send', { ...selection, commandId, text });
      await until(
        () => proof.textBeforeCompletion || completed,
        runner + ' first committed stream text',
        180_000,
      );
      await until(async () => {
        if (completed) return true;
        proof.visibleBeforeCompletion = await page!.evaluate<boolean>(
          `(() => { const view=${findView}; return Boolean(view?.shadowRoot?.textContent.includes('1') && view?.historyObservation?.data?.events.some(event => event.type === 'text.delta')); })()`,
        );
        return proof.visibleBeforeCompletion;
      }, runner + ' first visible stream text');
      if (proof.visibleBeforeCompletion) await screenshot(runner + '-streaming');
      await until(
        () => completed || proof.frames.some((frame) => frame.kind === 'terminal'),
        runner + ' turn completion',
        180_000,
      );
      assert(completed, runner + ' stream terminated before completion');
      assert(proof.textBeforeCompletion, runner + ' emitted no text before completion');
      assert(proof.visibleBeforeCompletion, runner + ' had no visible text before completion');
      for (const id of activeSubscriptions)
        await connection.call('native.session.unsubscribe', { subscriptionId: id });
      activeSubscriptions.clear();
      const body = await read(created.session.id);
      assert(
        body.events.some(
          (event) => event.type === 'turn.completed' && event.status === 'completed',
        ),
        runner + ' did not complete successfully',
      );
      await writeFile(path.join(output, runner + '-receipt.json'), JSON.stringify(body, null, 2));
    } catch (error) {
      proof.error = String(error);
      // Keep all runner failure receipts so one unavailable account does not hide the other rows.
    } finally {
      for (const id of activeSubscriptions)
        await connection.call('native.session.unsubscribe', { subscriptionId: id });
      activeSubscriptions.clear();
      await writeFile(path.join(output, 'progress.json'), JSON.stringify(results, null, 2));
    }
  }
  if (reusedIds.length) {
    const id = reusedIds[0];
    const url =
      'http://127.0.0.1:5191/#native?' +
      new URLSearchParams({ sessionId: id, executionNodeId: 'local' });
    for (let sample = 0; sample < 21; sample++) {
      await page.session.call('Page.navigate', { url: 'http://127.0.0.1:5191/#copilot' });
      await page.waitForSelector('[data-testid=copilot-target]');
      await page.session.call('Page.navigate', { url });
      await page.waitForExpression(`${findView}?.historyObservation?.status === 'ready'`);
      await page.evaluate(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
      await page.evaluate(
        "import('/src/gateway-client.ts').then(({gateway}) => gateway.request('native.session.catalog', {}))",
      );
    }
    const counters = () =>
      fs
        .readdirSync(path.join(root, 'counters'))
        .filter((file) => file.endsWith('.json'))
        .map((file) => JSON.parse(fs.readFileSync(path.join(root, 'counters', file), 'utf8')))
        .reduce(
          (sum, row) => ({
            journalReads: sum.journalReads + row.journalReads,
            journalBytes: sum.journalBytes + row.journalBytes,
            processStarts: sum.processStarts + row.processStarts,
          }),
          { journalReads: 0, journalBytes: 0, processStarts: 0 },
        );
    const before = counters();
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    const after = counters();
    results.idle = {
      windowMs: Date.now() - start,
      before,
      after,
      journalReads: after.journalReads - before.journalReads,
      journalBytes: after.journalBytes - before.journalBytes,
      processStarts: after.processStarts - before.processStarts,
    };
    results.performance = await page.evaluate(
      "import('/src/gateway-client.ts').then(({gateway}) => gateway.performance.snapshot())",
    );
    await writeFile(
      path.join(output, 'performance.json'),
      JSON.stringify({ idle: results.idle, performance: results.performance }, null, 2),
    );
    await screenshot('retained-conversation');
    results.reusedIds = reusedIds;
  }
  if (process.env.FARMSLOT_STREAM_PROOF_HOME === '1') {
    const homeOutput = path.join(output, 'copilot-home');
    const child = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./copilot-conversation-home.mts', import.meta.url)),
        path.join(output, 'connection.json'),
        homeOutput,
      ],
      { cwd: repo, env: process.env, timeout: 300000, maxBuffer: 1024 * 1024 },
    );
    await writeFile(path.join(output, 'copilot-home.log'), child.stdout + child.stderr);
    const home = JSON.parse(fs.readFileSync(path.join(homeOutput, 'result.json'), 'utf8')) as {
      pass: boolean;
    };
    assert(home.pass);
    results.copilotHome = home;
  }
  if (process.env.FARMSLOT_STREAM_PROOF_HOLD === '1') {
    await writeFile(path.join(output, 'holding.json'), JSON.stringify({ root, reusedIds }));
    await until(
      () => fs.existsSync(path.join(root, 'stop-proof')),
      'owned proof close request',
      30 * 60_000,
    );
  }
  results.performance ??= await page.evaluate(
    "import('/src/gateway-client.ts').then(({gateway}) => gateway.performance.snapshot())",
  );
  assert.equal(
    proofs.filter((proof) => proof.error).length,
    0,
    'Runner proof failure, see progress.json',
  );
  results.pass = true;
} catch (error) {
  results.pass = false;
  results.error = String(error);
  if (page) await screenshot('failure');
  throw error;
} finally {
  stopEvents();
  for (const session of sessions) {
    if (session.workerManaged) {
      assert(session.workerLeaseId);
      await privateNative.closeWorker(owner.id, {
        sessionId: session.id,
        generation: session.generation,
        leaseId: session.workerLeaseId,
      });
    } else
      await connection.call('native.session.close', {
        sessionId: session.id,
        executionNodeId: 'local',
      });
  }
  results.closed = sessions.map((session) => session.id);
  if (tabId) await fetch(cdp + '/json/close/' + tabId);
  page?.close();
  await vite?.close();
  const { getAllRuns } = await import('../../../services/gateway/src/runs/store.js');
  const { workspaceTerminalOperation } =
    await import('../../../services/gateway/src/runtime/workspace-terminal.js');
  for (const run of getAllRuns())
    if (run.reviewWorkspace) await workspaceTerminalOperation(run, 'stop');
  connection.close();
  resetServerGlobalsForTests();
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const lock = path.join(root, 'native/lock/owner.json');
  if (fs.existsSync(lock)) {
    const supervisor = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number };
    const argv = execFileSync('ps', ['-p', String(supervisor.pid), '-o', 'command='], {
      encoding: 'utf8',
    });
    assert(argv.includes(path.join(root, 'native')));
    const host = JSON.parse(fs.readFileSync(path.join(root, 'native/worker.json'), 'utf8')) as {
      pid: number;
    };
    const gone = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
        throw error;
      }
    };
    process.kill(supervisor.pid, 'SIGTERM');
    await until(
      () =>
        !fs.existsSync(path.join(root, 'native/lock')) && gone(supervisor.pid) && gone(host.pid),
      'private host cleanup',
    );
  }
  results.hostStopped = !fs.existsSync(lock);
  await writeFile(path.join(output, 'result.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(
    JSON.stringify({
      pass: results.pass,
      root,
      proofs: proofs.map(({ runner, error, textBeforeCompletion, visibleBeforeCompletion }) => ({
        runner,
        error,
        textBeforeCompletion,
        visibleBeforeCompletion,
      })),
      hostStopped: results.hostStopped,
    }),
  );
}
