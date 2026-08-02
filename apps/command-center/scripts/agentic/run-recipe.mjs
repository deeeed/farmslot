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
 *     [--run-id <id>] \
 *     [--recipe-run-id <id>] \
 *     [--slow <ms>] \
 *     [--record-video=full-run] \
 *     [--json]
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  applyTaskLocalInvocationTrust,
  createCaptureHelperVideoRecorder,
  createCdpVideoRecorder,
  createRecipeRunner,
  resolveRecipeLibrarySources,
  resolveRecipeTrustInput,
} from '@farmslot/recipe-harness';
import { createStandardCoreAdapters } from '@farmslot/recipe-harness/adapters/core';
import { createStandardUiAdapters } from '@farmslot/recipe-harness/adapters/ui';
import { parseRecipeParamAssignments } from '@farmslot/recipe-harness/cli/support';
import {
  CdpWebPage,
  createCdpWebUiTransport,
  listCdpTargets,
} from '@farmslot/recipe-harness/runtime/cdp';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

export const COMMAND_CENTER_RECIPE_SOURCE = Object.freeze({
  kind: 'operator',
  trust: 'trusted',
  name: '@farmslot/command-center',
});

export function resolveCommandCenterRecipeTrust(env = process.env) {
  return resolveRecipeTrustInput({}, env);
}

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
    runId: process.env.FARMSLOT_RUN_ID ?? '',
    recipeRunId: process.env.FARMSLOT_RECIPE_RUN_ID ?? '',
    slowMs: 0,
    recordVideo: false,
    recordMaxFps: 15,
    recordMaxSize: 1080,
    recordAppName: process.env.FARMSLOT_RECORD_APP_NAME ?? 'Google Chrome',
    recordWindowName: process.env.FARMSLOT_RECORD_WINDOW_NAME ?? '',
    recordPid: 0,
    json: false,
    paramAssignments: [],
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
    if (arg === '--run-id') {
      options.runId = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--run-id=')) {
      options.runId = arg.slice('--run-id='.length);
      continue;
    }
    if (arg === '--recipe-run-id') {
      options.recipeRunId = argv[++i] ?? '';
      continue;
    }
    if (arg.startsWith('--recipe-run-id=')) {
      options.recipeRunId = arg.slice('--recipe-run-id='.length);
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
      options.paramAssignments.push(arg.slice('--input='.length));
      continue;
    }
    if (arg === '--input') {
      options.paramAssignments.push(argv[++i] ?? '');
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

export function commandCenterRecipeParams(recipe, runtimeParams, explicitParams = {}) {
  const properties = recipe?.paramsSchema?.properties;
  const declared =
    properties && typeof properties === 'object' && !Array.isArray(properties)
      ? new Set(Object.keys(properties))
      : new Set();
  return {
    ...Object.fromEntries(Object.entries(runtimeParams).filter(([key]) => declared.has(key))),
    ...explicitParams,
  };
}

export function commandCenterActionManifest(manifest, implementedActions) {
  const actions =
    manifest?.actions && typeof manifest.actions === 'object' && !Array.isArray(manifest.actions)
      ? Object.fromEntries(
          Object.entries(manifest.actions).filter(([action]) => implementedActions.has(action)),
        )
      : {};
  const declared = new Set(Object.keys(actions));
  const observers = Array.isArray(manifest?.observers)
    ? manifest.observers.flatMap((observer) => {
        if (!observer || typeof observer !== 'object' || Array.isArray(observer)) return [];
        const defaultFor = Array.isArray(observer.default_for)
          ? observer.default_for.filter((action) => declared.has(action))
          : [];
        return defaultFor.length ? [{ ...observer, default_for: defaultFor }] : [];
      })
    : [];

  return {
    $schema: manifest?.$schema,
    actions,
    ...(observers.length ? { observers } : {}),
  };
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

function wrapTransportWithSlow(transport, slowMs) {
  if (!slowMs || slowMs <= 0) return transport;
  return {
    async execute(action, node, context) {
      const result = await transport.execute(action, node, context);
      await new Promise((resolve) => setTimeout(resolve, slowMs));
      return result;
    },
    ...(transport.observe
      ? { observe: (refs, node, context) => transport.observe(refs, node, context) }
      : {}),
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
    ...(transport.observe
      ? { observe: (refs, node, context) => transport.observe(refs, node, context) }
      : {}),
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

// Seed the same localStorage keys the UI reads (ui/src/gateway-url.ts) so the slot UI
// authenticates to the slot gateway on load — without the worker having to log the recipe
// browser in (which wastes setup tokens and surfaces as "token missing").
export function gatewayTokenSeedScript(token) {
  return `try { localStorage.setItem('farmslot.gateway.authMode', 'token'); localStorage.setItem('farmslot.gateway.token', ${JSON.stringify(token)}); } catch (e) {}`;
}

async function resolveGatewayToken(projectRoot) {
  const fromEnv = process.env.FARMSLOT_GATEWAY_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = await readFile(path.join(projectRoot, '.env.local-auth'), 'utf8');
    const match = raw.match(/^FARMSLOT_GATEWAY_TOKEN=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // .env.local-auth is optional (gateway may run auth=none); fall through to no token.
  }
  return '';
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
    // Be precise: doctor failure is not "not installed". Common causes: PATH in the
    // recipe child, stale CAPTURE_HELPER_PATH, off-screen window at record time.
    console.warn(
      `[run-recipe] capture-helper video doctor not ok (code=${captureDoctor?.code ?? 'unknown'}; ${captureDoctor?.message ?? 'no message'}). Falling back to ${cdpRecorder.name}. This does NOT mean capture-helper is uninstalled — verify with: command -v capture-helper && capture-helper doctor --json`,
    );
    return cdpRecorder;
  }
  throw new Error(
    `No web video recorder available. capture-helper doctor: code=${captureDoctor?.code ?? 'unknown'} message=${captureDoctor?.message ?? 'unknown'}. CDP: ${cdpDoctor.message}. Verify capture-helper with: command -v capture-helper && capture-helper doctor --json`,
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

export function withCapturableRecordingTarget(
  recorder,
  prepareTarget = ensureCapturableRecordingTarget,
) {
  return {
    ...recorder,
    doctor: recorder.doctor?.bind(recorder),
    async start(request) {
      return recorder.start({ ...request, target: await prepareTarget(request.target) });
    },
  };
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
  const runtimeParams = {
    ui_url: uiUrl,
    cdp_port: options.cdpPort,
    repo: options.projectRoot,
    farmslot_dir: farmslotDir,
    primary_repo: farmslotDir,
  };
  if (options.gatewayPort) {
    runtimeParams.gateway_port = options.gatewayPort;
    runtimeParams.gateway_url = `ws://127.0.0.1:${options.gatewayPort}/ws`;
  }
  if (options.slotId) {
    runtimeParams.slot_id = options.slotId;
  }
  if (options.runId) {
    runtimeParams.run_id = options.runId;
  }
  if (options.recipeRunId) {
    runtimeParams.recipe_run_id = options.recipeRunId;
  }
  const params = commandCenterRecipeParams(
    recipeRaw,
    runtimeParams,
    parseRecipeParamAssignments(options.paramAssignments),
  );
  const artifactsDir = path.resolve(options.artifactsDir);

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
    'ui.swipe',
    'ui.pan',
    'ui.drag',
    'ui.long_press',
    'ui.wait_for',
    'ui.screenshot',
    'app.status',
    'app.lifecycle',
    'app.hud',
    'app.trace',
  ];
  const implementedActions = new Set([...coreActions, ...uiActions]);
  const filteredManifest = commandCenterActionManifest(manifest, implementedActions);
  const filteredActions = Object.keys(filteredManifest.actions);

  const gatewayToken = await resolveGatewayToken(options.projectRoot);
  let preferredHash = '';
  const cdpTransport = createCdpWebUiTransport({
    async getPage(input) {
      if (input.action === 'ui.navigate') {
        preferredHash = hashFromNavigateTarget(String(input.node.url ?? input.node.target ?? ''));
      }
      const page = await connectPage(options.cdpPort, preferredHash);
      if (gatewayToken) {
        try {
          await page.evaluate(gatewayTokenSeedScript(gatewayToken));
        } catch (error) {
          console.warn(
            `[run-recipe] failed to seed gateway token into recipe browser: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return page;
    },
  });

  const transport = wrapTransportWithSlow(
    wrapTransportNavigate(cdpTransport, uiUrl),
    options.slowMs,
  );

  const webVideoRecorder = options.recordVideo
    ? await resolveWebVideoRecorder(options.cdpPort, captureHelperBin())
    : undefined;
  const recordingTarget = options.recordVideo ? await resolveRecordingTarget(options) : undefined;
  const videoRecorder =
    webVideoRecorder?.name === 'capture-helper'
      ? withCapturableRecordingTarget(webVideoRecorder)
      : webVideoRecorder;

  const hudEnabled = filteredActions.includes('app.hud');
  const trust = resolveCommandCenterRecipeTrust();
  const invocationTrust = trust.source?.trust ?? COMMAND_CENTER_RECIPE_SOURCE.trust;
  const librarySources = applyTaskLocalInvocationTrust(
    await resolveRecipeLibrarySources({ recipePath }),
    invocationTrust,
  );
  const runner = createRecipeRunner({
    actionManifest: filteredManifest,
    defaultSource: COMMAND_CENTER_RECIPE_SOURCE,
    adapters: [
      ...createStandardUiAdapters({
        transport,
        actions: filteredActions,
      }),
      ...createStandardCoreAdapters({
        actions: filteredActions,
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
    logger: console,
    recording: {
      videoRecorder:
        videoRecorder ??
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
    ...trust,
    recipeDocument: recipeRaw,
    recipePath,
    params,
    ...(librarySources.length ? { librarySources } : {}),
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
