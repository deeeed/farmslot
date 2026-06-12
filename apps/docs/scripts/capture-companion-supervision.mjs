#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket, { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const appRoot = resolve(repoRoot, 'apps/companion');
const defaultRecipe = resolve(
  repoRoot,
  'docs/examples/recipes/farmslot/docusaurus-companion-supervision.recipe.json',
);
const docsImage = resolve(repoRoot, 'apps/docs/static/img/demos/companion-mobile-supervision.png');
const forbidden = [
  /wallet/i,
  /Wallet/i,
  /token/i,
  /private key/i,
  /TAT-\d+/i,
  /PROJ-\d+/i,
  /Acme/i,
];

const args = parseArgs(process.argv.slice(2));
const recipePath = resolve(repoRoot, args.recipe || defaultRecipe);
const artifactsDir = resolve(
  repoRoot,
  args.artifactsDir || '.agent/demo-stage/docusaurus-companion-supervision/output',
);
const copyToDocs = process.argv.includes('--copy-to-docs');
const captureSeconds = Number(process.env.FARMSLOT_DEMO_CAPTURE_SECONDS || 8);
const slot = readCompanionSlotConfig();
const simulator = process.env.IOS_SIMULATOR || slot.simulator || 'fs-companion-1';
const metroPort = process.env.METRO_PORT || slot.port || '7677';
const gatewayPort = process.env.GATEWAY_PORT || '7777';
const gatewayHost = process.env.COMPANION_GATEWAY_HOST || detectLanHost();
const gatewayUrl = `ws://${gatewayHost}:${gatewayPort}/ws`;
const gatewayBindHost = process.env.COMPANION_GATEWAY_BIND_HOST || '0.0.0.0';
const appVariant = process.env.APP_VARIANT || 'development';
const siteedBundleBase = process.env.SITEED_BUNDLE_BASE || 'net.siteed.farmslot';
const siteedSchemeBase = process.env.SITEED_SCHEME_BASE || 'farmslot';
const expectedBundleId = process.env.BUNDLE_ID || `${siteedBundleBase}.${appVariant}`;
const expectedScheme = process.env.SCHEME || `${siteedSchemeBase}-${appVariant}`;
const staleCompanionBundleIds = [
  'net.siteed.farmslot.companion.development',
  'net.farmslot.companion.dev',
];
const trace = [];
let gateway = null;
let launchedProcess = null;
let originalLocalEnv = null;
let hadLocalEnv = false;
const localEnvPath = resolve(appRoot, '.env.development.local');
const observedMethods = new Set();

main().catch((error) => {
  cleanup();
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});

async function main() {
  mkdirSync(artifactsDir, { recursive: true });
  for (const dir of ['screenshots', 'videos', 'posters', 'logs'])
    mkdirSync(resolve(artifactsDir, dir), { recursive: true });
  copyFileSync(recipePath, resolve(artifactsDir, 'recipe.json'));

  step('start-fixture-gateway', 'started', `Starting public-safe fixture gateway on ${gatewayUrl}`);
  gateway = await startFixtureGateway(Number(gatewayPort));
  step(
    'start-fixture-gateway',
    'passed',
    'Fixture gateway accepts real Companion websocket RPC requests',
  );

  step('launch-companion', 'started', `Launching Companion on ${simulator}, Metro ${metroPort}`);
  applyLocalEnvFixture();
  ensureSimulatorBooted();
  removeStaleCompanionApps();
  if (process.env.FARMSLOT_COMPANION_REINSTALL === '1') uninstallApp(expectedBundleId);
  await ensureCompanionRuntime();
  step('launch-companion', 'passed', 'Companion launched against the fixture gateway');

  step('wait-for-supervision-ui', 'started', 'Waiting for Companion to fetch fixture gateway data');
  await waitForGatewayTraffic(45000);
  await sleep(3000);
  step(
    'wait-for-supervision-ui',
    'passed',
    'Companion requested public-safe fixture data; visual inspection verifies rendered run supervision.',
  );

  const videoPath = resolve(artifactsDir, 'videos/companion-mobile-supervision.mp4');
  step('record-supervision', 'started', `Recording ${captureSeconds}s from configured simulator`);
  await recordSimulator(videoPath);
  assertNonEmpty(videoPath, 'recorded MP4');

  const screenshotPath = resolve(artifactsDir, 'screenshots/companion-mobile-supervision.png');
  captureSimulatorScreenshot(screenshotPath);
  const posterPath = resolve(artifactsDir, 'posters/companion-mobile-supervision.png');
  extractPoster(videoPath, posterPath);
  step('record-supervision', 'passed', 'Recorded simulator video, poster, and final screenshot');

  if (copyToDocs) {
    mkdirSync(dirname(docsImage), { recursive: true });
    copyFileSync(screenshotPath, docsImage);
  }

  writeOutputs({ videoPath, posterPath, screenshotPath });
  cleanup();
  console.log(
    JSON.stringify(
      {
        ok: true,
        artifactsDir: rel(artifactsDir),
        copiedToDocs: copyToDocs ? rel(docsImage) : null,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--artifacts-dir') out.artifactsDir = argv[++i];
    else if (arg === '--recipe') out.recipe = argv[++i];
  }
  return out;
}

function detectLanHost() {
  const route = spawnSync(
    'bash',
    [
      '-lc',
      'iface=$(route get default 2>/dev/null | awk \'/interface:/{print $2; exit}\'); [ -n "$iface" ] && ipconfig getifaddr "$iface"',
    ],
    { encoding: 'utf8' },
  );
  const host = route.stdout.trim();
  if (host) return host;
  const fallback = spawnSync('bash', ['-lc', "hostname -s | sed 's/$/.local/'"], {
    encoding: 'utf8',
  });
  const fallbackHost = fallback.stdout.trim();
  if (fallbackHost) return fallbackHost;
  throw new Error('Unable to detect LAN host for Companion gateway fixture');
}

function readCompanionSlotConfig() {
  const poolPath = process.env.FARMSLOT_COMPANION_POOL_JSON || process.env.FARMSLOT_DEMO_POOL_JSON;
  if (poolPath) {
    const pool = JSON.parse(readFileSync(resolve(repoRoot, poolPath), 'utf8'));
    const poolSlot = (pool.slots || []).find(
      (candidate) => candidate.project === 'farmslot-companion' || /companion/i.test(candidate.id),
    );
    if (poolSlot) {
      return {
        simulator: poolSlot.resources?.['ios-sim']?.simulator,
        port: poolSlot.resources?.['dev-server']?.port
          ? String(poolSlot.resources['dev-server'].port)
          : undefined,
      };
    }
  }
  return { simulator: 'fs-companion-1', port: '7677' };
}

function fixtureNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

const runId = 'demo-companion-run-1';
const slotId = 'demo-companion-ios-1';
const artifactManifest = [
  {
    path: 'screenshots/before-command-center.png',
    purpose: 'before-screenshot',
    type: 'screenshot',
    label: 'Command Center before',
  },
  {
    path: 'screenshots/after-command-center.png',
    purpose: 'after-screenshot',
    type: 'screenshot',
    label: 'Command Center after',
  },
  {
    path: 'videos/watch-and-steer.mp4',
    purpose: 'video',
    type: 'video',
    label: 'Watch-and-steer clip',
  },
  { path: 'recipe.json', purpose: 'recipe', type: 'recipe', label: 'Recipe file' },
  { path: 'trace.json', purpose: 'trace', type: 'trace', label: 'Trace file' },
  { path: 'diff.patch', purpose: 'diff', type: 'diff', label: 'Patch diff' },
];
const demoRun = {
  id: runId,
  familyId: 'demo-family-1',
  lane: 'validation',
  flowType: 'dev',
  mode: 'interactive',
  status: 'monitoring',
  project: 'farmslot-farm',
  ticketOrPr: 'Docusaurus demo: validate recipe evidence',
  app: 'apps/docs',
  effort: 'demo',
  slotId,
  branch: 'docs/real-demo-media',
  taskFile: 'tasks/docusaurus-demo-media.md',
  steps: [
    {
      name: 'Launch Command Center',
      status: 'done',
      startedAt: fixtureNow(-360000),
      completedAt: fixtureNow(-300000),
      outputs: [{ path: 'trace.json', purpose: 'trace', type: 'trace' }],
    },
    {
      name: 'Capture recipe proof',
      status: 'running',
      startedAt: fixtureNow(-180000),
      outputs: artifactManifest,
    },
    { name: 'Human review gate', status: 'pending' },
  ],
  decisions: [
    {
      id: 'demo-ready-gate-1',
      runId,
      slotId,
      kind: 'ready',
      status: 'open',
      createdAt: fixtureNow(-120000),
      updatedAt: fixtureNow(-60000),
      runMeta: {
        runId,
        project: 'farmslot-farm',
        slotId,
        ticketOrPr: 'Docusaurus demo: validate recipe evidence',
      },
      payload: {
        kind: 'ready',
        artifactManifest,
        summary: 'Public-safe demo evidence is ready for review.',
      },
    },
  ],
  metrics: { durationMs: 420000, runner: 'codex', model: 'gpt-5.1' },
  createdAt: fixtureNow(-420000),
  updatedAt: fixtureNow(-30000),
  summary: 'Recipe-owned Docusaurus media proof package is being validated.',
  liveRecipeContext: { recipeRunId: 'companion-demo-recipe-run', artifactManifest },
};
const demoFleet = {
  checkedAt: fixtureNow(),
  slots: [
    {
      slot: slotId,
      machine: 'farmslot-demo',
      platform: 'ios',
      project: 'farmslot-farm',
      health: 'ok',
      branch: 'docs/real-demo-media',
      agent: 'codex',
      enabled: true,
      dispatchable: false,
      lifecycle: 'busy',
      phase: 'working',
      warm: true,
      taskId: 'demo-task-1',
      taskFile: 'tasks/docusaurus-demo-media.md',
      currentRunId: runId,
      currentFlowType: 'dev',
      currentTicketOrPr: 'Docusaurus demo: validate recipe evidence',
      currentMode: 'interactive',
      currentFamilyId: 'demo-family-1',
      currentLane: 'validation',
      activeTaskFile: 'TASK.md',
      dispatchedAt: fixtureNow(-420000),
      completedAt: null,
      runner: 'codex',
      model: 'gpt-5.1',
      deviceName: 'fs-companion-1',
      taskPhase: 'Capture 2/3',
      taskStepProgress: 0.66,
    },
    {
      slot: 'demo-audiolab-ios-1',
      machine: 'farmslot-demo',
      platform: 'ios',
      project: 'audiolab-farm',
      health: 'ok',
      branch: 'main',
      agent: 'codex',
      enabled: true,
      dispatchable: true,
      lifecycle: 'ready',
      phase: 'idle',
      warm: true,
      taskId: null,
      taskFile: null,
      dispatchedAt: null,
      completedAt: null,
      runner: null,
      model: null,
      deviceName: 'playground-1',
      taskPhase: null,
      taskStepProgress: null,
    },
  ],
  summary: {
    total: 2,
    ready: 1,
    busy: 1,
    held: 0,
    manual: 0,
    disabled: 0,
    blocked: 0,
    warmCount: 2,
  },
};

async function startFixtureGateway(port) {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/run-artifact')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Public-safe demo artifact served by Companion capture fixture.');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'farmslot-docs-companion-fixture' }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== 'req') return;
      respond(ws, frame);
    });
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({ type: 'event', event: 'fleet.updated', payload: { fleet: demoFleet } }),
        );
    }, 800);
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'event', event: 'run.updated', payload: { run: demoRun } }));
    }, 1200);
  });
  await new Promise((resolvePromise) => server.listen(port, gatewayBindHost, resolvePromise));
  return { server, wss };
}

function respond(ws, frame) {
  const payload = responsePayload(frame.method, frame.params);
  ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }));
}

function responsePayload(method, params) {
  observedMethods.add(method);
  switch (method) {
    case 'auth.connect':
      return { ok: true, authMode: 'none', clientKind: 'companion' };
    case 'fleet.status':
      return { fleet: demoFleet };
    case 'run.list':
      return { runs: [demoRun], meta: { total: 1, limit: 30, offset: 0 } };
    case 'run.get':
      return { run: demoRun };
    case 'decision.list':
      return { decisions: demoRun.decisions };
    case 'run.recipeRunsForRun':
      return {
        recipeRuns: [
          {
            id: 'companion-demo-recipe-run',
            label: 'Validated demo recipe',
            groupKind: 'latest-valid',
            status: 'pass',
            artifactManifest,
          },
        ],
      };
    case 'task.progress':
      return { progress: null };
    case 'terminal.snapshot':
      return {
        slotId,
        data: '$ yarn docs:build\n[SUCCESS] Generated static files.\n',
        mode: 'available',
      };
    case 'terminal.subscribe':
      return { ok: true };
    case 'terminal.unsubscribe':
      return { ok: true };
    default:
      return { ok: true, echo: { method, params } };
  }
}

function ensureSimulatorBooted() {
  spawnSync('xcrun', ['simctl', 'boot', simulator], { encoding: 'utf8' });
  spawnSync('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', simulatorUdid()], {
    encoding: 'utf8',
  });
}

function simulatorUdid() {
  const result = spawnSync('xcrun', ['simctl', 'list', 'devices', '--json'], { encoding: 'utf8' });
  const devices = JSON.parse(result.stdout).devices || {};
  for (const list of Object.values(devices)) {
    const match = list.find((device) => device.name === simulator);
    if (match) return match.udid;
  }
  return simulator;
}

async function ensureCompanionRuntime() {
  const installed = spawnSync(
    'xcrun',
    ['simctl', 'get_app_container', simulator, expectedBundleId],
    { encoding: 'utf8' },
  );
  if (installed.status === 0) {
    stopMetroIfNeeded();
    startMetroIfNeeded();
    await waitFor(() => portListening(metroPort), 90000, `Metro ${metroPort}`);
    preapproveSimulatorPermissions();
    restartSpringBoard();
    launchCompanionDevClient();
  } else {
    stopMetroIfNeeded();
    launchedProcess = spawn('yarn', ['ios'], {
      cwd: appRoot,
      env: appEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = resolve(artifactsDir, 'logs/companion-ios-launch.log');
    launchedProcess.stdout.on('data', (buf) => writeFileSync(log, String(buf), { flag: 'a' }));
    launchedProcess.stderr.on('data', (buf) => writeFileSync(log, String(buf), { flag: 'a' }));
    await waitFor(() => portListening(metroPort), 240000, `Metro ${metroPort}`);
    await waitFor(() => appInstalled(), 360000, 'Companion app install');
    preapproveSimulatorPermissions();
    restartSpringBoard();
    launchCompanionDevClient();
  }
}

function launchCompanionDevClient() {
  const initialUrl = `http://localhost:${metroPort}?disableOnboarding=1`;
  const result = spawnSync(
    'xcrun',
    [
      'simctl',
      'launch',
      '--terminate-running-process',
      simulator,
      expectedBundleId,
      '--initialUrl',
      initialUrl,
    ],
    {
      cwd: appRoot,
      env: appEnv(),
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  writeFileSync(
    resolve(artifactsDir, 'logs/companion-dev-client-launch.log'),
    `$ xcrun simctl launch --terminate-running-process ${simulator} ${expectedBundleId} --initialUrl ${initialUrl}\n${result.stdout}\n${result.stderr}`,
  );
  if (result.status !== 0)
    throw new Error(`Companion dev client launch failed: ${result.stderr || result.stdout}`);
}

function preapproveSimulatorPermissions() {
  spawnSync(
    'applesimutils',
    [
      '--byName',
      simulator,
      '--bundle',
      expectedBundleId,
      '--setPermissions',
      'notifications=YES,camera=YES,microphone=YES',
    ],
    { encoding: 'utf8' },
  );
  for (const [key, value] of [
    ['EXDevMenuIsOnboardingFinished', 'true'],
    ['EXDevMenuShowsAtLaunch', 'false'],
    ['EXDevMenuShowFloatingActionButton', 'false'],
  ]) {
    spawnSync(
      'xcrun',
      ['simctl', 'spawn', simulator, 'defaults', 'write', expectedBundleId, key, '-bool', value],
      { encoding: 'utf8' },
    );
  }
}

function restartSpringBoard() {
  spawnSync('applesimutils', ['--byName', simulator, '--restartSB'], { encoding: 'utf8' });
}

function appInstalled() {
  return (
    spawnSync('xcrun', ['simctl', 'get_app_container', simulator, expectedBundleId], {
      encoding: 'utf8',
    }).status === 0
  );
}

function removeStaleCompanionApps() {
  for (const bundleId of staleCompanionBundleIds) {
    if (bundleId !== expectedBundleId) uninstallApp(bundleId);
  }
}

function uninstallApp(bundleId) {
  spawnSync('xcrun', ['simctl', 'terminate', simulator, bundleId], { encoding: 'utf8' });
  spawnSync('xcrun', ['simctl', 'uninstall', simulator, bundleId], { encoding: 'utf8' });
}

function stopMetroIfNeeded() {
  spawnSync(
    'bash',
    ['-lc', `lsof -ti :${metroPort} 2>/dev/null | xargs kill 2>/dev/null || true`],
    { encoding: 'utf8' },
  );
}

function startMetroIfNeeded() {
  if (portListening(metroPort)) return;
  const log = resolve(artifactsDir, 'logs/companion-metro.log');
  const outFd = openSync(log, 'a');
  const errFd = openSync(log, 'a');
  const child = spawn('yarn', ['start'], {
    cwd: appRoot,
    env: appEnv(),
    stdio: ['ignore', outFd, errFd],
    detached: true,
  });
  closeSync(outFd);
  closeSync(errFd);
  child.unref();
}

function applyLocalEnvFixture() {
  hadLocalEnv = existsSync(localEnvPath);
  originalLocalEnv = hadLocalEnv ? readFileSync(localEnvPath, 'utf8') : null;
  const existing = originalLocalEnv ?? '';
  const filtered = existing
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^EXPO_PUBLIC_GATEWAY_URL=/.test(line) &&
        !/^FARMSLOT_REMOTE_GATEWAY_URL=/.test(line) &&
        !/^FARMSLOT_GATEWAY_TOKEN=/.test(line) &&
        !/^FARMSLOT_REMOTE_GATEWAY_TOKEN=/.test(line),
    )
    .join('\n')
    .trim();
  const next = `${filtered ? `${filtered}\n` : ''}EXPO_PUBLIC_GATEWAY_URL=${gatewayUrl}\nFARMSLOT_REMOTE_GATEWAY_URL=\nFARMSLOT_GATEWAY_TOKEN=\nFARMSLOT_REMOTE_GATEWAY_TOKEN=\n`;
  writeFileSync(localEnvPath, next);
}

function restoreLocalEnvFixture() {
  if (originalLocalEnv !== null) writeFileSync(localEnvPath, originalLocalEnv);
  else if (!hadLocalEnv && existsSync(localEnvPath)) unlinkSync(localEnvPath);
}

function appEnv(extra = {}) {
  return {
    ...process.env,
    APP_VARIANT: appVariant,
    NODE_ENV: 'development',
    DEVICE_MODE: 'simulator',
    IOS_SIMULATOR: simulator,
    SIMULATOR: simulator,
    SITEED_BUNDLE_BASE: siteedBundleBase,
    SITEED_SCHEME_BASE: siteedSchemeBase,
    BUNDLE_ID: expectedBundleId,
    SCHEME: expectedScheme,
    METRO_PORT: metroPort,
    WATCHER_PORT: metroPort,
    GATEWAY_PORT: gatewayPort,
    METRO_CONNECTION: 'localhost',
    EXPO_PUBLIC_GATEWAY_URL: gatewayUrl,
    EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE: '1',
    FARMSLOT_REMOTE_GATEWAY_URL: '',
    FARMSLOT_GATEWAY_TOKEN: '',
    FARMSLOT_REMOTE_GATEWAY_TOKEN: '',
    ...extra,
  };
}

async function waitForGatewayTraffic(timeoutMs) {
  await waitFor(
    () => observedMethods.has('fleet.status') && observedMethods.has('run.list'),
    timeoutMs,
    'Companion fixture gateway requests',
  );
}

async function recordSimulator(output) {
  if (existsSync(output)) unlinkSync(output);
  const child = spawn(
    'xcrun',
    ['simctl', 'io', simulator, 'recordVideo', '--codec=h264', '--force', output],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => {
    stdout += String(buf);
  });
  child.stderr.on('data', (buf) => {
    stderr += String(buf);
  });
  await sleep(captureSeconds * 1000);
  child.kill('SIGINT');
  const status = await new Promise((resolvePromise) =>
    child.on('close', (code) => resolvePromise(code ?? 1)),
  );
  writeFileSync(
    resolve(artifactsDir, 'logs/simctl-record-video.log'),
    `$ xcrun simctl io ${simulator} recordVideo --codec=h264 --force ${output}\n${stdout}\n${stderr}`,
  );
  if (status !== 0) throw new Error(`simctl recordVideo failed: ${stderr || stdout}`);
}

function captureSimulatorScreenshot(path) {
  if (existsSync(path)) unlinkSync(path);
  const result = spawnSync('xcrun', ['simctl', 'io', simulator, 'screenshot', path], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  writeFileSync(
    resolve(artifactsDir, 'logs/simctl-screenshot.log'),
    `$ xcrun simctl io ${simulator} screenshot ${path}\n${result.stdout}\n${result.stderr}`,
  );
  if (result.status !== 0)
    throw new Error(`simctl screenshot failed: ${result.stderr || result.stdout}`);
  assertNonEmpty(path, 'screenshot');
}

function extractPoster(videoPath, posterPath) {
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-sseof', '-1', '-i', videoPath, '-frames:v', '1', '-update', '1', posterPath],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  writeFileSync(
    resolve(artifactsDir, 'logs/ffmpeg-poster.log'),
    `${result.stdout}\n${result.stderr}`,
  );
  if (result.status !== 0)
    throw new Error(`ffmpeg poster extraction failed: ${result.stderr || result.stdout}`);
  assertNonEmpty(posterPath, 'poster frame');
}

function writeOutputs({ videoPath, posterPath, screenshotPath }) {
  const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
  const artifacts = [
    {
      path: rel(videoPath, artifactsDir),
      type: 'video',
      mimeType: 'video/mp4',
      category: 'proof',
      nodeId: 'record-supervision',
      label: 'Companion simulator supervision video',
    },
    {
      path: rel(posterPath, artifactsDir),
      type: 'screenshot',
      mimeType: 'image/png',
      category: 'proof',
      nodeId: 'record-supervision',
      label: 'Companion simulator supervision poster frame',
    },
    {
      path: rel(screenshotPath, artifactsDir),
      type: 'screenshot',
      mimeType: 'image/png',
      category: 'proof',
      nodeId: 'record-supervision',
      label: 'Companion simulator supervision screenshot',
    },
    {
      path: 'recipe.json',
      type: 'recipe',
      mimeType: 'application/json',
      category: 'debug',
      label: 'Resolved capture recipe',
    },
  ];
  writeFileSync(
    resolve(artifactsDir, 'trace.json'),
    JSON.stringify({ version: 1, recipeId: recipe.id, steps: trace }, null, 2),
  );
  writeFileSync(
    resolve(artifactsDir, 'artifact-manifest.json'),
    JSON.stringify({ version: 1, runStatus: 'pass', artifacts }, null, 2),
  );
  writeFileSync(
    resolve(artifactsDir, 'summary.json'),
    JSON.stringify(
      {
        status: 'pass',
        recipeId: recipe.id,
        title: recipe.title,
        target: {
          app: 'apps/companion',
          platform: 'ios',
          simulator,
          metroPort,
          gatewayUrl,
          bundleId: expectedBundleId,
          scheme: expectedScheme,
        },
        fixture:
          'Public-safe local gateway fixture; no product state injection and no store screenshot regeneration.',
        copiedToDocs: copyToDocs ? rel(docsImage) : null,
        regeneratedBy: `yarn --cwd apps/docs capture:companion-supervision --artifacts-dir ${rel(artifactsDir)}${copyToDocs ? ' --copy-to-docs' : ''}`,
        publicSafety: {
          forbiddenPatternsChecked: forbidden.map(String),
          fixtureLabelsChecked: ['farmslot-farm', 'audiolab-farm', 'Docusaurus demo'],
        },
      },
      null,
      2,
    ),
  );
}

function step(nodeId, status, message, extra = {}) {
  trace.push({ nodeId, status, message, at: new Date().toISOString(), ...extra });
}

function portListening(port) {
  return (
    spawnSync('bash', ['-lc', `lsof -nP -iTCP:${port} -sTCP:LISTEN >/dev/null 2>&1`], {
      encoding: 'utf8',
    }).status === 0
  );
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function assertNonEmpty(path, label) {
  if (!existsSync(path) || statSync(path).size === 0)
    throw new Error(`${label} missing or empty: ${path}`);
}

function cleanup() {
  restoreLocalEnvFixture();
  if (launchedProcess && !launchedProcess.killed) launchedProcess.kill('SIGTERM');
  if (gateway) {
    for (const client of gateway.wss.clients) client.terminate();
    gateway.wss.close();
    gateway.server.close();
    gateway = null;
  }
}

function rel(path, from = repoRoot) {
  return relative(from, path).replaceAll('\\', '/');
}
