// Owned native worker, real private gateway and browser. Never uses the operator gateway.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createServer as createVite } from 'vite';

import { alive, matchesProcess } from '../../../packages/agent-runtime/src/native/storage.ts';
import { taskInit } from '../../../packages/agent-runtime/src/task-init/index.ts';
import { GatewayClient } from '../../../packages/cli/src/gateway-client.ts';
import { createCdpVideoRecorder } from '../../../packages/recipe-runner/src/recording/cdp-video-recorder.ts';
import { CdpSession, CdpWebPage } from '../../../packages/recipe-runner/src/runtime/cdp.ts';
import { testGatewayIdentity } from '../../../scripts/lib/test-gateway-identity.mjs';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const output = process.env.FARMSLOT_NATIVE_SLOT_OUTPUT;
const baseline = process.env.FARMSLOT_NATIVE_SLOT_BASE;
const cdpPort = Number(process.env.FARMSLOT_CDP_PORT);
assert(output && baseline && cdpPort, 'Set owned Agent Chrome port, output and baseline full SHA');
assert(/^[0-9a-f]{40}$/.test(baseline));
mkdirSync(output, { recursive: true, mode: 0o700 });
const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), 'cc-native-slot-')));
const root = path.join(temporary, 'farm');
const workspace = path.join(temporary, 'workspace');
const home = path.join(temporary, 'home');
const nativeRoot = path.join(temporary, 'native');
const slotId = `cc-native-${randomUUID().slice(0, 12)}`;
const project = 'native-slot-proof';
const runner = process.env.FARMSLOT_NATIVE_SLOT_RUNNER ?? 'claude';
const model = process.env.FARMSLOT_NATIVE_SLOT_MODEL ?? 'haiku';
const effort = process.env.FARMSLOT_NATIVE_SLOT_EFFORT;
const save = (name, value) =>
  writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
const json = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};
const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8' });
const until = async (read, accept, label, timeout = 90000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(100);
  }
  throw Error('Timed out: ' + label);
};
const portServer = createServer();
await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
const gatewayPort = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/ws`;
let gateway, vite, connection, page, browser, contextId, recording, runId, secret, failure;
let before = true;
const result = {
  baseline,
  candidate: git('rev-parse', 'HEAD').trim(),
  slotId,
  root: temporary,
  productionServicesChanged: false,
  checks: [],
  runtimeErrors: [],
};
const walk =
  "const walk=r=>[...r.querySelectorAll('*')].flatMap(e=>e.shadowRoot?[e,...walk(e.shadowRoot)]:[e]);const all=walk(document);";
const inspect = () =>
  page.evaluate(`(async()=>{
  const {getState,isFullyHydrated}=await import('/src/state.ts');
  const {gateway}=await import('/src/gateway-client.ts');
  ${walk}
  const v=all.find(e=>e.localName==='native-session-view');
  const t=all.find(e=>e.localName==='terminal-view');
  const slot=document.querySelector('slot-view');
  return {url:location.hash,timeOrigin:performance.timeOrigin,ready:document.readyState,hydrated:isFullyHydrated(getState().hydrated),gateway:gateway.connectionState,runId:slot?._linkedRun?.id,runCurrent:!!slot?._linkedRunCurrent,recovery:slot?._recoveryPhase,native:!!v,session:v?.session?.id,composer:!!v?.shadowRoot.querySelector('[data-testid=native-message]'),host:!!document.querySelector('[data-testid=slot-host-terminal]'),bare:!!t?.bareSession,connected:!!t?._connected,terminalMode:t?._mode,terminalPhase:t?._attachPhase,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}};
})()`);
const reload = async () => {
  const previous = await page.evaluate('performance.timeOrigin');
  await page.session.call('Page.reload', { ignoreCache: true });
  await until(
    inspect,
    (value) =>
      value.timeOrigin !== previous &&
      value.ready === 'complete' &&
      value.hydrated &&
      value.gateway === 'connected' &&
      value.runId === runId &&
      value.runCurrent,
    'new hydrated document and current run',
  );
};
const shot = async (name) => {
  const frame = await page.session.call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(output, name + '.png'), Buffer.from(frame.data, 'base64'));
};
try {
  for (const directory of [
    root,
    workspace,
    path.join(root, 'scripts'),
    path.join(root, 'packages/agent-runtime'),
    path.join(root, 'services/gateway'),
  ])
    mkdirSync(directory, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['init', '-q', '-b', 'main', workspace]);
  writeFileSync(path.join(workspace, 'fixture.txt'), 'Owned native slot proof\n');
  writeFileSync(path.join(workspace, '.gitignore'), '.task/\n.agent/\n');
  execFileSync('git', ['-C', workspace, 'add', 'fixture.txt', '.gitignore']);
  execFileSync('git', [
    '-C',
    workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable native slot proof\n');
  writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
  const { symlinkSync } = await import('node:fs');
  symlinkSync(
    path.join(source, 'packages/agent-runtime/scripts'),
    path.join(root, 'packages/agent-runtime/scripts'),
    'dir',
  );
  json(path.join(root, 'services/gateway/package.json'), {
    name: 'native-slot-proof',
    version: '0.0.0',
  });
  const projectRoot = path.join(root, 'projects', project);
  const taskDir = path.join(projectRoot, 'tasks/dev/PROOF');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    path.join(taskDir, 'TASK.md'),
    '# Native slot validation\n\nRun the task-local mark start command if available, then reply NATIVE-SLOT-READY. Do not edit code or complete the task. Wait for operator messages. Only work inside this disposable repository.\n\n- [ ] Wait for the operator to finish the UI proof\n',
  );
  mkdirSync(path.join(projectRoot, 'templates/worker'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'templates/prompts'), { recursive: true });
  for (const file of ['dev.md', 'dev-interactive.md'])
    writeFileSync(
      path.join(projectRoot, 'templates/worker', file),
      '# Native UI proof\n- [ ] Wait for the operator\n',
    );
  writeFileSync(
    path.join(projectRoot, 'templates/prompts/worker-dispatch.md'),
    'Read {{TASK_FILE}}. Reply NATIVE-SLOT-READY and end this model turn. Do not complete the task, sleep, poll, or ask a question. Continue only on a new operator message.\n',
  );
  const templates = path.join(projectRoot, 'owned-templates');
  mkdirSync(path.join(templates, 'dev'), { recursive: true });
  writeFileSync(
    path.join(templates, 'dev/interactive.cli.md'),
    '---\nplatforms: [cli]\ndescription: Native slot proof\n---\n# Native slot validation\nRead this task, mark start if available, reply NATIVE-SLOT-READY, then end this model turn. Do not sleep, poll, ask a question or run background work. Do not edit code or complete the task. Continue only on a new operator message.\n- [ ] Wait for operator completion\n',
  );
  await taskInit({
    taskDir,
    flow: 'dev',
    domain: 'native-slot-proof',
    runMode: 'interactive',
    platform: 'cli',
    template: {
      sources: [{ id: 'proof', kind: 'package', root: templates, layout: 'flow-tree' }],
      explicitId: 'dev/interactive.cli',
    },
    task: {
      title: 'Native slot UI proof',
      sourceKind: 'text',
      acceptanceCriteria: ['Inspect and answer through the native UI'],
    },
    handoff: { surface: 'owned-proof', project },
  });
  mkdirSync(path.join(home, 'run-archive'), { recursive: true });
  json(path.join(projectRoot, 'project.json'), {
    name: project,
    repo: workspace,
    repo_url: workspace,
    default_branch: 'main',
    execution_templates: {
      sources: [{ id: 'proof', kind: 'workspace', root: { projectPath: 'owned-templates' } }],
      defaults: [
        {
          when: { flow: 'dev', platform: 'cli', runMode: 'interactive' },
          templateId: 'dev/interactive.cli',
        },
      ],
    },
    runtime_dir: '.task',
    task_dir_name: '.task',
    hooks: {},
  });
  json(path.join(root, 'pool', hostname() + '.json'), {
    schema_version: 2,
    machine: hostname(),
    host: 'localhost',
    ssh_user: userInfo().username,
    os: process.platform,
    project,
    platform: 'cli',
    slots: [
      {
        id: slotId,
        project,
        platform: 'cli',
        repo: workspace,
        session: slotId,
        enabled: true,
        mode: 'dispatch',
      },
    ],
  });
  const statusFile = path.join(temporary, 'fixture-status.json');
  json(statusFile, {
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: slotId,
        machine: hostname(),
        project,
        platform: 'cli',
        repo: workspace,
        branch: 'main',
        agent: 'idle',
        enabled: true,
        dispatchable: true,
        warm: false,
        lifecycle: 'ready',
        phase: 'idle',
        current_run_id: null,
        health: { ssh: 'OK', device: '-', devserver: '-', cdp: '-', fixtures: '-' },
      },
    ],
  });
  secret = testGatewayIdentity(home, gatewayUrl);
  execFileSync('tmux', ['new-session', '-d', '-s', slotId, '-c', workspace]);
  const env = {
    ...process.env,
    FARMSLOT_ROOT: source,
    FARMSLOT_GATEWAY: gatewayUrl,
    GW_URL: gatewayUrl,
    FARMSLOT_GATEWAY_PROFILE: 'proof',
    FARMSLOT_HOME: home,
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
    FARMSLOT_NATIVE_STATE_DIR: nativeRoot,
    FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'test-automation',
    FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, '.runs/capabilities.json'),
    FARMSLOT_TEST_STATUS_FILE: statusFile,
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '0',
    NODE_TEST_CONTEXT: '1',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(gatewayPort),
    TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
  };
  const { openSync, closeSync } = await import('node:fs');
  const log = openSync(path.join(output, 'private-gateway.log'), 'w', 0o600);
  gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
    cwd: source,
    env,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  await until(
    async () => {
      assert.equal(gateway.exitCode, null, 'Private gateway exited');
      try {
        return (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).ok;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return false;
      }
    },
    Boolean,
    'private gateway health',
  );
  const baselineRoot = path.join(temporary, 'baseline');
  mkdirSync(baselineRoot);
  const archive = execFileSync('git', ['archive', baseline, 'apps/command-center/ui/src'], {
    cwd: source,
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync('tar', ['-x', '-C', baselineRoot], { input: archive });
  connection = await new GatewayClient({
    url: gatewayUrl,
    credential: { token: secret },
    timeout: 90000,
  }).connect();
  const rpc = (method, params) => connection.call(method, params);
  process.env.FARMSLOT_DEV_UI_HMR = '0';
  vite = await createVite({
    configFile: path.join(source, 'apps/command-center/ui/vite.config.ts'),
    envDir: path.join(temporary, 'no-env'),
    cacheDir: path.join(temporary, 'vite-cache'),
    logLevel: 'error',
    define: { 'import.meta.env.VITE_FARMSLOT_DEV_GATEWAY_PORT': JSON.stringify('') },
    plugins: [
      {
        name: 'native-proof-baseline',
        enforce: 'pre',
        load(id) {
          if (!before || !id.startsWith(path.join(source, 'apps/command-center/ui/src') + path.sep))
            return;
          const file = path.join(baselineRoot, path.relative(source, id.split('?')[0]));
          if (existsSync(file)) return readFileSync(file, 'utf8');
        },
      },
    ],
    server: {
      host: '127.0.0.1',
      port: 5288,
      strictPort: true,
      hmr: false,
      ws: false,
      proxy: {
        '/ws': { target: `http://127.0.0.1:${gatewayPort}`, ws: true },
        '/api': { target: `http://127.0.0.1:${gatewayPort}` },
      },
    },
  });
  await vite.listen();
  const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
  browser = await CdpSession.connect(version.webSocketDebuggerUrl);
  ({ browserContextId: contextId } = await browser.call('Target.createBrowserContext'));
  const url = 'http://127.0.0.1:5288/#fleet';
  const { targetId } = await browser.call('Target.createTarget', {
    url,
    browserContextId: contextId,
  });
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  page = await CdpWebPage.connectToTarget(targets.find((t) => t.id === targetId));
  await page.session.call('Page.bringToFront');
  await page.session.call('Emulation.setDeviceMetricsOverride', {
    width: 1234,
    height: 1050,
    deviceScaleFactor: 0.9,
    mobile: false,
  });
  await page.session.call('Runtime.enable');
  page.session.on('Runtime.exceptionThrown', (event) =>
    result.runtimeErrors.push(event.exceptionDetails),
  );
  await page.waitForSelector('.auth-input', { timeoutMs: 60000 });
  await page.setInput('.auth-input', secret);
  await page.click('.auth-submit');
  await until(
    () => page.evaluate("!!document.querySelector('.fa-main')"),
    Boolean,
    'private authenticated UI',
  );
  const dismissWhatsNew = async () => {
    if (
      await page.evaluate(
        `(()=>{${walk}return all.some(e=>e.tagName==='BUTTON' && e.textContent.trim()==='Got it');})()`,
      )
    )
      await page.clickText('Got it');
  };
  await dismissWhatsNew();
  const created = await rpc('run.createNative', {
    project,
    flowType: 'dev',
    ticketOrPr: 'Native slot UI proof',
    taskFile: path.join(taskDir, 'TASK.md'),
    slotId,
    allowedSlots: [slotId],
    runner,
    model,
    ...(effort ? { effort } : {}),
    mode: 'interactive',
    skipPrepare: true,
    safetyTier: 'full-auto',
  });
  runId = created.run.id;
  const run = await until(
    async () => (await rpc('run.get', { runId })).run,
    (value) => {
      assert(!['failed', 'blocked'].includes(value.status), value.error);
      return value.agentContexts?.some((c) => c.nativeSession?.acceptedAt);
    },
    'owned worker accepted',
    180000,
  );
  const context = run.agentContexts.find((c) => c.nativeSession?.acceptedAt);
  const binding = context.nativeSession;
  const target = {
    sessionId: binding.sessionId,
    executionNodeId: binding.executionNodeId,
    worker: {
      runId,
      contextId: context.id,
      generation: binding.generation,
      leaseId: binding.leaseId,
    },
  };
  const read = () => rpc('native.session.read', { ...target, limit: 500 });
  const ready = await until(
    read,
    (s) => {
      assert.notEqual(s.session.state, 'failed', s.session.error);
      return s.commands.some((c) => c.outcome === 'completed') && s.session.state === 'idle';
    },
    'initial native turn',
    180000,
  );
  save('owned.json', {
    runId,
    contextId: context.id,
    target,
    gatewayPort,
    nativeRoot,
    workspace,
    processPid: ready.session.processPid,
  });
  result.sessionId = binding.sessionId;
  await page.navigate(
    `http://127.0.0.1:5288/#slot/${slotId}?runId=${runId}&contextId=${context.id}&file=fixture.txt`,
  );
  await until(
    inspect,
    (v) => v.native && v.composer && v.session === binding.sessionId,
    'baseline native conversation',
  );
  await dismissWhatsNew();
  recording = await createCdpVideoRecorder({ cdpPort }).start({
    target: { kind: 'cdp-page', host: '127.0.0.1', port: cdpPort, targetId },
    outputPath: path.join(output, 'native-slot.mp4'),
    nodeId: 'native-slot',
    record: 'full_run',
    maxFps: 15,
  });
  await recording.ready?.();
  assert.equal((await inspect()).host, false, 'Baseline unexpectedly already has host button');
  await shot('before-conversation');
  await page.waitForSelector('.tmux-win-btn:not([data-native-context])');
  await page.click('.tmux-win-btn:not([data-native-context])');
  await until(inspect, (v) => v.bare && !v.native, 'baseline bare host');
  assert(!new URLSearchParams((await inspect()).url.split('?')[1]).has('session'));
  await reload();
  await until(inspect, (v) => v.native && v.composer, 'baseline loses host selection on reload');
  await shot('before-reload-lost-host');
  result.checks.push('baseline host choice is transient and absent from top-level controls');
  before = false;
  vite.moduleGraph.invalidateAll();
  await reload();
  await until(
    inspect,
    (v) => v.native && v.host && v.composer,
    'candidate conversation and host controls',
  );
  await shot('after-conversation');
  await page.click('[data-testid=slot-host-terminal]');
  await until(inspect, (v) => v.bare && !v.native, 'candidate independent host target');
  assert.equal(new URLSearchParams((await inspect()).url.split('?')[1]).get('session'), 'host');
  await reload();
  await until(
    inspect,
    (v) =>
      v.bare &&
      !v.native &&
      v.connected &&
      v.hydrated &&
      v.runCurrent &&
      v.runId === runId &&
      v.terminalMode === 'pty' &&
      v.terminalPhase === 'live',
    'host choice restored',
  );
  save('settled-host.json', await inspect());
  await shot('after-host-restored');
  await page.click('slot-view .sv-bottom-tab:first-child');
  await until(
    inspect,
    (v) => v.native && v.composer && v.session === binding.sessionId,
    'return to same conversation',
  );
  const unchanged = await read();
  assert.equal(unchanged.session.generation, ready.session.generation);
  assert.equal(unchanged.session.processPid, ready.session.processPid);
  assert.equal(
    unchanged.commands.length,
    ready.commands.length,
    'Opening views must not send a turn',
  );
  result.checks.push(
    'same native actor survives independent host navigation and reload without sends or relaunch',
  );
  assert(
    ready.session.capabilities.questions,
    'Select a native runner/mode with structured questions',
  );
  await page.clickText('Fullscreen');
  await until(
    () => page.evaluate('!!document.fullscreenElement'),
    Boolean,
    'native conversation fullscreen',
  );
  const native = '';
  await page.setInput(
    native + '[data-testid=native-message]',
    'Use your structured question tool once to ask which validation color to choose, with exactly Amber and Violet. Wait for the structured answer, then reply with the chosen color only. Do not use shell or file tools.',
  );
  await shot('after-visible-typing');
  await page.click(native + '[data-testid=native-send]');
  const waiting = await until(
    read,
    (s) => s.pendingRequests.some((e) => e.type === 'question.requested'),
    'real model structured question',
    180000,
  );
  const request = waiting.pendingRequests.find((e) => e.type === 'question.requested');
  await page.waitForSelector(native + 'label:has(input[type=radio][value=Violet])', {
    timeoutMs: 60000,
  });
  await shot('after-inline-question');
  const queuedText = 'After the preceding answer, reply QUEUED-ACK only. Do not use tools.';
  await until(
    () =>
      page.evaluate(
        `(()=>{${walk}return all.find(e=>e.matches('[data-testid=native-send]'))?.textContent.trim();})()`,
      ),
    (value) => value === 'Queue message',
    'busy native queue button',
  );
  await page.setInput(native + '[data-testid=native-message]', queuedText);
  await page.click(native + '[data-testid=native-send]');
  const queuedPage = await until(
    read,
    (s) => s.commands.some((c) => c.queued && !c.accepted && !c.submitted),
    'durable queued input',
  );
  const queuedReceipt = queuedPage.commands.find((c) => c.queued && !c.accepted && !c.submitted);
  save('queued-receipt.json', queuedReceipt);
  await shot('after-queued-message');

  await page.click(native + 'label:has(input[type=radio][value=Violet])');
  await page.click(native + '.request button[type=submit]');
  const answered = await until(
    read,
    (s) =>
      !s.pendingRequests.length &&
      s.session.state === 'idle' &&
      s.commands.some(
        (c) => c.commandId === queuedReceipt.commandId && c.outcome === 'completed',
      ) &&
      s.events
        .filter((e) => e.type === 'text.delta' && e.sequence > waiting.cursor)
        .map((e) => e.text ?? '')
        .join('')
        .includes('Violet'),
    'structured answer consumed',
    180000,
  );
  await shot('after-question-answer');
  const answerText = answered.events
    .filter((e) => e.type === 'text.delta' && e.sequence > waiting.cursor)
    .map((e) => e.text ?? '')
    .join('');
  assert(answerText.includes('QUEUED-ACK'));
  assert.equal(answered.session.generation, ready.session.generation);
  const cursorBeforeReplay = answered.cursor;
  await rpc('native.session.send', {
    ...target,
    commandId: queuedReceipt.commandId,
    text: queuedText,
  });
  const replayed = await rpc('native.session.read', {
    ...target,
    after: cursorBeforeReplay,
    limit: 200,
  });
  assert(
    !replayed.events.some((e) => e.type === 'command.submitted' || e.type === 'command.accepted'),
    'Replay cannot send a second turn',
  );
  result.checks.push(
    'busy input is durably queued and runs after the answer; same commandId replay does not duplicate it',
  );

  result.checks.push(
    `real ${runner} question rendered inline and answered through native.session.respond`,
  );
  save('question-receipt.json', {
    request: request.request,
    sessionId: binding.sessionId,
    generation: answered.session.generation,
    pending: answered.pendingRequests.length,
    commands: answered.commands.map((c) => ({
      commandId: c.commandId,
      state: c.state,
      outcome: c.outcome,
    })),
  });
  assert.equal(result.runtimeErrors.length, 0);
  result.pass = true;
} catch (error) {
  failure = error;
  result.error = secret ? String(error).replaceAll(secret, '[redacted]') : String(error);
  if (page) {
    try {
      result.browser = await page.evaluate(
        '({title:document.title,url:location.href,state:document.readyState,text:document.body?.innerText.slice(0,1200)})',
      );
      result.connection = await page.evaluate(
        "import('/src/gateway-client.ts').then(({gateway})=>({url:gateway.gatewayUrl,state:gateway.connectionState,authError:gateway.authError?.code}))",
      );
      if (secret && result.browser?.text)
        result.browser.text = result.browser.text.replaceAll(secret, '[redacted]');
      await shot('failure-ui');
    } catch (diagnosticError) {
      result.browserDiagnosticError = String(diagnosticError);
    }
  }
} finally {
  // A cleanup failure must not leave the other owned processes running. Report all of them.
  const cleanupErrors = [];
  const clean = async (action) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  if (recording) await clean(async () => save('recording.json', await recording.stop()));
  if (browser && contextId)
    await clean(() =>
      browser.call('Target.disposeBrowserContext', { browserContextId: contextId }),
    );
  page?.session.close();
  browser?.close();
  await clean(() => {
    const has = spawnSync('tmux', ['has-session', '-t', slotId]);
    if (has.status === 0) execFileSync('tmux', ['kill-session', '-t', slotId]);
    else assert.equal(has.status, 1, 'Unable to inspect owned tmux session during cleanup');
  });
  if (connection && runId) await clean(() => connection.call('run.cancel', { runId }));
  connection?.close();
  if (vite) await clean(() => vite.close());
  if (gateway && gateway.exitCode === null) gateway.kill('SIGTERM');
  await clean(() => {
    const hostFile = path.join(nativeRoot, 'host.json');
    if (existsSync(hostFile)) {
      const host = JSON.parse(readFileSync(hostFile, 'utf8'));
      if (alive(host.pid)) {
        assert(matchesProcess(host.pid, nativeRoot), 'Refuse to stop a reused host PID');
        process.kill(host.pid, 'SIGTERM');
      }
    }
  });
  if (cleanupErrors.length) {
    result.cleanupErrors = cleanupErrors.map((error) =>
      secret ? String(error).replaceAll(secret, '[redacted]') : String(error),
    );
    failure ??= new AggregateError(cleanupErrors, 'Owned fixture cleanup failed');
    result.error ??= String(failure);
    result.pass = false;
  }
  save('result.json', result);
}
if (failure) throw Error(result.error);
console.log(
  JSON.stringify({ pass: result.pass, checks: result.checks, sessionId: result.sessionId }),
);
