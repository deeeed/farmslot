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
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const commandCenterDir = resolve(repoRoot, 'apps/command-center');
const defaultRecipe = resolve(
  repoRoot,
  'docs/examples/recipes/farmslot/docusaurus-command-center-parallel-watch.recipe.json',
);
const docsVideo = resolve(
  repoRoot,
  'apps/docs/static/videos/demos/command-center-parallel-watch.mp4',
);
const docsPoster = resolve(
  repoRoot,
  'apps/docs/static/img/demos/command-center-parallel-watch.png',
);
const forbidden = [/wallet address/i];
const cdpPort = Number(process.env.FARMSLOT_DEMO_CDP_PORT || 9324);
const uiUrl = process.env.FARMSLOT_DEMO_UI_URL || 'http://localhost:5174/';
const captureSeconds = Number(process.env.FARMSLOT_DEMO_CAPTURE_SECONDS || 12);
const captureWindowName = process.env.FARMSLOT_DEMO_WINDOW_NAME || 'Farmslot Parallel HUD Capture';
const dispatchRuns = process.env.FARMSLOT_DEMO_DISPATCH !== '0';
const copyToDocs = process.argv.includes('--copy-to-docs');

const args = parseArgs(process.argv.slice(2));
const recipePath = resolve(repoRoot, args.recipe || defaultRecipe);
const artifactsDir = resolve(
  repoRoot,
  args.artifactsDir || '.agent/demo-stage/docusaurus-command-center-parallel/output',
);
const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
const trace = [];
const runIds = [];
let captureSlots = ['demo-work-1', 'demo-ff-1'];
let captureProjects = ['farmslot'];
let captureMachines = ['demo-host', 'farmslot-demo'];
const childProcesses = [];

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

  step('prepare-stage', 'started', 'Preparing public-safe Command Center capture stage');
  await ensureCommandCenter();
  if (dispatchRuns) await ensureDemoRuns();

  step('open-command-center', 'started', 'Opening Command Center in a dedicated Chrome window');
  await ensureChrome();
  await prepareBrowserView();

  step('verify-safe-view', 'started', 'Verifying allowed terminal panes and public-safe text');
  const verification = await verifySafeView();
  step(
    'verify-safe-view',
    'passed',
    `Visible panes=${verification.terminalCount}; forbidden labels absent`,
  );

  const screenshotPath = resolve(artifactsDir, 'screenshots/command-center-parallel-watch.png');
  await captureScreenshot(screenshotPath);

  step(
    'record-proof-window',
    'started',
    `Recording ${captureSeconds}s proof window while steering visible demo panes`,
  );
  const videoPath = resolve(artifactsDir, 'videos/command-center-parallel-watch.mp4');
  await recordWindowWithSteering(videoPath);
  assertNonEmpty(videoPath, 'recorded MP4');

  const afterSteerScreenshotPath = resolve(
    artifactsDir,
    'screenshots/command-center-parallel-watch-after-steer.png',
  );
  await captureScreenshot(afterSteerScreenshotPath);

  const posterPath = resolve(artifactsDir, 'posters/command-center-parallel-watch.png');
  extractPoster(videoPath, posterPath);
  assertNonEmpty(posterPath, 'poster frame');
  step(
    'record-proof-window',
    'passed',
    'Recorded MP4 during terminal steering and extracted poster frame',
  );

  if (copyToDocs) {
    mkdirSync(dirname(docsVideo), { recursive: true });
    mkdirSync(dirname(docsPoster), { recursive: true });
    copyFileSync(videoPath, docsVideo);
    copyFileSync(posterPath, docsPoster);
  }

  step('publish-artifacts', 'passed', 'Writing summary, trace, and artifact manifest');
  writeOutputs({ screenshotPath, afterSteerScreenshotPath, videoPath, posterPath });
  console.log(
    JSON.stringify({ ok: true, artifactsDir, runIds, copiedToDocs: copyToDocs }, null, 2),
  );
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

async function ensureDemoRuns() {
  const active = await gatewayRpc('run.list', { active: true, limit: 100 });
  const fleetBefore = await gatewayRpc('fleet.status', {});
  const slotById = new Map((fleetBefore.fleet?.slots || []).map((slot) => [slot.slot, slot]));

  const plans = [
    {
      project: 'farmslot',
      slotId: 'demo-work-1',
      ticketOrPr: 'https://github.com/deeeed/farmslot/issues/28',
      issueRef: '28',
      initialContext:
        'Demo-only Farmslot issue #28: show debug demo badge during parallel run monitoring.',
    },
    {
      project: 'farmslot',
      slotId: 'demo-ff-1',
      ticketOrPr: `FARMSLOT-DEMO-PARALLEL-WATCH-${new Date()
        .toISOString()
        .replace(/[-:.TZ]/g, '')
        .slice(0, 12)}`,
      issueRef: 'FARMSLOT-DEMO-PARALLEL-WATCH',
      initialContext:
        'Synthetic demo-only Farmslot task: keep a cheap Haiku runner visibly active for Command Center parallel monitoring capture. Do not modify private projects.',
    },
  ];

  const selectedSlots = [];
  for (const plan of plans) {
    const existingForSlot = active.runs?.find(
      (run) => run.slotId === plan.slotId && !['done', 'failed', 'cancelled'].includes(run.status),
    );
    const existingForIssue = active.runs?.find(
      (run) =>
        run.project === plan.project &&
        String(run.initialContext || run.ticketOrPr || '').includes(plan.issueRef),
    );
    const existing = existingForSlot || existingForIssue;
    if (existing) {
      runIds.push(existing.id);
      selectedSlots.push(plan.slotId);
      continue;
    }

    const slot = slotById.get(plan.slotId);
    if (!slot?.dispatchable) {
      step(
        'prepare-stage',
        'skipped',
        `Skipping ${plan.slotId}; slot is not dispatchable and has no active demo run`,
        {
          slotId: plan.slotId,
          lifecycle: slot?.lifecycle,
          agent: slot?.agent,
        },
      );
      continue;
    }

    const result = await gatewayRpc('run.create', {
      flowType: 'dev',
      project: plan.project,
      ticketOrPr: plan.ticketOrPr,
      mode: 'interactive',
      runner: 'claude',
      model: 'haiku',
      slotId: plan.slotId,
      allowedSlots: [plan.slotId],
      skipPrepare: true,
      safetyTier: 'dangerous',
      initialContext: plan.initialContext,
      devChecklist: [
        'Keep this DO NOT MERGE demo task reversible.',
        'Do not expose private work repositories or local secrets.',
        'Stay active long enough for the Docusaurus Command Center video capture.',
      ],
    });
    runIds.push(result.run.id);
    selectedSlots.push(plan.slotId);
  }

  if (selectedSlots.length < 2) {
    throw new Error(
      `Need at least two public-safe demo slots, selected ${selectedSlots.length}: ${selectedSlots.join(', ') || '(none)'}`,
    );
  }
  captureSlots = selectedSlots;
  captureProjects = [
    ...new Set(
      plans.filter((plan) => selectedSlots.includes(plan.slotId)).map((plan) => plan.project),
    ),
  ];
  captureMachines = [
    ...new Set(selectedSlots.map((slotId) => slotById.get(slotId)?.machine).filter(Boolean)),
  ];

  await waitFor(
    async () => {
      const fleet = await gatewayRpc('fleet.status', {});
      const activeSlots = new Set(
        fleet.fleet?.slots
          ?.filter((slot) => selectedSlots.includes(slot.slot) && slot.currentRunId)
          .map((slot) => slot.slot) || [],
      );
      return activeSlots.size >= selectedSlots.length;
    },
    90000,
    `demo run slot assignment (${selectedSlots.join(', ')})`,
  );
}

async function ensureChrome() {
  const targetUrl = `${uiUrl}#terminal?projects=${encodeURIComponent(captureProjects.join(','))}`;
  if (!(await cdpHttpOk())) {
    spawnSync('bash', ['scripts/debug-chrome.sh'], {
      cwd: commandCenterDir,
      env: {
        ...process.env,
        FARMSLOT_CDP_PORT: String(cdpPort),
        FARMSLOT_CDP_PROFILE:
          process.env.FARMSLOT_DEMO_CDP_PROFILE ||
          resolve(repoRoot, '.agent/demo-stage/docusaurus-command-center-parallel/chrome-profile'),
        FARMSLOT_UI_URL: targetUrl,
      },
      stdio: 'inherit',
    });
  }
  await waitFor(() => cdpHttpOk(), 10000, 'Chrome CDP');
  await reuseOrOpenCdpPage(targetUrl);
  await sleep(1500);
}

async function prepareBrowserView() {
  await evalInPage(`
    localStorage.setItem('farmslot:global-filters', JSON.stringify({projects:${JSON.stringify(captureProjects)}, machines:${JSON.stringify(captureMachines)}}));
    localStorage.setItem('farmslot:split-view:slots', JSON.stringify(${JSON.stringify(captureSlots)}));
    localStorage.setItem('farmslot:split-view:layout', '2x2');
    localStorage.setItem('farmslot:terminal-worker-filter', 'farmslot');
    location.href = '${uiUrl}#terminal?projects=${encodeURIComponent(captureProjects.join(','))}&machines=${encodeURIComponent(captureMachines.join(','))}';
    location.reload();
    return true;
  `);
  await sleep(4000);
  await evalInPage(`
    document.title = ${JSON.stringify(captureWindowName)};
    const styleId = 'docusaurus-demo-capture-style';
    document.getElementById(styleId)?.remove();
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = \`
      farm-app > nav, fleet-summary-bar, global-filter-bar, chat-panel { display: none !important; }
      farm-app .fa-main { width: 100vw !important; }
      farm-app .fa-content { height: 100vh !important; }
      terminal-split-view .worker-panel { display: none !important; }
      terminal-split-view .toolbar { border-bottom: 1px solid #30304d; padding-left: 190px; }

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
        position: fixed; top: 10px; left: 14px; z-index: 999999;
        background: #d92323; color: #fff; border: 1px solid #ff8a8a;
        box-shadow: 0 10px 30px rgba(0,0,0,.45); border-radius: 16px; min-width: 360px; max-width: 470px;
        font: 900 12px/1.25 SFMono-Regular, Menlo, monospace; letter-spacing: .04em;
        padding: 10px 14px; text-transform: uppercase; white-space: normal;
      }
    \`;
    document.head.appendChild(style);
    document.getElementById('docusaurus-demo-badge')?.remove();
    const badge = document.createElement('div');
    badge.id = 'docusaurus-demo-badge';
    badge.textContent = 'FARMSLOT DEMO: PARALLEL RUN MONITORING';
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
      ['demo-ff-1', 'demo-work-2'],
      ['ff-1', 'demo-1'],
    ]);
    const sanitizeText = (value) => {
      let next = value;
      for (const [from, to] of replacements) next = next.split(from).join(to);
      next = next.replace(/DEV-FARMSLOT-DEMO-PARALLEL-WATCH-[A-Z0-9-]+/g, 'demo-watch-task');
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
        if (node instanceof HTMLOptionElement) node.textContent = sanitizeText(node.textContent || '');
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
    clearInterval(window.__docusaurusDemoSanitizer);
    window.__docusaurusDemoSanitizer = setInterval(sanitizeDemoLabels, 250);
    history.replaceState(null, '', '#terminal?projects=farmslot&machines=demo-host');
    return {terminalCount: document.querySelectorAll('terminal-view').length, text: document.body.innerText.slice(0, 500)};
  `);
  await sleep(3000);
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

async function verifySafeView() {
  return evalInPage(`
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = Date.now() + 20000;
    let terminalCount = 0;
    while (Date.now() < deadline) {
      const split = document.querySelector('terminal-split-view');
      terminalCount = split?.shadowRoot?.querySelectorAll('terminal-view').length || document.querySelectorAll('terminal-view').length;
      const text = collectVisibleText(document.body);
      if (terminalCount >= 2 && text.includes('FARMSLOT DEMO: PARALLEL RUN MONITORING')) break;
      await sleep(250);
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
    const text = collectVisibleText(document.body);
    return { terminalCount, text: text.slice(0, 20000), hash: location.hash };
  `).then((result) => {
    if (result.terminalCount < 2)
      throw new Error(`Expected at least 2 terminal panes, saw ${result.terminalCount}`);
    for (const pattern of forbidden) {
      if (pattern.test(result.text))
        throw new Error(`Forbidden public-demo text visible: ${pattern}`);
    }
    return result;
  });
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

async function recordWindowWithSteering(output) {
  const args = [
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
  ];
  const child = spawn('capture-helper', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => {
    stdout += String(buf);
  });
  child.stderr.on('data', (buf) => {
    stderr += String(buf);
  });

  await sleep(1200);
  await updateRunnerHud(
    'record-proof-window',
    'running',
    'Recording live terminal panes while the recipe steers visible demo runs.',
    52,
  );
  await steerVisibleDemoPanes();
  await updateRunnerHud(
    'steer-visible-panes',
    'passed',
    'Steering input was sent to live terminal panes; proof video continues recording.',
    82,
  );

  const status = await new Promise((resolvePromise) => {
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
  writeFileSync(resolve(artifactsDir, 'logs/capture-helper-record.log'), `${stdout}\n${stderr}`);
  if (status !== 0) throw new Error(`capture-helper record failed: ${stderr || stdout}`);
}

async function steerVisibleDemoPanes() {
  step(
    'steer-demo-panes',
    'started',
    'Sending visible safe terminal commands and operator prompt during recording',
  );
  const log = resolve(artifactsDir, 'logs/steer-demo-panes.log');
  const commands = [
    ['demo-work-1:dev.1', 'C-c', null],
    ['demo-work-1:dev.1', 'clear', 'Enter'],
    ['demo-work-1:dev.1', 'printf "FARMSLOT DEMO: operator steers a live terminal\\n"', 'Enter'],
    ['demo-work-1:dev.1', 'printf "workspace: farmslot\\n"', 'Enter'],
    ['demo-work-1:dev.1', 'ls docs/plans | grep docusaurus | head -6', 'Enter'],
    [
      'demo-1:dev.1',
      'Demo capture only: briefly acknowledge that Command Center can steer this run live. Do not edit files; then wait.',
      'Enter',
    ],
  ];
  for (const [target, text, key] of commands) {
    sendTmuxKeys(target, text, key);
    appendLog(
      log,
      Buffer.from(`${new Date().toISOString()} ${target} ${text}${key ? ` ${key}` : ''}\n`),
    );
    await sleep(key === 'Enter' ? 1200 : 500);
  }
  await sleep(1800);
  step(
    'steer-demo-panes',
    'passed',
    'Visible terminal steering commands were sent during recording',
  );
}

function sendTmuxKeys(target, text, key) {
  const args = ['send-keys', '-t', target, text];
  if (key) args.push(key);
  const result = spawnSync('tmux', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(`tmux send-keys failed for ${target}: ${result.stderr || result.stdout}`);
}

function extractPoster(videoPath, posterPath) {
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-ss', '00:00:06', '-i', videoPath, '-frames:v', '1', posterPath],
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

function writeOutputs(paths) {
  const artifacts = [
    {
      path: rel(paths.videoPath),
      type: 'video',
      mimeType: 'video/mp4',
      category: 'proof',
      nodeId: 'record-proof-window',
      label: 'Command Center parallel watch video',
    },
    {
      path: rel(paths.posterPath),
      type: 'screenshot',
      mimeType: 'image/png',
      category: 'proof',
      nodeId: 'record-proof-window',
      label: 'Command Center parallel watch poster frame',
    },
    {
      path: rel(paths.screenshotPath),
      type: 'screenshot',
      mimeType: 'image/png',
      category: 'proof',
      nodeId: 'verify-safe-view',
      label: 'Command Center public-safe pre-steer verification screenshot',
    },
    {
      path: rel(paths.afterSteerScreenshotPath),
      type: 'screenshot',
      mimeType: 'image/png',
      category: 'proof',
      nodeId: 'steer-demo-panes',
      label: 'Command Center post-steer verification screenshot',
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
      runner: {
        source: 'apps/docs/scripts/capture-command-center-parallel-watch.mjs',
        git_ref: gitRef(),
      },
    },
    artifacts,
  };
  writeFileSync(
    resolve(artifactsDir, 'trace.json'),
    JSON.stringify({ version: 1, recipeId: recipe.id, steps: trace }, null, 2),
  );
  writeFileSync(resolve(artifactsDir, 'artifact-manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(
    resolve(artifactsDir, 'summary.json'),
    JSON.stringify(
      {
        status: 'pass',
        recipeId: recipe.id,
        title: recipe.title,
        runIds,
        regeneratedBy: `yarn --cwd apps/docs capture:first-video --artifacts-dir ${relative(repoRoot, artifactsDir)} --copy-to-docs`,
        copiedToDocs: copyToDocs
          ? { video: relative(repoRoot, docsVideo), poster: relative(repoRoot, docsPoster) }
          : null,
        publicSafety: { forbiddenPatternsChecked: forbidden.map(String) },
      },
      null,
      2,
    ),
  );
}

function rel(path) {
  return relative(artifactsDir, path).replaceAll('\\\\', '/');
}

function gitRef() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
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
    }, 10000);
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'req',
          id: 'auth',
          method: 'auth.connect',
          params: { clientKind: 'ui', clientName: 'docusaurus-demo-capture' },
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
    ws.addEventListener('error', (event) => {
      clearTimeout(timer);
      rejectPromise(
        new Error(`Gateway RPC ${method} websocket error: ${event.message || 'unknown'}`),
      );
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

async function reuseOrOpenCdpPage(url) {
  const tabs = await listCdpTabs();
  const page =
    tabs.find((tab) => tab.type === 'page' && isCommandCenterTab(tab.url)) ||
    tabs.find((tab) => tab.type === 'page');
  if (page?.webSocketDebuggerUrl) {
    await navigateCdpPage(page.webSocketDebuggerUrl, url);
    return;
  }
  const encoded = encodeURIComponent(url);
  const response = await fetch(`http://localhost:${cdpPort}/json/new?${encoded}`, {
    method: 'PUT',
  });
  if (!response.ok)
    throw new Error(
      `Chrome refused to create capture tab: ${response.status} ${await response.text()}`,
    );
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

async function navigateCdpPage(webSocketDebuggerUrl, url) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const opened = new Promise((resolvePromise, rejectPromise) => {
    ws.addEventListener('open', resolvePromise, { once: true });
    ws.addEventListener(
      'error',
      () => rejectPromise(new Error('CDP websocket failed while opening capture tab')),
      { once: true },
    );
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
    const windowInfo = await call('Browser.getWindowForTarget');
    await call('Browser.setWindowBounds', {
      windowId: windowInfo.windowId,
      bounds: { left: 40, top: 40, width: 1440, height: 900, windowState: 'normal' },
    });
    await call('Page.enable');
    await call('Page.navigate', { url });
  } finally {
    ws.close();
  }
}

async function evalInPage(expression) {
  const script = resolve(commandCenterDir, 'scripts/cdp.mjs');
  const result = spawnSync('node', [script, 'eval', 'terminal', expression], {
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
