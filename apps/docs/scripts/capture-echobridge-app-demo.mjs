#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const slotConfig = readEchoBridgeSlotConfig();
const echobridgeRepo =
  process.env.ECHOBRIDGE_REPO ||
  readProjectRepo('projects/echobridge-farm/project.json', 'ECHOBRIDGE_REPO');
const appRoot = resolve(echobridgeRepo, 'apps/echobridge');
const defaultRecipe = resolve(
  repoRoot,
  'docs/examples/recipes/farmslot/docusaurus-echobridge-live-recording.capture-plan.json',
);
const docsVideo = resolve(
  repoRoot,
  'apps/docs/static/videos/demos/echobridge-live-recording-ios.mp4',
);
const docsPoster = resolve(
  repoRoot,
  'apps/docs/static/img/demos/echobridge-live-recording-ios.png',
);
const docsScreenshot = resolve(
  repoRoot,
  'apps/docs/static/img/demos/echobridge-live-recording-ios-final.png',
);
const forbidden = [/wallet/i, /Wallet/i, /PROJ-\d+/i, /Acme/i, /TAT-\d+/i];
const copyToDocs = process.argv.includes('--copy-to-docs');
const args = parseArgs(process.argv.slice(2));
const recipePath = resolve(repoRoot, args.recipe || defaultRecipe);
const artifactsDir = resolve(
  repoRoot,
  args.artifactsDir || '.agent/demo-stage/docusaurus-echobridge-live-recording/output',
);
const envDefaults = readEnvDefaults(
  resolve(appRoot, '.env.agentic.local'),
  resolve(appRoot, '.env.agentic'),
  resolve(appRoot, '.env.agentic.example'),
);
const watcherPort =
  process.env.WATCHER_PORT || slotConfig.port || envDefaults.WATCHER_PORT || '7600';
const iosSimulator =
  process.env.IOS_SIMULATOR || slotConfig.simulator || envDefaults.IOS_SIMULATOR || 'echodev-1';
const captureSeconds = Number(process.env.FARMSLOT_DEMO_CAPTURE_SECONDS || 16);
const trace = [];
let startedMetro = null;

main().catch((err) => {
  stopRecordingIfNeeded();
  if (startedMetro) startedMetro.kill('SIGTERM');
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});

async function main() {
  mkdirSync(artifactsDir, { recursive: true });
  for (const dir of ['screenshots', 'videos', 'posters', 'logs'])
    mkdirSync(resolve(artifactsDir, dir), { recursive: true });
  copyFileSync(recipePath, resolve(artifactsDir, 'recipe.json'));

  step(
    'launch-echobridge',
    'started',
    `Launching EchoBridge on ${iosSimulator}, Metro ${watcherPort}`,
  );
  ensureRuntime();
  step('launch-echobridge', 'passed', 'EchoBridge iOS runtime is agentic-ready through Metro/CDP');

  step(
    'prepare-public-safe-session',
    'started',
    'Granting simulator permissions and installing local public-safe auth fixtures',
  );
  cdp(['set-local-auth-mode-fixture', 'http://localhost:8124']);
  cdp(['login-api-key', 'http://localhost:8124', 'recipe-demo-key']);
  cdp(['complete-onboarding']);
  stopRecordingIfNeeded();
  await sleep(1000);
  step(
    'prepare-public-safe-session',
    'passed',
    'Local auth fixture installed and onboarding completed',
  );

  step(
    'start-live-recording',
    'started',
    'Starting a real EchoBridge recorder session through the app bridge',
  );
  cdp([
    'eval',
    `globalThis.__AGENTIC__.startRecording({title:'Farmslot EchoBridge demo recording', localOnly:true})`,
  ]);
  await waitForAsync(() => getState().isRecording === true, 12000, 'EchoBridge recorder to start');
  await sleep(1200);
  step('start-live-recording', 'passed', 'Recorder is live; timer and waveform are visible');

  const videoPath = resolve(artifactsDir, 'videos/echobridge-live-recording-ios.mp4');
  step(
    'record-live-proof',
    'started',
    `Recording ${captureSeconds}s of the simulator while the app recorder runs`,
  );
  await recordSimulator(videoPath);
  assertNonEmpty(videoPath, 'recorded MP4');

  const finalText = collectVisibleText();
  assertSafeText(finalText);
  const liveState = getState();
  if (!liveState.isRecording || liveState.durationMs < 3000)
    throw new Error(`Recorder proof state is not live enough: ${JSON.stringify(liveState)}`);

  const screenshotPath = resolve(
    artifactsDir,
    'screenshots/echobridge-live-recording-ios-final.png',
  );
  captureSimulatorScreenshot(screenshotPath);
  const posterPath = resolve(artifactsDir, 'posters/echobridge-live-recording-ios.png');
  extractPoster(videoPath, posterPath);
  step(
    'record-live-proof',
    'passed',
    'Video, poster, and final screenshot captured from the real simulator',
    { durationMs: liveState.durationMs, size: liveState.size },
  );

  step('stop-live-recording', 'started', 'Stopping the app recorder after proof capture');
  stopRecordingIfNeeded();
  await waitForAsync(() => getState().isRecording !== true, 12000, 'EchoBridge recorder to stop');
  step('stop-live-recording', 'passed', 'Recorder stopped cleanly after capture');

  if (copyToDocs) {
    mkdirSync(dirname(docsVideo), { recursive: true });
    mkdirSync(dirname(docsPoster), { recursive: true });
    copyFileSync(videoPath, docsVideo);
    copyFileSync(posterPath, docsPoster);
    copyFileSync(screenshotPath, docsScreenshot);
  }

  writeOutputs({
    videoPath,
    posterPath,
    screenshotPath,
    visibleChars: finalText.length,
    liveState,
  });
  console.log(JSON.stringify({ ok: true, artifactsDir, copiedToDocs: copyToDocs }, null, 2));
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

function readProjectRepo(projectConfigPath, envName) {
  const path = resolve(repoRoot, projectConfigPath);
  if (existsSync(path)) {
    const projectConfig = JSON.parse(readFileSync(path, 'utf8'));
    if (projectConfig.primary_repo) return projectConfig.primary_repo;
  }
  throw new Error(`${envName} is required when ${projectConfigPath} is not present`);
}

function readEnvDefaults(...paths) {
  const values = {};
  for (const path of paths.reverse()) {
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const [key, ...rest] = line.split('=');
      values[key.trim()] = rest
        .join('=')
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
  return values;
}

function readEchoBridgeSlotConfig() {
  const poolPath = process.env.ECHOBRIDGE_POOL_JSON || process.env.FARMSLOT_DEMO_POOL_JSON;
  if (!poolPath) return {};
  const pool = JSON.parse(readFileSync(resolve(repoRoot, poolPath), 'utf8'));
  const slot = (pool.slots || []).find(
    (candidate) => candidate.project === 'echobridge-farm' && candidate.app === 'echobridge',
  );
  return {
    simulator: slot?.resources?.['ios-sim']?.simulator,
    port: slot?.resources?.['dev-server']?.port
      ? String(slot.resources['dev-server'].port)
      : undefined,
  };
}

function step(nodeId, status, message, extra = {}) {
  trace.push({ nodeId, status, message, at: new Date().toISOString(), ...extra });
}

function appEnv(extra = {}) {
  const nodeOptions = [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first']
    .filter(Boolean)
    .join(' ');
  return {
    ...process.env,
    APP_VARIANT: 'development',
    NODE_ENV: 'development',
    METRO_CONNECTION: 'localhost',
    WATCHER_PORT: watcherPort,
    IOS_SIMULATOR: iosSimulator,
    FARMSLOT_RECIPE_DEVICE: iosSimulator,
    NODE_OPTIONS: nodeOptions,
    ...extra,
  };
}

function ensureRuntime() {
  grantSimulatorPermissions();
  ensureSimulatorBooted();
  ensureMetro();
  launchApp();
  waitFor(
    () => {
      const result = cdp(['status'], { allowFailure: true });
      return result.status === 0 && result.stdout.includes('"ready": true');
    },
    60000,
    'EchoBridge CDP target',
  );
}

function grantSimulatorPermissions() {
  const result = spawnSync(
    'applesimutils',
    [
      '--byName',
      iosSimulator,
      '--bundle',
      'net.siteed.echobridge.dev',
      '--setPermissions',
      'microphone=YES,notifications=NO',
    ],
    {
      cwd: repoRoot,
      env: appEnv(),
      encoding: 'utf8',
      timeout: 20000,
    },
  );
  writeFileSync(
    resolve(artifactsDir, 'logs/applesimutils-permissions.log'),
    `${result.stdout}\n${result.stderr}`,
  );
}

function ensureSimulatorBooted() {
  spawnSync('xcrun', ['simctl', 'boot', iosSimulator], { encoding: 'utf8' });
  spawnSync('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', simulatorUdid()], {
    encoding: 'utf8',
  });
}

function simulatorUdid() {
  const result = spawnSync('xcrun', ['simctl', 'list', 'devices', '--json'], { encoding: 'utf8' });
  const devices = JSON.parse(result.stdout).devices || {};
  for (const list of Object.values(devices)) {
    const match = list.find((device) => device.name === iosSimulator);
    if (match) return match.udid;
  }
  return iosSimulator;
}

function ensureMetro() {
  if (portListening(watcherPort)) return;
  startedMetro = spawn('yarn', ['start'], {
    cwd: appRoot,
    env: appEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const log = resolve(artifactsDir, 'logs/echobridge-start.log');
  startedMetro.stdout.on('data', (buf) => writeFileSync(log, String(buf), { flag: 'a' }));
  startedMetro.stderr.on('data', (buf) => writeFileSync(log, String(buf), { flag: 'a' }));
  waitFor(() => portListening(watcherPort), 90000, `Metro port ${watcherPort}`);
}

function launchApp() {
  const installed = spawnSync(
    'xcrun',
    ['simctl', 'get_app_container', iosSimulator, 'net.siteed.echobridge.dev'],
    { encoding: 'utf8' },
  );
  let launch;
  if (installed.status === 0) {
    launch = spawnSync('xcrun', ['simctl', 'launch', iosSimulator, 'net.siteed.echobridge.dev'], {
      cwd: appRoot,
      env: appEnv(),
      encoding: 'utf8',
      timeout: 30000,
    });
  } else {
    launch = spawnSync('yarn', ['ios'], {
      cwd: appRoot,
      env: appEnv(),
      encoding: 'utf8',
      timeout: 900000,
    });
  }
  writeFileSync(
    resolve(artifactsDir, 'logs/echobridge-ios-launch.log'),
    `${launch.stdout}\n${launch.stderr}`,
  );
  if (launch.status !== 0)
    throw new Error(`EchoBridge iOS launch failed: ${launch.stderr || launch.stdout}`);
}

function cdp(args, options = {}) {
  const result = spawnSync(
    'node',
    ['scripts/agentic/cdp-bridge.mjs', '--device', iosSimulator, ...args],
    {
      cwd: appRoot,
      env: appEnv(),
      encoding: 'utf8',
      timeout: options.timeoutMs || 30000,
    },
  );
  writeFileSync(
    resolve(artifactsDir, 'logs/echobridge-cdp.log'),
    `$ node scripts/agentic/cdp-bridge.mjs --device ${iosSimulator} ${args.join(' ')}\n${result.stdout}\n${result.stderr}\n`,
    { flag: 'a' },
  );
  if (!options.allowFailure && result.status !== 0)
    throw new Error(`EchoBridge CDP command failed: ${result.stderr || result.stdout}`);
  return result;
}

function getState() {
  const result = cdp(['eval', 'globalThis.__AGENTIC__.getState()']);
  return JSON.parse(result.stdout);
}

function stopRecordingIfNeeded() {
  const stateResult = cdp(['eval', 'globalThis.__AGENTIC__?.getState?.()'], {
    allowFailure: true,
    timeoutMs: 10000,
  });
  if (stateResult.status !== 0) return;
  const state = JSON.parse(stateResult.stdout || '{}');
  if (!state.isRecording) return;
  cdp(['eval', 'globalThis.__AGENTIC__.stopRecording()'], { allowFailure: true, timeoutMs: 10000 });
}

async function recordSimulator(output) {
  if (existsSync(output)) unlinkSync(output);
  const child = spawn(
    'xcrun',
    ['simctl', 'io', iosSimulator, 'recordVideo', '--codec=h264', '--force', output],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
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
    `$ xcrun simctl io ${iosSimulator} recordVideo --codec=h264 --force ${output}\n${stdout}\n${stderr}`,
  );
  if (status !== 0) throw new Error(`simctl recordVideo failed: ${stderr || stdout}`);
  assertNonEmpty(output, 'recorded MP4');
}

function captureSimulatorScreenshot(path) {
  if (existsSync(path)) unlinkSync(path);
  const result = spawnSync('xcrun', ['simctl', 'io', iosSimulator, 'screenshot', path], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  writeFileSync(
    resolve(artifactsDir, 'logs/simctl-screenshot.log'),
    `$ xcrun simctl io ${iosSimulator} screenshot ${path}\n${result.stdout}\n${result.stderr}`,
  );
  if (result.status !== 0)
    throw new Error(`simctl screenshot failed: ${result.stderr || result.stdout}`);
  assertNonEmpty(path, 'screenshot');
}

function extractPoster(videoPath, posterPath) {
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-sseof', '-1', '-i', videoPath, '-frames:v', '1', '-update', '1', posterPath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  writeFileSync(
    resolve(artifactsDir, 'logs/ffmpeg-poster.log'),
    `${result.stdout}\n${result.stderr}`,
  );
  if (result.status !== 0)
    throw new Error(`ffmpeg poster extraction failed: ${result.stderr || result.stdout}`);
  assertNonEmpty(posterPath, 'poster frame');
}

function collectVisibleText() {
  const expression = `(() => {
    const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const ids = new Set([...(hook?._fiberRoots?.keys?.() || []), ...(hook?.renderers?.keys?.() || [])]);
    const texts = [];
    const seen = new Set();
    function add(value) { if (typeof value === 'string' && value.trim()) texts.push(value.trim()); }
    function visit(fiber) {
      if (!fiber || seen.has(fiber)) return;
      seen.add(fiber);
      const props = fiber.memoizedProps || {};
      add(props.children);
      if (Array.isArray(props.children)) props.children.forEach(add);
      add(props.accessibilityLabel);
      add(props.testID);
      visit(fiber.child);
      visit(fiber.sibling);
    }
    for (const id of ids) for (const root of hook.getFiberRoots(id) || []) visit(root.current);
    return [...new Set(texts)].join(' ');
  })()`;
  const result = cdp(['eval', expression], { timeoutMs: 30000 });
  return result.stdout.trim();
}

function assertSafeText(text) {
  for (const pattern of forbidden) {
    if (pattern.test(text)) throw new Error(`Forbidden public-demo text visible: ${pattern}`);
  }
}

function writeOutputs({ videoPath, posterPath, screenshotPath, visibleChars, liveState }) {
  const artifacts = [
    {
      path: rel(videoPath),
      type: 'video',
      mimeType: 'video/mp4',
      category: 'proof',
      nodeId: 'record-live-proof',
      label: 'EchoBridge iOS live recording demo video',
    },
    {
      path: rel(posterPath),
      type: 'screenshot',
      mimeType: 'image/png',
      category: 'proof',
      nodeId: 'record-live-proof',
      label: 'EchoBridge iOS live recording poster frame',
    },
    {
      path: rel(screenshotPath),
      type: 'screenshot',
      mimeType: 'image/png',
      category: 'proof',
      nodeId: 'record-live-proof',
      label: 'EchoBridge iOS live recording final screenshot',
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
    JSON.stringify({ version: 1, recipeId: recipeId(), steps: trace }, null, 2),
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
        recipeId: recipeId(),
        title: JSON.parse(readFileSync(recipePath, 'utf8')).title,
        target: {
          repo: echobridgeRepo,
          app: 'apps/echobridge',
          platform: 'ios',
          simulator: iosSimulator,
          watcherPort,
        },
        fixture: 'Public-safe local auth fixture only; no product source files were patched.',
        regeneratedBy: `yarn --cwd apps/docs capture:echobridge-demo --artifacts-dir ${relative(repoRoot, artifactsDir)}${copyToDocs ? ' --copy-to-docs' : ''}`,
        copiedToDocs: copyToDocs
          ? {
              video: relative(repoRoot, docsVideo),
              poster: relative(repoRoot, docsPoster),
              screenshot: relative(repoRoot, docsScreenshot),
            }
          : null,
        liveProof: {
          durationMs: liveState.durationMs,
          size: liveState.size,
          isRecording: liveState.isRecording,
        },
        publicSafety: { forbiddenPatternsChecked: forbidden.map(String), visibleChars },
      },
      null,
      2,
    ),
  );
}

function recipeId() {
  return basename(recipePath).replace(/\.capture-plan\.json$/u, '');
}

function portListening(port) {
  const result = spawnSync('bash', ['-lc', `lsof -nP -iTCP:${port} -sTCP:LISTEN >/dev/null 2>&1`], {
    encoding: 'utf8',
  });
  return result.status === 0;
}

function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForAsync(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(500);
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

function rel(path) {
  return relative(artifactsDir, path).replaceAll('\\', '/');
}
