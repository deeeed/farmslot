#!/usr/bin/env node
/**
 * Farmslot Command Center Recipe v1 runner — CDP UI transport + core adapters.
 *
 * Usage:
 *   node apps/command-center/scripts/agentic/run-recipe.mjs <recipe.json> \
 *     --artifacts-dir <dir> \
 *     --action-manifest <manifest.json> \
 *     [--project-root <dir>] \
 *     [--cdp-port <port>] \
 *     [--ui-url <url>] \
 *     [--gateway-port <port>] \
 *     [--slot-id <id>] \
 *     [--slow <ms>] \
 *     [--record-video=full-run] \
 *     [--json]
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { getRecipeActionManifestActionNames } from '@farmslot/protocol';
import {
  createCaptureHelperVideoRecorder,
  createCdpVideoRecorder,
  createRecipeRunner,
} from '@farmslot/recipe-harness';
import { createStandardCoreAdapters } from '@farmslot/recipe-harness/adapters/core';
import { createStandardUiAdapters } from '@farmslot/recipe-harness/adapters/ui';
import {
  CdpWebPage,
  createCdpWebUiTransport,
  listCdpTargets,
} from '@farmslot/recipe-harness/runtime/cdp';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const options = {
    artifactsDir: '',
    actionManifest: '',
    projectRoot: REPO_ROOT,
    cdpPort: Number(process.env.FARMSLOT_CDP_PORT ?? 9323),
    uiUrl: process.env.FARMSLOT_UI_URL ?? '',
    gatewayPort: process.env.GATEWAY_PORT ?? '',
    slotId: process.env.FARMSLOT_SLOT_ID ?? '',
    slowMs: 0,
    recordVideo: false,
    recordMaxFps: 15,
    recordMaxSize: 1080,
    recordAppName: process.env.FARMSLOT_RECORD_APP_NAME ?? 'Google Chrome',
    recordWindowName: process.env.FARMSLOT_RECORD_WINDOW_NAME ?? '',
    recordPid: 0,
    json: false,
    inputs: {},
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--artifacts-dir') {
      options.artifactsDir = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--artifacts-dir=')) {
      options.artifactsDir = arg.slice('--artifacts-dir='.length);
      continue;
    }
    if (arg === '--action-manifest') {
      options.actionManifest = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--action-manifest=')) {
      options.actionManifest = arg.slice('--action-manifest='.length);
      continue;
    }
    if (arg === '--project-root') {
      options.projectRoot = path.resolve(argv[++i] ?? '.');
      continue;
    }
    if (arg.startsWith('--project-root=')) {
      options.projectRoot = path.resolve(arg.slice('--project-root='.length));
      continue;
    }
    if (arg === '--cdp-port') {
      options.cdpPort = Number(argv[++i]);
      continue;
    }
    if (arg.startsWith('--cdp-port=')) {
      options.cdpPort = Number(arg.slice('--cdp-port='.length));
      continue;
    }
    if (arg === '--ui-url') {
      options.uiUrl = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--ui-url=')) {
      options.uiUrl = arg.slice('--ui-url='.length);
      continue;
    }
    if (arg === '--gateway-port') {
      options.gatewayPort = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--gateway-port=')) {
      options.gatewayPort = arg.slice('--gateway-port='.length);
      continue;
    }
    if (arg === '--slot-id') {
      options.slotId = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--slot-id=')) {
      options.slotId = arg.slice('--slot-id='.length);
      continue;
    }
    if (arg === '--slow') {
      options.slowMs = Number(argv[++i]);
      continue;
    }
    if (arg.startsWith('--slow=')) {
      options.slowMs = Number(arg.slice('--slow='.length));
      continue;
    }
    if (arg === '--record-video' || arg === '--record-video=full-run') {
      options.recordVideo = true;
      continue;
    }
    if (arg === '--record-max-fps') {
      options.recordMaxFps = Number(argv[++i]);
      continue;
    }
    if (arg.startsWith('--record-max-fps=')) {
      options.recordMaxFps = Number(arg.slice('--record-max-fps='.length));
      continue;
    }
    if (arg === '--record-max-size') {
      options.recordMaxSize = Number(argv[++i]);
      continue;
    }
    if (arg.startsWith('--record-max-size=')) {
      options.recordMaxSize = Number(arg.slice('--record-max-size='.length));
      continue;
    }
    if (arg === '--record-app-name') {
      options.recordAppName = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--record-app-name=')) {
      options.recordAppName = arg.slice('--record-app-name='.length);
      continue;
    }
    if (arg === '--record-window-name') {
      options.recordWindowName = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--record-window-name=')) {
      options.recordWindowName = arg.slice('--record-window-name='.length);
      continue;
    }
    if (arg === '--record-pid') {
      options.recordPid = Number(argv[++i]);
      continue;
    }
    if (arg.startsWith('--record-pid=')) {
      options.recordPid = Number(arg.slice('--record-pid='.length));
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg.startsWith('--input=')) {
      const pair = arg.slice('--input='.length);
      const idx = pair.indexOf('=');
      if (idx > 0) options.inputs[pair.slice(0, idx)] = pair.slice(idx + 1);
      continue;
    }
    if (arg === '--input') {
      const pair = argv[++i] ?? '';
      const idx = pair.indexOf('=');
      if (idx > 0) options.inputs[pair.slice(0, idx)] = pair.slice(idx + 1);
      continue;
    }
    if (arg.startsWith('-')) die(`Unknown option: ${arg}`);
    positional.push(arg);
  }

  if (!positional[0]) die('Missing recipe path.');
  if (!options.artifactsDir) die('Missing --artifacts-dir.');
  if (!options.actionManifest) die('Missing --action-manifest.');
  if (!Number.isInteger(options.cdpPort) || options.cdpPort <= 0) {
    die(`Invalid --cdp-port: ${options.cdpPort}`);
  }

  return {
    recipePath: path.resolve(positional[0]),
    options,
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function resolveUiUrl(projectRoot, explicit) {
  if (explicit) return explicit.replace(/\/$/, '');
  const portEnv = path.join(projectRoot, '.env.ports');
  try {
    const raw = await readFile(portEnv, 'utf8');
    const match = raw.match(/^VITE_PORT=(\d+)/m);
    if (match) return `http://localhost:${match[1]}`;
  } catch {
    // .env.ports is optional outside sandbox worktrees.
  }
  return 'http://localhost:5174';
}

function substituteTemplateString(value, inputs) {
  return value.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_, key) => {
    if (inputs[key] !== undefined && inputs[key] !== null) return String(inputs[key]);
    return `{{${key}}}`;
  });
}

function substituteDeep(value, inputs) {
  if (typeof value === 'string') return substituteTemplateString(value, inputs);
  if (Array.isArray(value)) return value.map((entry) => substituteDeep(entry, inputs));
  if (value && typeof value === 'object') {
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = substituteDeep(entry, inputs);
    }
    return next;
  }
  return value;
}

function hashFromNavigateTarget(target) {
  if (!target || typeof target !== 'string') return '';
  const hashIndex = target.indexOf('#');
  if (hashIndex < 0) return '';
  return target.slice(hashIndex);
}

function normalizeNavigateUrl(target, uiBaseUrl) {
  if (!target || typeof target !== 'string') return target;
  if (target.startsWith('http://') || target.startsWith('https://')) return target;
  const base = uiBaseUrl.replace(/\/$/, '');
  if (target.startsWith('#')) return `${base}/${target}`;
  if (target.startsWith('/')) return `${base}${target}`;
  return `${base}/#${target.replace(/^#/, '')}`;
}

async function fetchOk(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  return response.ok;
}

function buildPreconditions({ uiUrl, gatewayPort, cdpPort }) {
  return [
    {
      id: 'command_center.dev_server.ready',
      async execute() {
        const ok = await fetchOk(`${uiUrl}/`);
        return {
          ok,
          error: ok ? undefined : `UI not reachable at ${uiUrl}`,
        };
      },
    },
    {
      id: 'gateway.reachable',
      async execute() {
        if (!gatewayPort) return { ok: true };
        const ok = await fetchOk(`http://127.0.0.1:${gatewayPort}/health`);
        return {
          ok,
          error: ok ? undefined : `Gateway not healthy on :${gatewayPort}`,
        };
      },
    },
    {
      id: 'runtime.browser.open',
      async execute() {
        try {
          await listCdpTargets('127.0.0.1', cdpPort);
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, error: message };
        }
      },
    },
  ];
}

function wrapTransportWithSlow(transport, slowMs) {
  if (!slowMs || slowMs <= 0) return transport;
  return {
    async execute(action, node, context) {
      const result = await transport.execute(action, node, context);
      await new Promise((resolve) => setTimeout(resolve, slowMs));
      return result;
    },
  };
}

function wrapTransportNavigate(transport, uiBaseUrl) {
  return {
    async execute(action, node, context) {
      if (action === 'ui.navigate') {
        const rawTarget = node.url ?? node.target;
        const normalized = normalizeNavigateUrl(
          typeof rawTarget === 'string' ? rawTarget : String(rawTarget ?? ''),
          uiBaseUrl,
        );
        return transport.execute(action, { ...node, url: normalized, target: normalized }, context);
      }
      return transport.execute(action, node, context);
    },
  };
}

async function connectPage(cdpPort, preferredHash) {
  const targets = await listCdpTargets('127.0.0.1', cdpPort);
  const pages = targets.filter((target) => target.type === 'page');
  if (pages.length === 0) {
    throw new Error(`No CDP page targets on :${cdpPort}. Launch debug Chrome first.`);
  }

  let selected = pages[0];
  if (preferredHash) {
    const needle = preferredHash.startsWith('#') ? preferredHash : `#${preferredHash}`;
    const matched = pages.find((target) => target.url?.includes(needle));
    if (matched) selected = matched;
  }

  return CdpWebPage.connectToTarget(selected);
}

async function pidListeningOnPort(port) {
  try {
    const { stdout } = await execFileAsync('lsof', [`-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    const pid = Number(stdout.trim().split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function resolveWebVideoRecorder(cdpPort, captureHelperPath) {
  const captureRecorder = createCaptureHelperVideoRecorder({ captureHelperPath });
  const captureDoctor = await captureRecorder.doctor?.();
  if (captureDoctor?.ok) return captureRecorder;
  const cdpRecorder = createCdpVideoRecorder({ cdpPort, urlIncludes: '#fleet' });
  const cdpDoctor = await cdpRecorder.doctor();
  if (cdpDoctor.ok) {
    console.warn(
      `[run-recipe] capture-helper unavailable (${captureDoctor?.code ?? 'unknown'}); using ${cdpRecorder.name}`,
    );
    return cdpRecorder;
  }
  throw new Error(
    `No web video recorder available: capture-helper (${captureDoctor?.message ?? 'unknown'}); CDP (${cdpDoctor.message})`,
  );
}

export async function resolveRecordingTarget(options, deps = {}) {
  const pidOnPort = deps.pidListeningOnPort ?? pidListeningOnPort;
  const captureTarget = deps.resolveCaptureHelperTarget ?? resolveCaptureHelperTarget;
  if (options.recordPid > 0) {
    return { kind: 'pid', pid: options.recordPid };
  }
  // Only an EXPLICITLY configured window name may pick a window by title. The old
  // default 'Farmslot Command Center' is shared by every slot's UI and the operator's
  // own browser tabs, so matching it implicitly recorded the wrong window (e.g. ff-2's
  // recipe video captured mme-5). Without an explicit name we anchor on the recipe's
  // own CDP Chrome (cdpPort) — deterministic and slot-specific.
  const explicitWindowName =
    options.recordWindowName || process.env.FARMSLOT_RECORD_WINDOW_NAME || '';
  const appName = options.recordAppName;
  if (explicitWindowName) {
    try {
      const parsed = await captureTarget([
        '--app-name',
        appName,
        '--window-name',
        explicitWindowName,
      ]);
      if (parsed.selected?.id != null) {
        return { kind: 'window-id', windowId: String(parsed.selected.id) };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[run-recipe] capture-helper window resolve failed (${explicitWindowName}): ${message}`,
      );
    }
  }
  const cdpPid = await pidOnPort(options.cdpPort);
  if (cdpPid) return { kind: 'pid', pid: cdpPid };
  return {
    kind: 'app-window',
    appName,
    windowName: explicitWindowName || 'Farmslot Command Center',
  };
}

function parseCaptureHelperJson(stdout, stderr = '') {
  const combined = `${stdout}\n${stderr}`.trim();
  if (!combined) return null;
  const lines = combined.split('\n').map((line) => line.trim());
  const singleLine = lines.find((line) => line.startsWith('{') && line.endsWith('}'));
  if (singleLine) {
    try {
      return JSON.parse(singleLine);
    } catch {
      // fall through
    }
  }
  const start = combined.indexOf('{');
  const end = combined.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(combined.slice(start, end + 1));
  } catch {
    return null;
  }
}

function captureHelperBin() {
  return (
    process.env.CAPTURE_HELPER_PATH ?? process.env.SITEED_CAPTURE_HELPER_BIN ?? 'capture-helper'
  );
}

async function resolveCaptureHelperTarget(selectorArgs) {
  const { stdout, stderr } = await execFileAsync(captureHelperBin(), [
    'resolve',
    ...selectorArgs,
    '--json',
  ]);
  const parsed = parseCaptureHelperJson(stdout, stderr);
  if (!parsed) {
    throw new Error(`${stdout}\n${stderr}`.trim() || 'capture-helper resolve returned no JSON');
  }
  return parsed;
}

async function activateCdpChromeWindow(bounds = { x: 200, y: 150, width: 1200, height: 800 }) {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  await execFileAsync('osascript', [
    '-e',
    'tell application "Google Chrome" to activate',
    '-e',
    `tell application "Google Chrome" to set index of front window to 1`,
    '-e',
    `tell application "Google Chrome" to set bounds of front window to {${bounds.x}, ${bounds.y}, ${right}, ${bottom}}`,
  ]);
}

async function repositionCdpChromeWindow(bounds = { x: 200, y: 150, width: 1200, height: 800 }) {
  await activateCdpChromeWindow(bounds);
}

/** capture-helper cannot record off-screen windows; bring Chrome on-screen before record.video. */
async function ensureCapturableRecordingTarget(target) {
  if (process.platform !== 'darwin') return target;

  const selectorArgs =
    target.kind === 'pid'
      ? ['--pid', String(target.pid)]
      : target.kind === 'window-id'
        ? ['--window-id', target.windowId]
        : ['--app-name', target.appName, '--window-name', target.windowName];

  try {
    await activateCdpChromeWindow();
    await new Promise((resolve) => setTimeout(resolve, 400));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parsed = await resolveCaptureHelperTarget(selectorArgs);
      if (parsed.selected?.onScreen === true) {
        if (parsed.selected?.id != null) {
          return { kind: 'window-id', windowId: String(parsed.selected.id) };
        }
        return target;
      }

      console.warn(
        `[run-recipe] CDP Chrome window is off-screen (${parsed.selected?.title ?? 'unknown'}); repositioning for capture-helper (attempt ${attempt + 1}/3)`,
      );
      await repositionCdpChromeWindow({
        x: 200 + attempt * 40,
        y: 150 + attempt * 40,
        width: 1200,
        height: 800,
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
    }

    const finalResolve = await resolveCaptureHelperTarget(selectorArgs);
    if (finalResolve.selected?.id != null) {
      console.warn(
        `[run-recipe] using window-id ${finalResolve.selected.id} for capture-helper after reposition attempts`,
      );
      return { kind: 'window-id', windowId: String(finalResolve.selected.id) };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[run-recipe] capture target preflight skipped: ${message}`);
  }
  return target;
}

async function main() {
  const { recipePath, options } = parseArgs(process.argv.slice(2));
  const uiUrl = await resolveUiUrl(options.projectRoot, options.uiUrl);
  const recipeRaw = await readJson(recipePath);
  const manifest = await readJson(
    path.isAbsolute(options.actionManifest)
      ? options.actionManifest
      : path.resolve(options.projectRoot, options.actionManifest),
  );

  const farmslotDir =
    process.env.FARMSLOT_DIR ??
    (path.isAbsolute(options.actionManifest)
      ? path.resolve(path.dirname(options.actionManifest), '../../..')
      : path.resolve(options.projectRoot));
  const inputs = {
    ...((recipeRaw.inputs && typeof recipeRaw.inputs === 'object' && recipeRaw.inputs) || {}),
    ui_url: uiUrl,
    cdp_port: String(options.cdpPort),
    repo: options.projectRoot,
    farmslot_dir: farmslotDir,
    primary_repo: farmslotDir,
    ...options.inputs,
  };
  if (options.gatewayPort) {
    inputs.gateway_port = options.gatewayPort;
    inputs.gateway_url = `ws://127.0.0.1:${options.gatewayPort}/ws`;
  }
  if (options.slotId) {
    inputs.slot_id = options.slotId;
  }

  const recipeDocument = substituteDeep(recipeRaw, inputs);
  const artifactsDir = path.resolve(options.artifactsDir);
  await mkdir(artifactsDir, { recursive: true });

  const coreActions = [
    'end',
    'wait',
    'command',
    'assert_file',
    'assert_json',
    'assert_exit_code',
    'assert_output',
    'watch_logs',
    'index_artifacts',
    'state_read',
    'switch',
    'manual',
    'call',
  ];
  const uiActions = [
    'ui.navigate',
    'ui.press',
    'ui.key_press',
    'ui.set_input',
    'ui.scroll',
    'ui.wait_for',
    'ui.screenshot',
    'app.status',
    'app.lifecycle',
    'app.hud',
    'app.trace',
  ];
  const implementedActions = new Set([...coreActions, ...uiActions]);
  const filteredManifest = {
    ...manifest,
    supported_official_actions: getRecipeActionManifestActionNames(manifest).filter((action) =>
      implementedActions.has(action),
    ),
    pre_conditions: (manifest.pre_conditions ?? []).filter((entry) =>
      ['command_center.dev_server.ready', 'gateway.reachable', 'runtime.browser.open'].includes(
        entry.id,
      ),
    ),
  };

  let preferredHash = '';
  const cdpTransport = createCdpWebUiTransport({
    async getPage(input) {
      if (input.action === 'ui.navigate') {
        preferredHash = hashFromNavigateTarget(String(input.node.url ?? input.node.target ?? ''));
      }
      return connectPage(options.cdpPort, preferredHash);
    },
  });

  const transport = wrapTransportWithSlow(
    wrapTransportNavigate(cdpTransport, uiUrl),
    options.slowMs,
  );

  const webVideoRecorder = options.recordVideo
    ? await resolveWebVideoRecorder(options.cdpPort, captureHelperBin())
    : undefined;
  let recordingTarget = options.recordVideo ? await resolveRecordingTarget(options) : undefined;
  if (recordingTarget && webVideoRecorder?.name === 'capture-helper') {
    recordingTarget = await ensureCapturableRecordingTarget(recordingTarget);
  }

  const hudEnabled = filteredManifest.supported_official_actions.includes('app.hud');
  const runner = createRecipeRunner({
    actionManifest: filteredManifest,
    adapters: [
      ...createStandardUiAdapters({
        transport,
        actions: filteredManifest.supported_official_actions,
      }),
      ...createStandardCoreAdapters({
        actions: filteredManifest.supported_official_actions,
      }),
    ],
    hud: hudEnabled
      ? {
          title: 'Command Center recipe',
          display: {
            layout: 'docked-bottom',
            position: 'bottom',
            showTitle: false,
            showDebug: false,
          },
        }
      : undefined,
    preconditions: buildPreconditions({
      uiUrl,
      gatewayPort: options.gatewayPort,
      cdpPort: options.cdpPort,
    }),
    logger: console,
    recording: {
      videoRecorder:
        webVideoRecorder ??
        createCaptureHelperVideoRecorder({
          captureHelperPath: captureHelperBin(),
        }),
      targetProvider: {
        async resolveRecordingTarget() {
          if (!recordingTarget) {
            throw new Error('Recording target requested without --record-video.');
          }
          return recordingTarget;
        },
      },
    },
  });

  const result = await runner.run({
    recipeDocument,
    recipePath,
    artifactsDir,
    projectRoot: options.projectRoot,
    recordVideo: options.recordVideo
      ? {
          mode: 'full-run',
          maxFps: options.recordMaxFps,
          maxSize: options.recordMaxSize,
          target: recordingTarget,
        }
      : false,
    env: {
      FARMSLOT_CDP_PORT: String(options.cdpPort),
      FARMSLOT_UI_URL: uiUrl,
      GATEWAY_PORT: String(options.gatewayPort ?? ''),
      FARMSLOT_SLOT_ID: options.slotId,
    },
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Recipe run: ${result.status}`);
    console.log(`Artifacts: ${result.artifactManifestPath}`);
  }

  if (result.status !== 'pass') process.exit(1);
}

// Only run the CLI when executed directly, not when imported for isolated tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    die(error instanceof Error ? error.message : String(error), 2);
  });
}
