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
const audiolabRepo =
  process.env.AUDIOLAB_REPO ||
  readProjectRepo('projects/audiolab-farm/project.json', 'AUDIOLAB_REPO');
const appRoot = resolve(audiolabRepo, 'apps/playground');
const importScreenPath = resolve(appRoot, 'src/app/(tabs)/import.tsx');
const defaultRecipe = resolve(
  repoRoot,
  'docs/examples/recipes/farmslot/docusaurus-audiolab-sample-banner.capture-plan.json',
);
const docsVideo = resolve(repoRoot, 'apps/docs/static/videos/demos/audiolab-sample-banner-ios.mp4');
const docsPoster = resolve(repoRoot, 'apps/docs/static/img/demos/audiolab-sample-banner-ios.png');
const docsScreenshot = resolve(
  repoRoot,
  'apps/docs/static/img/demos/audiolab-sample-banner-ios-final.png',
);
const forbidden = [/wallet/i, /Wallet/i, /PROJ-\d+/i, /Acme/i, /TAT-\d+/i];
const bannerText = 'FARMSLOT DEMO: SAMPLE AUDIO LOADED';
const captureSeconds = Number(process.env.FARMSLOT_DEMO_CAPTURE_SECONDS || 24);
const copyToDocs = process.argv.includes('--copy-to-docs');
const args = parseArgs(process.argv.slice(2));
const recipePath = resolve(repoRoot, args.recipe || defaultRecipe);
const artifactsDir = resolve(
  repoRoot,
  args.artifactsDir || '.agent/demo-stage/docusaurus-audiolab-sample-banner/output',
);
const envConfig = readEnvDefaults(resolve(appRoot, '.env.development'));
const watcherPort = process.env.WATCHER_PORT || envConfig.WATCHER_PORT || '7365';
const iosSimulator = process.env.IOS_SIMULATOR || envConfig.IOS_SIMULATOR || 'playground-1';
const trace = [];
let originalImportScreen = '';
let patched = false;

main().catch((err) => {
  restoreFixture();
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});

async function main() {
  mkdirSync(artifactsDir, { recursive: true });
  for (const dir of ['screenshots', 'videos', 'posters', 'logs'])
    mkdirSync(resolve(artifactsDir, dir), { recursive: true });
  copyFileSync(recipePath, resolve(artifactsDir, 'recipe.json'));

  try {
    step(
      'prepare-demo-fixture',
      'started',
      `Applying reversible AudioLab issue #414 fixture in ${relative(repoRoot, importScreenPath)}`,
    );
    applyFixturePatch();
    step(
      'prepare-demo-fixture',
      'passed',
      'Debug banner fixture applied locally; original file will be restored after capture',
    );

    step(
      'launch-audiolab',
      'started',
      `Launching AudioLab playground on ${iosSimulator}, Metro ${watcherPort}`,
    );
    ensureAudiolabRuntime();
    step('launch-audiolab', 'passed', 'AudioLab runtime is reachable through the app CDP bridge');

    step(
      'assert-banner-absent',
      'started',
      'Opening Import screen and asserting banner is absent before sample load',
    );
    cdp(['navigate', '/(tabs)/import']);
    await sleep(1800);
    const beforeText = collectVisibleText();
    assertSafeText(beforeText);
    if (beforeText.includes(bannerText))
      throw new Error('Banner was visible before loading sample audio');
    step('assert-banner-absent', 'passed', 'Banner is absent before sample audio loads');

    const videoPath = resolve(artifactsDir, 'videos/audiolab-sample-banner-ios.mp4');
    step('record-sample-load', 'started', `Recording ${captureSeconds}s simulator interaction`);
    await recordSimulator(videoPath);
    assertNonEmpty(videoPath, 'recorded MP4');

    step(
      'assert-banner-present',
      'started',
      'Verifying banner is visible after sample audio loads',
    );
    const finalText = collectVisibleText();
    assertSafeText(finalText);
    if (!finalText.includes(bannerText))
      throw new Error(`Expected banner text missing after sample load: ${bannerText}`);
    step('assert-banner-present', 'passed', 'Banner text is present after Load Sample');

    const screenshotPath = resolve(
      artifactsDir,
      'screenshots/audiolab-sample-banner-ios-final.png',
    );
    captureSimulatorScreenshot(screenshotPath);
    const posterPath = resolve(artifactsDir, 'posters/audiolab-sample-banner-ios.png');
    extractPoster(videoPath, posterPath);

    if (copyToDocs) {
      mkdirSync(dirname(docsVideo), { recursive: true });
      mkdirSync(dirname(docsPoster), { recursive: true });
      copyFileSync(videoPath, docsVideo);
      copyFileSync(posterPath, docsPoster);
      copyFileSync(screenshotPath, docsScreenshot);
    }

    writeOutputs({ videoPath, posterPath, screenshotPath, visibleChars: finalText.length });
    console.log(JSON.stringify({ ok: true, artifactsDir, copiedToDocs: copyToDocs }, null, 2));
  } finally {
    restoreFixture();
  }
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

function readEnvDefaults(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    values[key.trim()] = rest
      .join('=')
      .trim()
      .replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function step(nodeId, status, message, extra = {}) {
  trace.push({ nodeId, status, message, at: new Date().toISOString(), ...extra });
}

function applyFixturePatch() {
  originalImportScreen = readFileSync(importScreenPath, 'utf8');
  if (originalImportScreen.includes(bannerText)) return;
  let next = originalImportScreen;
  next = next.replace(
    "        processingContainer: {\n            alignItems: 'center',\n",
    "        debugBanner: {\n            backgroundColor: '#d32f2f',\n            borderRadius: theme.roundness,\n            padding: theme.padding.m,\n            marginTop: theme.padding.s,\n        },\n        debugBannerText: {\n            color: '#fff',\n            fontWeight: '700',\n            textAlign: 'center',\n        },\n        processingContainer: {\n            alignItems: 'center',\n",
  );
  next = next.replace(
    '            {(processing || isSaving) && (\n',
    `            {audioUri && (\n                <View\n                    style={styles.debugBanner}\n                    testID=\"farmslot-sample-loaded-banner\"\n                >\n                    <Text\n                        variant=\"titleMedium\"\n                        style={styles.debugBannerText}\n                    >\n                        ${bannerText}\n                    </Text>\n                </View>\n            )}\n\n            {(processing || isSaving) && (\n`,
  );
  if (next === originalImportScreen || !next.includes(bannerText))
    throw new Error('Failed to apply AudioLab demo fixture patch');
  writeFileSync(importScreenPath, next);
  patched = true;
}

function restoreFixture() {
  if (!patched || !originalImportScreen) return;
  writeFileSync(importScreenPath, originalImportScreen);
  patched = false;
  spawnSync('node', ['scripts/agentic/cdp-bridge.mjs', '--device', iosSimulator, 'reload'], {
    cwd: appRoot,
    env: appEnv(),
    encoding: 'utf8',
    timeout: 10000,
  });
}

function ensureAudiolabRuntime() {
  const start = spawnSync('bash', ['scripts/agentic/start-metro.sh'], {
    cwd: appRoot,
    env: appEnv(),
    encoding: 'utf8',
    timeout: 90000,
  });
  writeFileSync(
    resolve(artifactsDir, 'logs/audiolab-start-metro.log'),
    `${start.stdout}\n${start.stderr}`,
  );
  if (start.status !== 0)
    throw new Error(`AudioLab Metro start failed: ${start.stderr || start.stdout}`);

  let launch = spawnSync('yarn', ['ios:launch'], {
    cwd: appRoot,
    env: appEnv({ SKIP_BUILD: '1' }),
    encoding: 'utf8',
    timeout: 120000,
  });
  if (launch.status !== 0 && /not installed/i.test(`${launch.stdout}\n${launch.stderr}`)) {
    launch = spawnSync('yarn', ['ios'], {
      cwd: appRoot,
      env: appEnv(),
      encoding: 'utf8',
      timeout: 900000,
    });
  }
  writeFileSync(
    resolve(artifactsDir, 'logs/audiolab-ios-launch.log'),
    `${launch.stdout}\n${launch.stderr}`,
  );
  if (launch.status !== 0)
    throw new Error(`AudioLab iOS launch failed: ${launch.stderr || launch.stdout}`);

  cdp(['reload'], { allowFailure: true });
  waitFor(
    () => {
      const result = cdp(['list-devices'], { allowFailure: true });
      return result.status === 0 && result.stdout.includes(iosSimulator);
    },
    45000,
    'AudioLab CDP target',
  );
}

function appEnv(extra = {}) {
  return {
    ...process.env,
    APP_VARIANT: 'development',
    NODE_ENV: 'development',
    EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE: '1',
    WATCHER_PORT: watcherPort,
    IOS_SIMULATOR: iosSimulator,
    FARMSLOT_RECIPE_DEVICE: iosSimulator,
    ...extra,
  };
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
    resolve(artifactsDir, 'logs/audiolab-cdp.log'),
    `$ node scripts/agentic/cdp-bridge.mjs --device ${iosSimulator} ${args.join(' ')}\n${result.stdout}\n${result.stderr}\n`,
    { flag: 'a' },
  );
  if (!options.allowFailure && result.status !== 0)
    throw new Error(`AudioLab CDP command failed: ${result.stderr || result.stdout}`);
  return result;
}

function collectVisibleText() {
  const expression = `(() => {\n    const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;\n    const ids = new Set([...(hook?._fiberRoots?.keys?.() || []), ...(hook?.renderers?.keys?.() || [])]);\n    const texts = [];\n    const seen = new Set();\n    function add(value) { if (typeof value === 'string' && value.trim()) texts.push(value.trim()); }\n    function visit(fiber) {\n      if (!fiber || seen.has(fiber)) return;\n      seen.add(fiber);\n      const props = fiber.memoizedProps || {};\n      add(props.children);\n      if (Array.isArray(props.children)) props.children.forEach(add);\n      add(props.accessibilityLabel);\n      add(props.testID);\n      visit(fiber.child);\n      visit(fiber.sibling);\n    }\n    for (const id of ids) for (const root of hook.getFiberRoots(id) || []) visit(root.current);\n    return [...new Set(texts)].join(' ');\n  })()`;
  const result = cdp(['eval', expression], { timeoutMs: 30000 });
  return result.stdout.trim();
}

function assertSafeText(text) {
  for (const pattern of forbidden) {
    if (pattern.test(text)) throw new Error(`Forbidden public-demo text visible: ${pattern}`);
  }
}

async function recordSimulator(output) {
  if (existsSync(output)) unlinkSync(output);
  const startedAt = Date.now();
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

  await sleep(1200);
  cdp(
    [
      'eval',
      `globalThis.__FARMSLOT_RECIPE_BRIDGE__?.handleCommand?.({command:'hud',nodeId:'assert-banner-absent',payload:{status:'pass',intent:'Import screen opened; banner absent before loading sample audio'}})`,
    ],
    { allowFailure: true },
  );
  await sleep(1000);
  cdp(['press-test-id', 'load-sample-button']);
  await waitForAsync(
    async () => collectVisibleText().includes(bannerText),
    18000,
    'sample-loaded banner',
  );
  cdp(
    [
      'eval',
      `globalThis.__FARMSLOT_RECIPE_BRIDGE__?.handleCommand?.({command:'hud',nodeId:'assert-banner-present',payload:{status:'pass',intent:'Sample audio loaded; demo banner visible'}})`,
    ],
    { allowFailure: true },
  );
  await sleep(2500);
  await sleep(Math.max(0, captureSeconds * 1000 - (Date.now() - startedAt)));

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

function writeOutputs({ videoPath, posterPath, screenshotPath, visibleChars }) {
  const artifacts = [
    {
      path: rel(videoPath),
      type: 'video',
      mimeType: 'video/mp4',
      category: 'proof',
      nodeId: 'record-sample-load',
      label: 'AudioLab iOS sample-load demo video',
    },
    {
      path: rel(posterPath),
      type: 'screenshot',
      mimeType: 'image/png',
      category: 'proof',
      nodeId: 'record-sample-load',
      label: 'AudioLab iOS sample-load poster frame',
    },
    {
      path: rel(screenshotPath),
      type: 'screenshot',
      mimeType: 'image/png',
      category: 'proof',
      nodeId: 'assert-banner-present',
      label: 'AudioLab iOS sample-loaded final screenshot',
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
        issue: 'https://github.com/deeeed/audiolab/issues/414',
        target: {
          repo: audiolabRepo,
          app: 'apps/playground',
          platform: 'ios',
          simulator: iosSimulator,
          watcherPort,
        },
        fixture:
          'Temporary local AudioLab issue #414 debug-banner fixture was applied for capture and restored after media generation.',
        regeneratedBy: `yarn --cwd apps/docs capture:audiolab-demo --artifacts-dir ${relative(repoRoot, artifactsDir)}${copyToDocs ? ' --copy-to-docs' : ''}`,
        copiedToDocs: copyToDocs
          ? {
              video: relative(repoRoot, docsVideo),
              poster: relative(repoRoot, docsPoster),
              screenshot: relative(repoRoot, docsScreenshot),
            }
          : null,
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
  return relative(artifactsDir, path).replaceAll('\\\\', '/');
}
