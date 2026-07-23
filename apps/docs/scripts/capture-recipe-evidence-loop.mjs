#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const commandCenterDir = resolve(repoRoot, 'apps/command-center');
const defaultRecipe = resolve(
  repoRoot,
  'docs/examples/recipes/farmslot/docusaurus-recipe-evidence-loop.capture-plan.json',
);
const docsScreenshot = resolve(
  repoRoot,
  'apps/docs/static/img/demos/recipe-evidence-validation-loop.png',
);
const forbidden = [/\/Users\//i, /wallet address/i, /private key/i, /token/i];
const cdpPort = Number(process.env.FARMSLOT_DEMO_CDP_PORT || 9324);
const captureTitle = 'Farmslot Recipe Evidence Capture';
const copyToDocs = process.argv.includes('--copy-to-docs');
const args = parseArgs(process.argv.slice(2));
const artifactsDir = resolve(
  repoRoot,
  args.artifactsDir || '.agent/demo-stage/docusaurus-recipe-evidence-loop/output',
);
const sourceDir = resolve(
  repoRoot,
  args.sourceDir || '.agent/demo-stage/docusaurus-command-center-parallel/output',
);
const recipePath = resolve(repoRoot, args.recipe || defaultRecipe);
const recipeId = basename(recipePath).replace(/\.capture-plan\.json$/u, '');
const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
const trace = [];

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});

async function main() {
  for (const dir of ['', 'screenshots', 'source', 'logs'])
    mkdirSync(resolve(artifactsDir, dir), { recursive: true });
  copyFileSync(recipePath, resolve(artifactsDir, 'recipe.json'));

  step('load-source-artifacts', 'started', 'Loading real source recipe artifacts');
  const source = loadSourceArtifacts();
  step(
    'load-source-artifacts',
    'passed',
    `Loaded ${source.manifest.artifacts.length} manifest artifacts from ${relative(repoRoot, sourceDir)}`,
  );

  step(
    'render-evidence-board',
    'started',
    'Rendering public-safe evidence board from real artifact data',
  );
  const htmlPath = resolve(artifactsDir, 'recipe-evidence-validation-loop.html');
  const html = renderHtml(source);
  assertSafeText(html);
  writeFileSync(htmlPath, html);
  step('render-evidence-board', 'passed', 'Rendered local evidence board HTML');

  await ensureChrome();
  await openEvidencePage(pathToFileURL(htmlPath).href);
  const visibleText = await evalInPage(`document.body.innerText`);
  assertSafeText(String(visibleText));
  for (const required of [
    'summary.json',
    'trace.json',
    'artifact-manifest.json',
    'record-proof-window',
  ]) {
    if (!String(visibleText).includes(required))
      throw new Error(`Evidence board missing required text: ${required}`);
  }
  step(
    'verify-safe-view',
    'passed',
    'Evidence board shows required artifacts and no forbidden labels',
  );

  const screenshotPath = resolve(artifactsDir, 'screenshots/recipe-evidence-validation-loop.png');
  await capturePageScreenshot(screenshotPath);
  assertNonEmpty(screenshotPath, 'recipe evidence screenshot');
  step('capture-screenshot', 'passed', 'Captured recipe evidence screenshot');

  if (copyToDocs) {
    mkdirSync(dirname(docsScreenshot), { recursive: true });
    copyFileSync(screenshotPath, docsScreenshot);
  }

  writeOutputs({ screenshotPath, source });
  step('publish-artifacts', 'passed', 'Published summary, trace, and artifact manifest');
  writeTrace();
  console.log(
    JSON.stringify({ ok: true, artifactsDir, sourceDir, copiedToDocs: copyToDocs }, null, 2),
  );
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--artifacts-dir') out.artifactsDir = argv[++i];
    else if (arg === '--source-dir') out.sourceDir = argv[++i];
    else if (arg === '--recipe') out.recipe = argv[++i];
  }
  return out;
}

function loadSourceArtifacts() {
  const required = ['summary.json', 'trace.json', 'artifact-manifest.json', 'recipe.json'];
  for (const name of required) {
    const path = resolve(sourceDir, name);
    if (!existsSync(path))
      throw new Error(`Missing source artifact ${path}. Run capture:first-video first.`);
    copyFileSync(path, resolve(artifactsDir, 'source', name));
  }
  const summary = JSON.parse(readFileSync(resolve(sourceDir, 'summary.json'), 'utf8'));
  const sourceTrace = JSON.parse(readFileSync(resolve(sourceDir, 'trace.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(resolve(sourceDir, 'artifact-manifest.json'), 'utf8'));
  const sourceRecipe = JSON.parse(readFileSync(resolve(sourceDir, 'recipe.json'), 'utf8'));
  return { summary, sourceTrace, manifest, sourceRecipe };
}

function renderHtml({ summary, sourceTrace, manifest, sourceRecipe }) {
  const steps = sourceTrace.steps || [];
  const artifacts = manifest.artifacts || [];
  const sourceRel = relative(repoRoot, sourceDir);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(captureTitle)}</title>
<style>
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; background: #070a12; color: #f5f7fb; }
.board { width: 1280px; min-height: 800px; box-sizing: border-box; padding: 42px; background:
  radial-gradient(circle at 16% 14%, rgba(90, 165, 255, .22), transparent 30%),
  radial-gradient(circle at 82% 8%, rgba(91, 255, 190, .16), transparent 30%), #080b14; }
.eyebrow { display: inline-flex; gap: 8px; align-items: center; border: 1px solid rgba(255,255,255,.18); border-radius: 999px; padding: 8px 12px; color: #a7f3d0; font: 800 12px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 22px 0 8px; font-size: 54px; line-height: .95; letter-spacing: -.04em; max-width: 900px; }
.subtitle { margin: 0 0 26px; max-width: 960px; color: #bac5d8; font-size: 19px; line-height: 1.55; }
.grid { display: grid; grid-template-columns: 1.02fr .98fr; gap: 18px; }
.card { border: 1px solid rgba(151, 164, 198, .25); background: rgba(13, 18, 32, .86); border-radius: 22px; box-shadow: 0 20px 70px rgba(0,0,0,.28); overflow: hidden; }
.card h2 { margin: 0; padding: 17px 19px 13px; font-size: 15px; letter-spacing: .08em; text-transform: uppercase; color: #93c5fd; border-bottom: 1px solid rgba(151,164,198,.18); }
.card .body { padding: 18px 19px 20px; }
.kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.kpi { border: 1px solid rgba(255,255,255,.12); border-radius: 16px; padding: 14px; background: rgba(255,255,255,.035); }
.kpi strong { display: block; font-size: 28px; color: #fff; }
.kpi span { color: #9aa8bd; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
.steps { display: grid; gap: 8px; }
.step { display: grid; grid-template-columns: 132px 1fr; gap: 12px; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,.08); }
.step:last-child { border-bottom: 0; }
.badge { align-self: start; display: inline-flex; justify-content: center; border-radius: 999px; padding: 5px 8px; font: 800 11px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; background: rgba(16,185,129,.18); color: #86efac; border: 1px solid rgba(16,185,129,.28); }
.step p { margin: 0; color: #d9e2f2; font-size: 14px; line-height: 1.35; }
.artifacts { display: grid; gap: 10px; }
.artifact { display: grid; grid-template-columns: 84px 1fr; gap: 12px; align-items: start; padding: 11px; border-radius: 14px; background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.08); }
.artifact code, .path { color: #c4b5fd; font: 700 12px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.artifact p { margin: 4px 0 0; color: #aab7cc; font-size: 12px; }
.source { margin-top: 18px; padding: 14px 16px; border-radius: 18px; background: rgba(34,197,94,.08); border: 1px solid rgba(34,197,94,.22); color: #bbf7d0; font: 700 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { margin: 0; color: #dbeafe; white-space: pre-wrap; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
  <main class="board">
    <div class="eyebrow">Recipe evidence package · real artifacts</div>
    <h1>Validation proof is a traceable artifact set.</h1>
    <p class="subtitle">This screenshot is rendered from the actual Command Center watch-and-steer recipe output: summary, trace, manifest, recipe, screenshots, video, and poster. No placeholder run data.</p>
    <section class="grid">
      <article class="card">
        <h2>Validation trace</h2>
        <div class="body steps">
          ${steps.map((step) => `<div class="step"><span class="badge">${escapeHtml(step.status || 'step')}</span><p><strong>${escapeHtml(step.nodeId || 'step')}</strong><br />${escapeHtml(step.message || '')}</p></div>`).join('')}
        </div>
      </article>
      <div>
        <article class="card">
          <h2>Summary</h2>
          <div class="body">
            <div class="kpis">
              <div class="kpi"><strong>${escapeHtml(String(steps.length))}</strong><span>trace steps</span></div>
              <div class="kpi"><strong>${escapeHtml(String(artifacts.length))}</strong><span>artifacts</span></div>
              <div class="kpi"><strong>${escapeHtml(summary.status || manifest.runStatus || 'pass')}</strong><span>status</span></div>
            </div>
            <div class="source">source: ${escapeHtml(sourceRel)}<br />files: summary.json · trace.json · artifact-manifest.json · recipe.json<br />recipe: ${escapeHtml(sourceRecipe.id || summary.recipeId)}</div>
          </div>
        </article>
        <article class="card" style="margin-top:18px">
          <h2>Manifest artifacts</h2>
          <div class="body artifacts">
            ${artifacts.map((artifact) => `<div class="artifact"><span class="badge">${escapeHtml(artifact.type || artifact.category || 'file')}</span><div><div class="path">${escapeHtml(artifact.path)}</div><p>${escapeHtml(artifact.label || artifact.nodeId || '')}</p></div></div>`).join('')}
          </div>
        </article>
      </div>
    </section>
  </main>
</body>
</html>`;
}

async function ensureChrome() {
  if (!(await cdpHttpOk())) {
    const result = spawnSync('bash', ['scripts/debug-chrome.sh'], {
      cwd: commandCenterDir,
      env: {
        ...process.env,
        FARMSLOT_CDP_PORT: String(cdpPort),
        FARMSLOT_CDP_PROFILE:
          process.env.FARMSLOT_DEMO_CDP_PROFILE ||
          resolve(repoRoot, '.agent/demo-stage/docusaurus-recipe-evidence-loop/chrome-profile'),
        FARMSLOT_UI_URL: 'about:blank',
      },
      stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error('Failed to launch debug Chrome');
  }
  await waitFor(() => cdpHttpOk(), 10000, 'Chrome CDP');
}

async function openEvidencePage(url) {
  const tabs = await listCdpTabs();
  const page =
    tabs.find((tab) => tab.type === 'page' && tab.title === captureTitle) ||
    tabs.find((tab) => tab.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('No Chrome page available for evidence capture');
  await withCdp(page.webSocketDebuggerUrl, async (call) => {
    const windowInfo = await call('Browser.getWindowForTarget');
    await call('Browser.setWindowBounds', {
      windowId: windowInfo.windowId,
      bounds: { left: 80, top: 80, width: 1280, height: 840, windowState: 'normal' },
    });
    await call('Page.enable');
    await call('Runtime.enable');
    await call('Page.navigate', { url });
    await sleep(1200);
  });
}

async function capturePageScreenshot(path) {
  const tabs = await listCdpTabs();
  const page =
    tabs.find((tab) => tab.type === 'page' && tab.title === captureTitle) ||
    tabs.find((tab) => tab.type === 'page' && tab.url.startsWith('file:'));
  if (!page?.webSocketDebuggerUrl) throw new Error('Evidence capture tab not found');
  await withCdp(page.webSocketDebuggerUrl, async (call) => {
    const result = await call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    writeFileSync(path, Buffer.from(result.data, 'base64'));
  });
}

async function evalInPage(expression) {
  const tabs = await listCdpTabs();
  const page =
    tabs.find((tab) => tab.type === 'page' && tab.title === captureTitle) ||
    tabs.find((tab) => tab.type === 'page' && tab.url.startsWith('file:'));
  if (!page?.webSocketDebuggerUrl) throw new Error('Evidence eval tab not found');
  return withCdp(page.webSocketDebuggerUrl, async (call) => {
    await call('Runtime.enable');
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          'CDP eval failed',
      );
    return result.result?.value;
  });
}

async function withCdp(webSocketDebuggerUrl, fn) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const opened = new Promise((resolvePromise, rejectPromise) => {
    ws.addEventListener('open', resolvePromise, { once: true });
    ws.addEventListener('error', () => rejectPromise(new Error('CDP websocket failed')), {
      once: true,
    });
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolvePromise, rejectPromise } = pending.get(message.id);
    pending.delete(message.id);
    message.error
      ? rejectPromise(new Error(message.error.message || 'CDP command failed'))
      : resolvePromise(message.result);
  });
  await opened;
  const call = (method, params = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
      const commandId = ++id;
      pending.set(commandId, { resolvePromise, rejectPromise });
      ws.send(JSON.stringify({ id: commandId, method, params }));
    });
  try {
    return await fn(call);
  } finally {
    ws.close();
  }
}

async function listCdpTabs() {
  const response = await fetch(`http://localhost:${cdpPort}/json`);
  if (!response.ok) throw new Error(`CDP tab list failed: ${response.status}`);
  return response.json();
}

async function cdpHttpOk() {
  try {
    const response = await fetch(`http://localhost:${cdpPort}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

function writeOutputs({ screenshotPath, source }) {
  const artifacts = [
    {
      path: rel(screenshotPath),
      type: 'screenshot',
      mimeType: 'image/png',
      category: 'proof',
      nodeId: 'capture-screenshot',
      label: 'Recipe evidence validation loop screenshot',
    },
    {
      path: 'source/summary.json',
      type: 'json',
      mimeType: 'application/json',
      category: 'source',
      nodeId: 'load-source-artifacts',
      label: 'Source recipe summary',
    },
    {
      path: 'source/trace.json',
      type: 'json',
      mimeType: 'application/json',
      category: 'source',
      nodeId: 'load-source-artifacts',
      label: 'Source recipe trace',
    },
    {
      path: 'source/artifact-manifest.json',
      type: 'json',
      mimeType: 'application/json',
      category: 'source',
      nodeId: 'load-source-artifacts',
      label: 'Source artifact manifest',
    },
    {
      path: 'source/recipe.json',
      type: 'recipe',
      mimeType: 'application/json',
      category: 'source',
      nodeId: 'load-source-artifacts',
      label: 'Source recipe',
    },
    {
      path: 'recipe.json',
      type: 'recipe',
      mimeType: 'application/json',
      category: 'debug',
      label: 'Resolved capture recipe',
    },
  ];
  const manifest = {
    version: 1,
    runStatus: 'pass',
    provenance: {
      runner: { source: 'apps/docs/scripts/capture-recipe-evidence-loop.mjs', git_ref: gitRef() },
      sourceRecipeId: source.summary.recipeId,
    },
    artifacts,
  };
  writeFileSync(resolve(artifactsDir, 'artifact-manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(
    resolve(artifactsDir, 'summary.json'),
    JSON.stringify(
      {
        status: 'pass',
        recipeId,
        title: recipe.title,
        source: relative(repoRoot, sourceDir),
        sourceRecipeId: source.summary.recipeId,
        sourceRunIds: source.summary.runIds,
        regeneratedBy: `yarn --cwd apps/docs capture:recipe-evidence --artifacts-dir ${relative(repoRoot, artifactsDir)} --source-dir ${relative(repoRoot, sourceDir)} --copy-to-docs`,
        copiedToDocs: copyToDocs ? { screenshot: relative(repoRoot, docsScreenshot) } : null,
        publicSafety: { forbiddenPatternsChecked: forbidden.map(String) },
      },
      null,
      2,
    ),
  );
  writeTrace();
}

function writeTrace() {
  writeFileSync(
    resolve(artifactsDir, 'trace.json'),
    JSON.stringify({ version: 1, recipeId, steps: trace }, null, 2),
  );
}

function step(nodeId, status, message, extra = {}) {
  trace.push({ nodeId, status, message, at: new Date().toISOString(), ...extra });
}

function assertSafeText(text) {
  for (const pattern of forbidden) {
    if (pattern.test(text)) throw new Error(`Forbidden public-demo text visible: ${pattern}`);
  }
}

function assertNonEmpty(path, label) {
  if (!existsSync(path) || statSync(path).size === 0)
    throw new Error(`${label} missing or empty: ${path}`);
}

function rel(path) {
  return relative(artifactsDir, path).replaceAll('\\', '/');
}

function gitRef() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
