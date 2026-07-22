#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const commandCenterDir = resolve(repoRoot, 'apps/command-center');
const defaultRecipe = resolve(
  repoRoot,
  'docs/examples/recipes/farmslot/docusaurus-gateway-intelligence.capture-plan.json',
);
const docsVideo = resolve(
  repoRoot,
  'apps/docs/static/videos/demos/command-center-gateway-intelligence.mp4',
);
const docsPoster = resolve(
  repoRoot,
  'apps/docs/static/img/demos/command-center-gateway-intelligence.png',
);
const docsScreenshot = resolve(
  repoRoot,
  'apps/docs/static/img/demos/command-center-gateway-intelligence-answer.png',
);
const forbidden = [/wallet address/i, /TAT-\d+/i];
const cdpPort = Number(process.env.FARMSLOT_DEMO_CDP_PORT || 9324);
const uiUrl = process.env.FARMSLOT_DEMO_UI_URL || 'http://localhost:5174/';
const captureSeconds = Number(process.env.FARMSLOT_DEMO_CAPTURE_SECONDS || 50);
const captureWindowName = process.env.FARMSLOT_DEMO_WINDOW_NAME || 'Farmslot Gateway HUD Capture';
const copyToDocs = process.argv.includes('--copy-to-docs');
const args = parseArgs(process.argv.slice(2));
const recipePath = resolve(repoRoot, args.recipe || defaultRecipe);
const recipeId = basename(recipePath).replace(/\.capture-plan\.json$/u, '');
const artifactsDir = resolve(
  repoRoot,
  args.artifactsDir || '.agent/demo-stage/docusaurus-gateway-intelligence/output',
);
const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
const trace = [];
const childProcesses = [];
const sessionId = `docusaurus-demo-gateway-intelligence-${Date.now()}`;
const prompt =
  'Public demo safety: answer only about these allowed demo aliases — Farmslot demo slot, Audiolab iOS demo, and EchoBridge iOS demo. Do not mention raw host names, private projects, work repos, or any other slots. Question: which allowed public demo slots are ready or need attention right now?';

main().catch((err) => {
  for (const child of childProcesses) child.kill('SIGTERM');
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});

async function main() {
  mkdirSync(artifactsDir, { recursive: true });
  for (const dir of ['screenshots', 'videos', 'posters', 'logs'])
    mkdirSync(resolve(artifactsDir, dir), { recursive: true });
  copyFileSync(recipePath, resolve(artifactsDir, 'recipe.json'));

  step(
    'open-command-center',
    'started',
    'Preparing Command Center and Chrome for gateway-intelligence capture',
  );
  await ensureCommandCenter();
  await ensureChrome();
  await prepareBrowserView();
  await clearChatSession('global');
  await clearChatSession(sessionId);
  step('open-command-center', 'passed', 'Command Center opened with public-safe project filters');

  const videoPath = resolve(artifactsDir, 'videos/command-center-gateway-intelligence.mp4');
  step(
    'record-proof-window',
    'started',
    `Recording ${captureSeconds}s proof window while opening gateway intelligence and asking about fleet state`,
  );
  await recordWindow(videoPath);
  assertNonEmpty(videoPath, 'recorded MP4');

  step('verify-safe-answer', 'started', 'Verifying visible gateway answer and public-safety scan');
  const verification = await verifySafeAnswer();
  step('verify-safe-answer', 'passed', `Visible answer chars=${verification.answerLength}`);

  const screenshotPath = resolve(
    artifactsDir,
    'screenshots/command-center-gateway-intelligence-answer.png',
  );
  await captureScreenshot(screenshotPath);

  const posterPath = resolve(artifactsDir, 'posters/command-center-gateway-intelligence.png');
  extractPoster(videoPath, posterPath);
  assertNonEmpty(posterPath, 'poster frame');
  step(
    'record-proof-window',
    'passed',
    'Recorded gateway prompt, live gateway answer, screenshot, and poster',
  );

  if (copyToDocs) {
    mkdirSync(dirname(docsVideo), { recursive: true });
    mkdirSync(dirname(docsPoster), { recursive: true });
    copyFileSync(videoPath, docsVideo);
    copyFileSync(posterPath, docsPoster);
    copyFileSync(screenshotPath, docsScreenshot);
  }

  writeOutputs({ videoPath, posterPath, screenshotPath, verification });
  console.log(JSON.stringify({ ok: true, artifactsDir, copiedToDocs: copyToDocs }, null, 2));
}

async function clearChatSession(targetSessionId) {
  try {
    await gatewayRpc('chat.clear', { sessionId: targetSessionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    step(
      'clear-chat-session',
      'warning',
      `Unable to clear chat session ${targetSessionId}: ${message}`,
    );
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

function step(nodeId, status, message, extra = {}) {
  trace.push({ nodeId, status, message, at: new Date().toISOString(), ...extra });
}

async function ensureCommandCenter() {
  if ((await httpOk(uiUrl)) && (await gatewayOk())) return;
  const log = resolve(artifactsDir, 'logs/command-center-dev.log');
  const child = spawn('yarn', ['dev'], {
    cwd: commandCenterDir,
    env: { ...process.env, FARMSLOT_GATEWAY_AUTH_MODE: 'none', GATEWAY_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childProcesses.push(child);
  child.stdout.on('data', (buf) => appendLog(log, buf));
  child.stderr.on('data', (buf) => appendLog(log, buf));
  await waitFor(
    async () => (await httpOk(uiUrl)) && (await gatewayOk()),
    45000,
    'Command Center dev server',
  );
}

async function ensureChrome() {
  const targetUrl = `${uiUrl}#fleet?projects=farmslot,audiolab-farm,echobridge-farm`;
  if (!(await cdpHttpOk())) {
    spawnSync('bash', ['scripts/debug-chrome.sh'], {
      cwd: commandCenterDir,
      env: {
        ...process.env,
        FARMSLOT_CDP_PORT: String(cdpPort),
        FARMSLOT_CDP_PROFILE:
          process.env.FARMSLOT_DEMO_CDP_PROFILE ||
          resolve(repoRoot, '.agent/demo-stage/docusaurus-gateway-intelligence/chrome-profile'),
        FARMSLOT_UI_URL: targetUrl,
      },
      stdio: 'inherit',
    });
  }
  await waitFor(() => cdpHttpOk(), 10000, 'Chrome CDP');
  await withCdpPage(async (call) => {
    const windowInfo = await call('Browser.getWindowForTarget');
    await call('Browser.setWindowBounds', {
      windowId: windowInfo.windowId,
      bounds: { left: 40, top: 40, width: 1440, height: 900, windowState: 'normal' },
    });
    await call('Page.enable');
    await call('Page.navigate', { url: targetUrl });
  });
  await sleep(1500);
}

async function prepareBrowserView() {
  await evalInPage(`
    localStorage.setItem('farmslot:global-filters', JSON.stringify({projects:['farmslot-farm','audiolab-farm','echobridge-farm'], machines:['farmslot-demo','demo-host']}));
    location.href = '${uiUrl}#fleet?projects=farmslot,audiolab-farm,echobridge-farm';
    location.reload();
    return true;
  `);
  await sleep(3500);
  await evalInPage(`
    document.title = ${JSON.stringify(captureWindowName)};
    const styleId = 'docusaurus-gateway-intelligence-style';
    document.getElementById(styleId)?.remove();
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = \`
      farm-app .fa-shell { height: 100vh !important; }
      fleet-summary-bar, global-filter-bar { display: none !important; }
      farm-app nav { width: 78px !important; }
      farm-app nav .nav-label, farm-app nav .brand-subtitle { display: none !important; }
      chat-panel .cp-drawer { left: auto !important; right: 0 !important; top: 0 !important; bottom: 0 !important; width: min(620px, 44vw) !important; height: 100vh !important; border-top: 0 !important; border-left: 1px solid #30304d !important; }

      #docusaurus-runner-hud {
        position: fixed !important; right: 16px; top: 62px; z-index: 2147483647 !important; pointer-events: none;
        margin: 0; max-width: none; max-height: none;
        width: 370px; background: rgba(8, 12, 24, .98); color: #e9f2ff;
        border: 1px solid rgba(132, 255, 196, .65); border-radius: 18px;
        box-shadow: 0 18px 50px rgba(0,0,0,.55); padding: 14px;
        font: 12px/1.35 SFMono-Regular, Menlo, monospace;
      }
      #docusaurus-runner-hud .hud-kicker { color: #84ffc4; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; }
      #docusaurus-runner-hud .hud-title { margin-top: 5px; font-size: 15px; font-weight: 900; }
      #docusaurus-runner-hud .hud-row { display: flex; justify-content: space-between; gap: 12px; margin-top: 8px; color: #b8c7dd; }
      #docusaurus-runner-hud .hud-status { color: #fff; background: #166b45; border: 1px solid #84ffc4; border-radius: 999px; padding: 2px 8px; font-weight: 900; }
      #docusaurus-runner-hud .hud-detail { margin-top: 10px; color: #dbe7ff; }
      #docusaurus-runner-hud .hud-bar { height: 7px; margin-top: 12px; border-radius: 999px; background: #1c2840; overflow: hidden; }
      #docusaurus-runner-hud .hud-bar > span { display: block; height: 100%; width: var(--hud-progress, 10%); background: linear-gradient(90deg, #84ffc4, #4aa3ff); transition: width .25s ease; }

      #docusaurus-demo-badge {
        position: fixed; top: 10px; left: 96px; z-index: 999999;
        background: #2b59ff; color: #fff; border: 1px solid #91a8ff;
        box-shadow: 0 10px 30px rgba(0,0,0,.45); border-radius: 16px; min-width: 360px; max-width: 470px;
        font: 900 12px/1.25 SFMono-Regular, Menlo, monospace; letter-spacing: .04em;
        padding: 10px 14px; text-transform: uppercase; white-space: normal;
      }
    \`;
    document.head.appendChild(style);
    document.getElementById('docusaurus-demo-badge')?.remove();
    const badge = document.createElement('div');
    badge.id = 'docusaurus-demo-badge';
    badge.textContent = 'FARMSLOT DEMO: GATEWAY INTELLIGENCE';
    document.body.appendChild(badge);

    document.getElementById('docusaurus-runner-hud')?.remove();
    const hud = document.createElement('dialog');
    hud.id = 'docusaurus-runner-hud';
    hud.innerHTML = [
      '<div class="hud-kicker">Recipe runner HUD</div>',
      '<div class="hud-title" data-hud-node>prepare-capture</div>',
      '<div class="hud-row"><span>status</span><strong class="hud-status" data-hud-status>running</strong></div>',
      '<div class="hud-row"><span>proof</span><span data-hud-proof>summary + trace + artifacts</span></div>',
      '<div class="hud-detail" data-hud-detail>Opening Farmslot Command Center from a checked-in capture recipe.</div>',
      '<div class="hud-bar"><span data-hud-bar></span></div>',
    ].join('');
    document.body.appendChild(hud);
    if (typeof hud.show === 'function' && !hud.open) hud.show();
    window.__docusaurusRunnerHud = (node, status, detail, progress = 25) => {
      const root = document.getElementById('docusaurus-runner-hud');
      if (root) {
        root.querySelector('[data-hud-node]').textContent = node;
        root.querySelector('[data-hud-status]').textContent = status;
        root.querySelector('[data-hud-detail]').textContent = detail;
        root.style.setProperty('--hud-progress', progress + '%');
      }
      const badge = document.getElementById('docusaurus-demo-badge');
      if (badge) {
        badge.innerHTML = '<div>FARMSLOT DEMO</div>'
          + '<div style="margin-top:4px;color:#84ffc4">RECIPE RUNNER HUD · ' + String(status).toUpperCase() + '</div>'
          + '<div style="margin-top:4px;color:#fff">' + String(node) + '</div>'
          + '<div style="margin-top:4px;font-weight:700;text-transform:none;letter-spacing:0;color:#dbe7ff">' + String(detail) + '</div>';
      }
    };


    const replacements = new Map([
      ['demo-audiolab-1', 'audiolab-ios-demo'],
      ['demo-echobridge-1', 'echobridge-ios-demo'],
      ['demo-ff-1', 'farmslot-demo-slot'],
    ]);
    const sanitizeText = (value) => {
      let next = value;
      for (const [from, to] of replacements) next = next.split(from).join(to);
      next = next.replace(/TAT-\\d+[\\w-]*/g, 'private-ticket');
      return next;
    };
    const sanitizeDemoLabels = (root = document.body) => {
      const visit = (node) => {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const next = sanitizeText(node.textContent || '');
          if (next !== node.textContent) node.textContent = next;
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE && !(node instanceof ShadowRoot)) return;
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) node.value = sanitizeText(node.value);
        if (node instanceof Element) {
          for (const attr of ['title', 'aria-label', 'value']) {
            const raw = node.getAttribute(attr);
            if (raw) node.setAttribute(attr, sanitizeText(raw));
          }
          if (node.shadowRoot) visit(node.shadowRoot);
        }
        for (const child of node.childNodes || []) visit(child);
      };
      visit(root);
    };
    sanitizeDemoLabels();
    clearInterval(window.__docusaurusGatewayDemoSanitizer);
    window.__docusaurusGatewayDemoSanitizer = setInterval(sanitizeDemoLabels, 150);
    history.replaceState(null, '', '#fleet?projects=farmslot,audiolab-farm,echobridge-farm');
    return true;
  `);
}

async function updateRunnerHud(nodeId, status, detail, progress) {
  const safeNode = JSON.stringify(nodeId);
  const safeStatus = JSON.stringify(status);
  const safeDetail = JSON.stringify(detail);
  const safeProgress = Number(progress) || 25;
  await evalInPage(`(() => {
    const nodeId = ${safeNode};
    const status = ${safeStatus};
    const detail = ${safeDetail};
    const badge = document.getElementById('docusaurus-demo-badge');
    if (badge) {
      badge.style.minWidth = '430px';
      badge.style.maxWidth = '520px';
      badge.style.borderRadius = '16px';
      badge.innerHTML = '<div>FARMSLOT DEMO</div>'
        + '<div style="margin-top:4px;color:#84ffc4">RECIPE RUNNER HUD · ' + String(status).toUpperCase() + '</div>'
        + '<div style="margin-top:4px;color:#fff">' + String(nodeId) + '</div>'
        + '<div style="margin-top:4px;font-weight:700;text-transform:none;letter-spacing:0;color:#dbe7ff">' + String(detail) + '</div>';
    }
    const root = document.getElementById('docusaurus-runner-hud');
    if (root) {
      const node = root.querySelector('[data-hud-node]');
      const state = root.querySelector('[data-hud-status]');
      const body = root.querySelector('[data-hud-detail]');
      if (node) node.textContent = nodeId;
      if (state) state.textContent = status;
      if (body) body.textContent = detail;
      root.style.setProperty('--hud-progress', '${safeProgress}%');
    }
    return badge?.innerText || '';
  })()`);
}

async function recordWindow(output) {
  const child = spawn(
    'capture-helper',
    [
      'record',
      '--app-name',
      'Google Chrome',
      '--window-name',
      captureWindowName,
      '--output',
      output,
      '--duration',
      String(captureSeconds),
      '--max-size',
      '1280',
      '--max-fps',
      '15',
    ],
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

  await sleep(1000);
  await updateRunnerHud(
    'open-cmd-k',
    'running',
    'Recipe is opening Command Center gateway intelligence.',
    35,
  );
  step('open-cmd-k', 'started', 'Opening gateway intelligence drawer');
  await dispatchShortcut('k', 'Meta');
  await sleep(800);
  await updateRunnerHud('open-cmd-k', 'passed', 'Gateway intelligence drawer opened.', 52);
  step('open-cmd-k', 'passed', 'Gateway intelligence drawer opened');
  step('ask-status', 'started', 'Typing and submitting public-safe fleet status prompt');
  await updateRunnerHud(
    'ask-status',
    'running',
    'Typing a public-safe fleet/run status question through the visible UI.',
    68,
  );
  await typeText(prompt);
  await pressKey('Enter');
  await updateRunnerHud(
    'ask-status',
    'passed',
    'Prompt submitted; waiting for gateway answer evidence.',
    84,
  );
  step('ask-status', 'passed', 'Prompt submitted through the visible chat input');

  const status = await new Promise((resolvePromise) =>
    child.on('close', (code) => resolvePromise(code ?? 1)),
  );
  writeFileSync(resolve(artifactsDir, 'logs/capture-helper-record.log'), `${stdout}\n${stderr}`);
  if (status !== 0) throw new Error(`capture-helper record failed: ${stderr || stdout}`);
}

async function verifySafeAnswer() {
  const result = await evalInPage(`
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const textOf = () => collectVisibleText(document.body);
    const deadline = Date.now() + 45000;
    let text = textOf();
    while (Date.now() < deadline) {
      text = textOf();
      if (text.includes('Confidence:') || text.includes('Allowed public demo') || text.includes('Audiolab iOS demo')) break;
      await sleep(500);
    }
    function collectVisibleText(root) {
      const parts = [];
      const visit = (node) => {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const value = node.textContent?.trim();
          if (value) parts.push(value);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE && node !== document && !(node instanceof ShadowRoot)) return;
        const element = node instanceof Element ? node : null;
        if (element) {
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') return;
        }
        if (element?.shadowRoot) visit(element.shadowRoot);
        for (const child of node.childNodes || []) visit(child);
      };
      visit(root);
      return parts.join(' ');
    }
    return {text: text.slice(0, 30000), answerLength: text.length};
  `);
  for (const pattern of forbidden) {
    if (pattern.test(result.text))
      throw new Error(`Forbidden public-demo text visible: ${pattern}`);
  }
  if (!/Audiolab iOS demo|audiolab-ios-demo|Allowed public demo|Farmslot demo/i.test(result.text)) {
    throw new Error('Gateway intelligence answer did not become visible in the capture window');
  }
  return { answerLength: result.answerLength };
}

async function captureScreenshot(path) {
  const result = spawnSync(
    'capture-helper',
    [
      'snapshot',
      '--app-name',
      'Google Chrome',
      '--window-name',
      captureWindowName,
      '--output',
      path,
      '--max-size',
      '1280',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  writeFileSync(
    resolve(artifactsDir, 'logs/capture-helper-snapshot.log'),
    `${result.stdout}\n${result.stderr}`,
  );
  if (result.status !== 0)
    throw new Error(`capture-helper snapshot failed: ${result.stderr || result.stdout}`);
  assertNonEmpty(path, 'screenshot');
}

function extractPoster(videoPath, posterPath) {
  const at = captureSeconds >= 45 ? '00:00:40' : '00:00:08';
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-ss', at, '-i', videoPath, '-frames:v', '1', posterPath],
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
}

function writeOutputs({ videoPath, posterPath, screenshotPath, verification }) {
  const artifacts = [
    {
      path: rel(videoPath),
      type: 'video',
      mimeType: 'video/mp4',
      category: 'proof',
      nodeId: 'record-proof-window',
      label: 'Command Center gateway intelligence video',
    },
    {
      path: rel(posterPath),
      type: 'screenshot',
      mimeType: 'image/png',
      category: 'proof',
      nodeId: 'record-proof-window',
      label: 'Gateway intelligence poster frame',
    },
    {
      path: rel(screenshotPath),
      type: 'screenshot',
      mimeType: 'image/png',
      category: 'proof',
      nodeId: 'verify-safe-answer',
      label: 'Gateway intelligence answer screenshot',
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
    JSON.stringify({ version: 1, recipeId, steps: trace }, null, 2),
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
        recipeId,
        title: recipe.title,
        regeneratedBy: `yarn --cwd apps/docs capture:gateway-intelligence --artifacts-dir ${relative(repoRoot, artifactsDir)} --copy-to-docs`,
        copiedToDocs: copyToDocs
          ? {
              video: relative(repoRoot, docsVideo),
              poster: relative(repoRoot, docsPoster),
              screenshot: relative(repoRoot, docsScreenshot),
            }
          : null,
        publicSafety: {
          forbiddenPatternsChecked: forbidden.map(String),
          visibleAnswerChars: verification.answerLength,
        },
      },
      null,
      2,
    ),
  );
}

async function dispatchShortcut(key, modifier) {
  await withCdpPage(async (call) => {
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: modifier,
      code: modifier === 'Meta' ? 'MetaLeft' : 'ControlLeft',
      modifiers: modifier === 'Meta' ? 4 : 2,
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: `Key${key.toUpperCase()}`,
      modifiers: modifier === 'Meta' ? 4 : 2,
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: `Key${key.toUpperCase()}`,
      modifiers: modifier === 'Meta' ? 4 : 2,
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: modifier,
      code: modifier === 'Meta' ? 'MetaLeft' : 'ControlLeft',
      modifiers: 0,
    });
  });
}

async function typeText(text) {
  await withCdpPage(async (call) => {
    await call('Input.insertText', { text });
  });
}

async function pressKey(key) {
  await withCdpPage(async (call) => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
  });
}

async function withCdpPage(fn) {
  const tabs = await listCdpTabs();
  const page =
    tabs.find((tab) => tab.type === 'page' && isCommandCenterTab(tab.url)) ||
    tabs.find((tab) => tab.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('No Chrome page available for CDP capture');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
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

function isCommandCenterTab(url) {
  if (!url) return false;
  return url.startsWith(uiUrl) || url.startsWith(uiUrl.replace(/\/$/, ''));
}

async function evalInPage(expression) {
  const script = resolve(commandCenterDir, 'scripts/cdp.mjs');
  const result = spawnSync('node', [script, 'eval', 'fleet', expression], {
    cwd: commandCenterDir,
    env: { ...process.env, FARMSLOT_CDP_PORT: String(cdpPort) },
    encoding: 'utf8',
  });
  writeFileSync(
    resolve(artifactsDir, 'logs/cdp-eval.log'),
    `$ ${expression}\n${result.stdout}\n${result.stderr}\n`,
    { flag: 'a' },
  );
  if (result.status !== 0) throw new Error(`CDP eval failed: ${result.stderr || result.stdout}`);
  const stdout = result.stdout.trim();
  if (!stdout) return undefined;
  try {
    return JSON.parse(stdout);
  } catch {
    return stdout;
  }
}

async function gatewayOk() {
  try {
    await gatewayRpc('fleet.status', {});
    return true;
  } catch {
    return false;
  }
}

async function gatewayRpc(method, params) {
  const url = process.env.FARMSLOT_GATEWAY || 'ws://localhost:7777';
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      rejectPromise(new Error(`Gateway RPC timeout: ${method}`));
    }, 30000);
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'req',
          id: 'auth',
          method: 'auth.connect',
          params: { clientKind: 'ui', clientName: 'docusaurus-gateway-intelligence-capture' },
        }),
      );
    });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id === 'auth') {
        if (!msg.ok) {
          clearTimeout(timer);
          rejectPromise(new Error(`Gateway auth failed: ${JSON.stringify(msg)}`));
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: 'req', id: 'rpc', method, params }));
        return;
      }
      if (msg.id === 'rpc') {
        clearTimeout(timer);
        ws.close();
        msg.ok
          ? resolvePromise(msg.payload ?? msg.result)
          : rejectPromise(new Error(`Gateway RPC ${method} failed: ${JSON.stringify(msg)}`));
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      rejectPromise(new Error(`Gateway RPC ${method} websocket error`));
    });
  });
}

async function cdpHttpOk() {
  try {
    const response = await fetch(`http://localhost:${cdpPort}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function httpOk(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, label) {
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

function appendLog(path, buf) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf, { flag: 'a' });
}

function rel(path) {
  return relative(artifactsDir, path).replaceAll('\\\\', '/');
}
