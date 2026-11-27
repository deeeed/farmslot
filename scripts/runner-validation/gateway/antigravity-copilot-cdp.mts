/**
 * Isolated Command Center CDP + Antigravity Copilot + Dispatch Picker + Companion
 * capability proof. Starts its own private gateway, Vite dev server, and isolated
 * Chrome instance (never touches shared gateway 7777 or shared Chrome 9323).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  NativeSessionCatalogResult,
  NativeSessionInfo,
  NativeSessionReadResult,
  RunnerModelCatalogResult,
} from '@farmslot/protocol';
import {
  catalogForNativeRunners,
  nativeLaunchModel,
  nativeLaunchModelSelection,
  ReviewDispatchViewModel,
} from '@farmslot/review-dispatch';

import { CdpWebPage } from '../../../packages/recipe-runner/src/runtime/cdp.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.resolve(process.argv[2] ?? '/tmp/antigravity-copilot-cdp-proof');
const root = await mkdtemp(path.join(tmpdir(), 'antigravity-copilot-proof-'));
await mkdir(output, { recursive: true });

for (const directory of [
  'scripts',
  'services/gateway',
  'pool',
  'projects/agy-copilot',
  'workspace',
]) {
  await mkdir(path.join(root, directory), { recursive: true });
}
const workspace = path.join(root, 'workspace');
const git = (...args: string[]) =>
  execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
await writeFile(path.join(workspace, 'README.md'), '# Isolated Antigravity Copilot Proof\n');
git('add', '.');
git(
  '-c',
  'user.name=Proof',
  '-c',
  'user.email=proof@localhost',
  '-c',
  'commit.gpgsign=false',
  'commit',
  '-qm',
  'seed copilot workspace',
);

const slotId = 'macwork-agy-copilot-1';
const project = 'agy-copilot';
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated Antigravity Copilot proof\n');
await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'projects', project, 'project.json'),
  JSON.stringify({ name: project, hooks: {}, review: { enabled: false } }),
);
await writeFile(
  path.join(root, 'pool/macwork.json'),
  JSON.stringify({
    machine: 'macwork',
    project,
    host: 'localhost',
    ssh_user: process.env.USER || 'operator',
    os: process.platform,
    platform: 'cli',
    slots: [{ id: slotId, enabled: true, mode: 'dispatch', repo: workspace, session: slotId }],
  }),
);
await writeFile(
  path.join(root, 'status.json'),
  JSON.stringify({
    checkedAt: new Date().toISOString(),
    slots: [
      {
        slot: slotId,
        machine: 'macwork',
        project,
        platform: 'cli',
        lifecycle: 'ready',
        slot_epoch: 1,
        current_run_id: null,
      },
    ],
    summary: {
      total: 1,
      ready: 1,
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
  FARMSLOT_OPERATOR_CHECKOUT: workspace,
});

const { createGatewayAuthRuntime } = await import('../../../services/gateway/src/security/auth.js');
const { createWebSocketServer, initServerGlobals, resetServerGlobalsForTests } =
  await import('../../../services/gateway/src/server.js');
const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.js');
const { NativeSessionClient } =
  await import('../../../packages/agent-runtime/src/native/client.js');
const { createServer: createVite } = await import('vite');

const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME });
const roles = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
const owner = auth.writer.createPrincipal(
  { type: 'service', displayName: 'Proof executor' },
  roles,
  'proof-executor',
);
const person = auth.writer.createPrincipal(
  { type: 'person', displayName: 'Proof operator' },
  roles,
  'proof-operator',
);
const credential = auth.writer.issueCredential(person.id, 'Proof browser');
const grant = await auth.writer.exchangePersonCredential(credential.secret, {
  deviceName: 'Antigravity CDP proof',
  deviceKind: 'cli',
});
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;

// Finding 7: Register native-host supervisor cleanup before warming.
const nativeStateDir = path.join(root, 'native');
const killSupervisorSync = () => {
  const lock = path.join(nativeStateDir, 'lock/owner.json');
  if (fs.existsSync(lock)) {
    try {
      const supervisor = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number };
      process.kill(supervisor.pid, 'SIGTERM');
    } catch {
      // Best-effort process kill on signal/exit
    }
  }
};
process.on('SIGINT', killSupervisorSync);
process.on('SIGTERM', killSupervisorSync);
process.on('exit', killSupervisorSync);

const until = async <T,>(
  check: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 150_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (predicate(value)) return value;
    assert(Date.now() < deadline, `Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

const vitePort = Number(process.env.FARMSLOT_PROOF_VITE_PORT ?? 5193);
const cdpPort = Number(process.env.FARMSLOT_PROOF_CDP_PORT ?? 19229);
cdpBase = `http://127.0.0.1:${cdpPort}`;
const chromeProfileDir = path.join(root, 'chrome-profile');
await mkdir(chromeProfileDir, { recursive: true });

const findInShadow = (selector: string) => `(() => {
  const find = (root) => {
    const match = root.querySelector(${JSON.stringify(selector)});
    if (match) return match;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const nested = find(el.shadowRoot);
        if (nested) return nested;
      }
    }
    return null;
  };
  return find(document);
})()`;

try {
  await new NativeSessionClient(nativeStateDir).warm();

  server = createServer();
  wss = createWebSocketServer(server, auth);
  initServerGlobals();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const gatewayPort = address.port;
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/ws`;

  conn = await new GatewayClient({
    url: gatewayUrl,
    credential: { token: grant.accessToken },
    timeout: 60_000,
  }).connect();
  // Warm Antigravity node model catalog before opening UI
  const modelCatalog = await conn.call<RunnerModelCatalogResult>('runner.modelCatalog', {
    runner: 'antigravity',
  });
  assert.equal(modelCatalog.status, 'ready');
  const nonDefaultModel = 'gemini-3.8-flash-low';
  const expectedLabel = 'Gemini 3.8 Flash (Low)';
  assert(modelCatalog.models.some((m) => m.id === nonDefaultModel && m.label === expectedLabel));

  // Verify Companion flow against live server-declared native.session.catalog
  const liveNativeCatalog = await conn.call<NativeSessionCatalogResult>(
    'native.session.catalog',
    {},
  );
  const agyNative = liveNativeCatalog.runners.find((r) => r.runner === 'antigravity');
  assert(agyNative, 'antigravity must be advertised by native.session.catalog');
  assert.equal(agyNative.nativeOnly, true);
  assert.deepEqual(agyNative.modes, ['default', 'plan']);
  assert.equal(agyNative.modelLabels?.[nonDefaultModel], expectedLabel);
  const companionCatalog = catalogForNativeRunners(liveNativeCatalog.runners, undefined, 'local');
  const companionAgy = companionCatalog.runners.find((r) => r.id === 'antigravity');
  assert(companionAgy);
  assert(companionAgy.models.some((m) => m.id === nonDefaultModel && m.label === expectedLabel));
  assert.deepEqual(companionAgy.efforts, []);
  assert.equal(nativeLaunchModelSelection(companionAgy, nonDefaultModel), nonDefaultModel);
  assert.equal(nativeLaunchModel(companionAgy, nonDefaultModel), nonDefaultModel);
  const companionVm = new ReviewDispatchViewModel({
    context: { allowedActions: ['chat'] },
    catalog: companionCatalog,
    sequence: [{ runner: 'antigravity', model: nonDefaultModel, effort: null, mode: 'cold' }],
  });
  assert.equal(companionVm.selection?.runner, 'antigravity');
  assert.equal(companionVm.selection?.model, nonDefaultModel);
  assert.deepEqual(companionVm.effortChoices(companionVm.rows[0].id), [
    { value: null, label: 'Supported default' },
  ]);
  checks.companionCatalogFlow = {
    runner: 'antigravity',
    model: nonDefaultModel,
    label: expectedLabel,
    modes: agyNative.modes,
    effortControlAbsent: true,
  };

  // Start isolated Vite serving Command Center UI
  vite = await createVite({
    configFile: path.join(repo, 'apps/command-center/ui/vite.config.ts'),
    envDir: path.join(root, 'no-env'),
    cacheDir: path.join(root, 'vite-cache'),
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: vitePort,
      strictPort: true,
      fs: { allow: [repo, fs.realpathSync(path.join(repo, 'node_modules'))] },
      proxy: {
        '/ws': { target: `http://127.0.0.1:${gatewayPort}`, ws: true },
        '/api': { target: `http://127.0.0.1:${gatewayPort}` },
      },
    },
  });
  await vite.listen();

  // Launch isolated headless Chrome on private CDP port
  const chromeBinary =
    process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  chromeProc = spawn(
    chromeBinary,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${chromeProfileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,960',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  await until(
    async () => {
      try {
        const res = await fetch(`${cdpBase}/json/version`);
        return res.ok;
      } catch {
        return false;
      }
    },
    Boolean,
    'isolated Chrome CDP ready',
    20_000,
  );

  const target = (await (
    await fetch(`${cdpBase}/json/new?${encodeURIComponent(`http://127.0.0.1:${vitePort}/`)}`, {
      method: 'PUT',
    })
  ).json()) as { id: string; webSocketDebuggerUrl: string };
  tabId = target.id;
  page = await CdpWebPage.connectToTarget({
    id: target.id,
    type: 'page',
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
  });
  await page.session.call('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const browserErrors: unknown[] = [];
  page.session.on('Runtime.exceptionThrown', (event) => browserErrors.push(event.exceptionDetails));

  const screenshot = async (name: string) => {
    assert(page);
    const shot = await page.session.call<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
    });
    await writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };

  // Sign in to Command Center
  await page.waitForSelector('.auth-input', { timeoutMs: 30_000 });
  await page.setInput('.auth-input', credential.secret);
  await page.click('.auth-submit');
  await page.waitForSelector('[data-testid=copilot-target]', { timeoutMs: 30_000 });
  if (
    await page.evaluate("[...document.querySelectorAll('whats-new-modal')].some(view => view.open)")
  ) {
    await page.clickText('Got it');
  }

  // ─── AC1 + AC4 (Command Center Dispatch Wizard): select antigravity + non-default model + verify disabled controls ───
  await page.session.call('Page.navigate', {
    url: `http://127.0.0.1:${vitePort}/#dispatch`,
  });
  await page.waitForSelector('[data-testid=dispatch-execution-options]', { timeoutMs: 30_000 });
  await page.waitForSelector('[data-testid=review-dispatch-runner-antigravity]', {
    timeoutMs: 30_000,
  });
  await page.click('[data-testid=review-dispatch-runner-antigravity]');

  // Wait for model catalog buttons with display names to appear
  const modelButtonSelector = `[data-testid="review-dispatch-model-${nonDefaultModel}"]`;
  await page.waitForSelector(modelButtonSelector, { timeoutMs: 30_000 });
  const modelButtonText = await page.evaluate<string>(
    `(${findInShadow(modelButtonSelector)})?.textContent?.trim() ?? ''`,
  );
  assert(
    modelButtonText.includes(expectedLabel),
    `Expected model picker display name "${expectedLabel}", got "${modelButtonText}"`,
  );
  await page.click(modelButtonSelector);

  // Verify unsupported controls are disabled/absent in Dispatch Wizard
  const dispatchControlState = await page.evaluate<{
    summary: string;
    tmuxDisabled: boolean;
    nativePressed: string | null;
    effortAllDisabledOrAbsent: boolean;
  }>(`(() => {
    const summary = ${findInShadow('[data-testid=dispatch-execution-summary]')}?.textContent?.trim() ?? '';
    const tmux = ${findInShadow('[data-testid=dispatch-transport] button[data-transport="tmux"]')};
    const nativeBtn = ${findInShadow('[data-testid=dispatch-transport] button[data-transport="native"]')};
    const effort = ${findInShadow('[data-testid=review-dispatch-effort]')};
    const effortButtons = effort ? [...effort.querySelectorAll('button')] : [];
    return {
      summary,
      tmuxDisabled: Boolean(tmux?.disabled),
      nativePressed: nativeBtn?.getAttribute('aria-pressed') ?? null,
      effortAllDisabledOrAbsent: effortButtons.every((b) => b.disabled),
    };
  })()`);
  assert(dispatchControlState.summary.includes('antigravity'));
  assert(dispatchControlState.summary.includes(nonDefaultModel));
  assert.equal(
    dispatchControlState.tmuxDisabled,
    true,
    'Terminal transport must be disabled for native-only Antigravity',
  );
  assert.equal(
    dispatchControlState.nativePressed,
    'true',
    'Conversation transport must be auto-selected for Antigravity',
  );
  assert.equal(
    dispatchControlState.effortAllDisabledOrAbsent,
    true,
    'Effort control must be disabled or absent for Antigravity',
  );
  await screenshot('dispatch-antigravity-selected');
  checks.dispatchWizardCdp = {
    modelButtonText,
    ...dispatchControlState,
  };

  // ─── AC3 + AC4 (Command Center Antigravity Copilot): launch via UI in selected workspace, confirm model, stream, permissions, stop, resume ───
  await page.session.call('Page.navigate', {
    url: `http://127.0.0.1:${vitePort}/#native`,
  });
  await page.waitForSelector('[data-testid=native-prompt]', { timeoutMs: 30_000 });
  await page.waitForSelector('[data-testid=review-dispatch-runner-antigravity]', {
    timeoutMs: 30_000,
  });
  await page.click('[data-testid=review-dispatch-runner-antigravity]');
  await page.waitForSelector(modelButtonSelector, { timeoutMs: 30_000 });
  const copilotModelLabel = await page.evaluate<string>(
    `(${findInShadow(modelButtonSelector)})?.textContent?.trim() ?? ''`,
  );
  assert(
    copilotModelLabel.includes(expectedLabel),
    `Expected Copilot model display name "${expectedLabel}", got "${copilotModelLabel}"`,
  );
  await page.click(modelButtonSelector);
  const copilotEffortDisabledOrAbsent = await page.evaluate<boolean>(
    `(() => { const grp = ${findInShadow('[data-testid=review-dispatch-effort]')}; return grp ? [...grp.querySelectorAll('button')].every((b) => b.disabled) : true; })()`,
  );
  assert.equal(
    copilotEffortDisabledOrAbsent,
    true,
    'Effort control must be disabled or absent in Copilot launcher for Antigravity',
  );

  // Select workspace context via the real UI choice-picker if not already pointing at workspace
  const currentCwd = await page.evaluate<string>(
    `(${findInShadow('native-session-view')})?.cwd ?? ''`,
  );
  if (currentCwd !== workspace) {
    await page.click('[data-testid=native-context]');
    await page.waitForSelector(`button[data-choice-label*="${slotId}"]`, { timeoutMs: 15_000 });
    await page.click(`button[data-choice-label*="${slotId}"]`);
    await page.waitForExpression(
      `(${findInShadow('native-session-view')})?.cwd === ${JSON.stringify(workspace)}`,
      { timeoutMs: 15_000 },
    );
  }

  // Launch Antigravity Copilot with first streaming prompt via real UI input + button
  const firstPrompt =
    'List the first 25 prime numbers, one per line, with no commentary and no tool calls.';
  await page.setInput('[data-testid=native-prompt]', firstPrompt);
  await page.waitForExpression(
    `(() => { const btn = ${findInShadow('[data-testid=native-create]')}; return Boolean(btn && !btn.disabled); })()`,
    { timeoutMs: 30_000 },
  );
  await page.click('[data-testid=native-create]');

  // Wait for the created Antigravity session to finish starting in gateway
  const session = await until(
    async () => {
      const listed = await conn.call<{ sessions: NativeSessionInfo[] }>('native.session.list', {});
      return listed.sessions.find((s) => s.runner === 'antigravity' && s.state !== 'starting');
    },
    (s): s is NativeSessionInfo => Boolean(s),
    'UI-launched Antigravity Copilot session ready',
    60_000,
  );
  sessionsToClose.push(session.id);
  const selection = { sessionId: session.id, executionNodeId: 'local' };
  const read = () =>
    conn.call<NativeSessionReadResult>('native.session.read', { ...selection, limit: 500 });

  assert.equal(session.runner, 'antigravity');
  assert.equal(session.model, nonDefaultModel);
  assert.equal(session.cwd, workspace);
  assert.deepEqual(session.capabilities.modes, ['default', 'plan']);
  assert.deepEqual(session.capabilities.approvalModes, ['ask', 'bypass']);
  assert.equal(session.capabilities.approvals, true);
  assert.equal(session.capabilities.interrupt, true);
  assert.equal(session.capabilities.resume, true);
  assert.equal(session.capabilities.questions, false);
  assert.equal(session.capabilities.steer ?? false, false);
  assert.equal(session.capabilities.contextCompaction, false);

  const initialReceipt = await until(
    () => read(),
    (snap) => snap.events.some((e) => e.type === 'session.started'),
    'Copilot session.started event',
    30_000,
  );
  assert.equal(
    initialReceipt.events.find((e) => e.type === 'session.started')?.data?.model,
    nonDefaultModel,
    'Copilot session.started must confirm selected non-default model',
  );

  await page.waitForSelector('[data-testid=native-message]', { timeoutMs: 30_000 });
  await page.waitForExpression(
    `(${findInShadow('native-session-view')})?.historyObservation?.status === 'ready'`,
    { timeoutMs: 30_000 },
  );

  const sendViaUi = async (text: string) => {
    const before = (await read()).cursor;
    await page!.waitForExpression(
      `(() => { const el = ${findInShadow('[data-testid=native-message]')}; return Boolean(el && !el.disabled); })()`,
      { timeoutMs: 30_000 },
    );
    await page.setInput('[data-testid=native-message]', text);
    await page!.waitForExpression(
      `(() => { const btn = ${findInShadow('[data-testid=native-send]')}; return Boolean(btn && !btn.disabled); })()`,
      { timeoutMs: 15_000 },
    );
    await page.click('[data-testid=native-send]');
    await until(
      async () =>
        (await read()).events.some(
          (e) => e.sequence > before && e.type === 'command.submitted' && e.text === text,
        ),
      Boolean,
      'UI command.submitted receipt',
      30_000,
    );
    return before;
  };

  // 1) Observe streaming real response from the UI-launched turn
  let after = 0;
  let streamedBeforeComplete = false;
  let visibleBeforeComplete = false;
  await until(
    async () => {
      const snap = await read();
      const done = snap.events.some((e) => e.sequence > after && e.type === 'turn.completed');
      const hasDelta = snap.events.some((e) => e.sequence > after && e.type === 'text.delta');
      if (hasDelta && !done) streamedBeforeComplete = true;
      if (hasDelta && !done) {
        const visible = await page!.evaluate<boolean>(
          `(() => { const v = ${findInShadow('native-session-view')}; return Boolean(v?.shadowRoot?.textContent?.includes('2') && v?.historyObservation?.data?.events?.some(e => e.type === 'text.delta')); })()`,
        );
        if (visible) visibleBeforeComplete = true;
      }
      return done;
    },
    Boolean,
    'streaming response completion',
  );
  const streamReceipt = await read();
  assert(
    streamReceipt.events.some(
      (e) => e.sequence > after && e.type === 'turn.completed' && e.status === 'completed',
    ),
  );
  assert(
    streamReceipt.events.some((e) => e.sequence > after && e.type === 'text.delta'),
    'Copilot must emit streamed text.delta events',
  );
  await screenshot('copilot-streamed');

  // 2) Ask + Approve permission decision
  const allowedPath = path.join(workspace, 'copilot-allowed.txt');
  after = await sendViaUi(
    `Create the file ${allowedPath} with exact contents COPILOT_APPROVE_OK followed by a newline. Use no other tools and do not retry if denied.`,
  );
  await until(
    async () => (await read()).pendingRequests.length > 0,
    Boolean,
    'Ask approve request',
  );
  await page.waitForSelector('[data-testid=native-approve]', { timeoutMs: 30_000 });
  await screenshot('copilot-ask-approve');
  await page.click('[data-testid=native-approve]');
  await until(
    async () =>
      (await read()).events.some((e) => e.sequence > after && e.type === 'turn.completed'),
    Boolean,
    'Ask approve completion',
  );
  assert.equal((await readFile(allowedPath, 'utf8')).trim(), 'COPILOT_APPROVE_OK');

  // 3) Ask + Deny permission decision
  const deniedPath = path.join(workspace, 'copilot-denied.txt');
  after = await sendViaUi(
    `Create the file ${deniedPath} containing DENIED_TEST. I will deny permission; after denial stop immediately and reply DENIED without retrying.`,
  );
  await until(async () => (await read()).pendingRequests.length > 0, Boolean, 'Ask deny request');
  await page.waitForSelector('[data-testid=native-deny]', { timeoutMs: 30_000 });
  await page.click('[data-testid=native-deny]');
  await until(
    async () =>
      (await read()).events.some((e) => e.sequence > after && e.type === 'turn.completed'),
    Boolean,
    'Ask deny completion',
  );
  await assert.rejects(readFile(deniedPath), { code: 'ENOENT' });
  const denyReceipt = await read();
  assert(
    denyReceipt.events.some(
      (e) =>
        e.sequence > after && e.type === 'approval.resolved' && e.response?.decision === 'deny',
    ),
  );

  // 4) Switch to Bypass via real UI control -> audited automatic approval without prompting, then return to Ask via UI
  const setApprovalModeViaUi = async (mode: 'ask' | 'bypass') => {
    await until(
      async () => (await read()).session.state === 'idle',
      Boolean,
      `idle before switching approval mode to ${mode}`,
      30_000,
    );
    await page!.waitForExpression(
      `(() => { const p = ${findInShadow('[data-testid=native-approval-mode]')}; return Boolean(p && !p.disabled); })()`,
      { timeoutMs: 15_000 },
    );
    await page!.click('[data-testid=native-approval-mode]');
    await page!.waitForSelector(`button[data-choice-value="${mode}"]`, { timeoutMs: 15_000 });
    await page!.click(`button[data-choice-value="${mode}"]`);
    await until(
      async () => (await read()).session.approvalMode === mode,
      Boolean,
      `approval mode switched to ${mode}`,
      15_000,
    );
  };

  await setApprovalModeViaUi('bypass');
  const bypassPath = path.join(workspace, 'copilot-bypass.txt');
  after = await sendViaUi(
    `Create the file ${bypassPath} with exact contents COPILOT_BYPASS_OK followed by a newline. Do not use other tools.`,
  );
  await until(
    async () =>
      (await read()).events.some((e) => e.sequence > after && e.type === 'turn.completed'),
    Boolean,
    'Bypass completion',
  );
  const bypassReceipt = await read();
  const bypassTurn = bypassReceipt.events.filter((e) => e.sequence > after);
  assert.equal(
    bypassTurn.some((e) => e.type === 'approval.requested'),
    false,
  );
  assert(
    bypassTurn.some(
      (e) =>
        e.type === 'approval.resolved' &&
        e.data?.automatic === true &&
        e.data?.approvalMode === 'bypass',
    ),
  );
  assert.equal((await readFile(bypassPath, 'utf8')).trim(), 'COPILOT_BYPASS_OK');
  await setApprovalModeViaUi('ask');

  // 5) Cancel / stop active turn via UI Stop button (and confirm unsupported Steer button is absent)
  after = await sendViaUi(
    'Write a comprehensive 3000-word treatise on compiler optimization passes with full examples. Do not use any tools.',
  );
  await until(
    async () => (await read()).events.some((e) => e.sequence > after && e.type === 'text.delta'),
    Boolean,
    'active turn streaming before stop',
  );
  await page.waitForSelector('[data-testid=native-stop]', { timeoutMs: 30_000 });
  const steerVisibleDuringTurn = await page.evaluate<boolean>(
    `Boolean(${findInShadow('[data-testid=native-steer]')})`,
  );
  assert.equal(
    steerVisibleDuringTurn,
    false,
    'Unsupported steer control must be absent for Antigravity',
  );
  await page.click('[data-testid=native-stop]');
  await until(
    async () =>
      (await read()).events.some((e) => e.sequence > after && e.type === 'turn.completed'),
    Boolean,
    'stopped turn completion',
  );
  const stopReceipt = await read();
  assert(
    stopReceipt.events.some(
      (e) => e.sequence > after && e.type === 'turn.completed' && e.status === 'interrupted',
    ),
    'Stopped turn must record status=interrupted',
  );
  await screenshot('copilot-stopped');

  // 6) Close & Same-session Resume via UI Resume button with retained context
  const priorGeneration = stopReceipt.session.generation;
  const priorNativeId = stopReceipt.session.nativeSessionId;
  await conn.call('native.session.close', selection);
  await page.session.call('Page.navigate', {
    url: `http://127.0.0.1:${vitePort}/#native?${new URLSearchParams(selection)}`,
  });
  await page.waitForSelector('[data-testid=native-resume]', { timeoutMs: 30_000 });
  await page.click('[data-testid=native-resume]');
  await until(
    async () => {
      const snap = await read();
      return snap.session.state === 'idle' && snap.session.generation !== priorGeneration;
    },
    Boolean,
    'resumed Copilot generation',
  );
  const resumedSnap = await read();
  assert.equal(resumedSnap.session.nativeSessionId, priorNativeId);
  assert.equal(resumedSnap.session.model, nonDefaultModel);
  assert.equal(resumedSnap.session.cwd, workspace);

  after = await sendViaUi(
    'What exact text did I ask you to write into copilot-allowed.txt earlier? Reply with that text only, without using tools.',
  );
  await until(
    async () =>
      (await read()).events.some((e) => e.sequence > after && e.type === 'turn.completed'),
    Boolean,
    'resumed turn completion',
  );
  const finalReceipt = await read();
  const resumedReply = finalReceipt.events
    .filter((e) => e.sequence > after && e.type === 'text.delta')
    .map((e) => e.text ?? '')
    .join('');
  assert(
    resumedReply.includes('COPILOT_APPROVE_OK'),
    `Expected retained context COPILOT_APPROVE_OK in resumed reply, got: ${resumedReply}`,
  );
  await screenshot('copilot-resumed');
  await writeFile(path.join(output, 'copilot-receipt.json'), JSON.stringify(finalReceipt, null, 2));

  assert.equal(
    browserErrors.length,
    0,
    `Unexpected browser exceptions: ${JSON.stringify(browserErrors)}`,
  );

  checks.copilotCdp = {
    sessionId: session.id,
    nativeSessionId: priorNativeId,
    confirmedModel: nonDefaultModel,
    workspace,
    streamedBeforeComplete,
    visibleBeforeComplete,
    askApproveVerified: true,
    askDenyVerified: true,
    bypassAuditedWithoutPrompt: true,
    stopInterruptedVerified: true,
    sameSessionResumeRetainedContext: true,
    unsupportedControlsDisabledOrAbsent: {
      questions: session.capabilities.questions === false,
      steer: !session.capabilities.steer,
      contextCompaction: session.capabilities.contextCompaction === false,
    },
  };

  result.pass = true;
} catch (error) {
  result.error = String(error);
  throw error;
} finally {
  for (const id of sessionsToClose) {
    try {
      await conn.call('native.session.close', { sessionId: id, executionNodeId: 'local' });
    } catch {
      // Best-effort cleanup of test-owned session.
    }
  }
  if (tabId) {
    try {
      await fetch(`${cdpBase}/json/close/${tabId}`);
    } catch {
      // Chrome may already be closing.
    }
  }
  page?.close();
  chromeProc?.kill('SIGTERM');
  await vite?.close();
  conn.close();
  resetServerGlobalsForTests();
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const lock = path.join(root, 'native/lock/owner.json');
  if (fs.existsSync(lock)) {
    const supervisor = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number };
    const host = JSON.parse(fs.readFileSync(path.join(root, 'native/worker.json'), 'utf8')) as {
      pid: number;
    };
    const gone = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
        throw err;
      }
    };
    process.kill(supervisor.pid, 'SIGTERM');
    await until(
      async () =>
        !fs.existsSync(path.join(root, 'native/lock')) && gone(supervisor.pid) && gone(host.pid),
      Boolean,
      'private native host cleanup',
      30_000,
    );
  }
  result.hostStopped = !fs.existsSync(lock);
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      { pass: result.pass, hostStopped: result.hostStopped, checks, error: result.error },
      null,
      2,
    ),
  );
}
