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
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getRecipeActionManifestActionNames } from '@farmslot/protocol';
import { createStandardCoreAdapters } from '@farmslot/recipe-harness/adapters/core';
import { createStandardUiAdapters } from '@farmslot/recipe-harness/adapters/ui';
import { createRecipeRunner } from '@farmslot/recipe-harness/runner';
import {
  CdpWebPage,
  createCdpWebUiTransport,
  listCdpTargets,
  selectCdpTarget,
} from '@farmslot/recipe-harness/runtime/cdp';

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
    if (match) return `http://127.0.0.1:${match[1]}`;
  } catch {
    // .env.ports is optional outside sandbox worktrees.
  }
  return 'http://127.0.0.1:5174';
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

function buildPreconditions({ uiUrl, gatewayPort }) {
  return [
    {
      id: 'command_center.dev_server.ready',
      async check() {
        const ok = await fetchOk(`${uiUrl}/`);
        return {
          status: ok ? 'pass' : 'fail',
          detail: ok ? `UI reachable at ${uiUrl}` : `UI not reachable at ${uiUrl}`,
        };
      },
    },
    {
      id: 'gateway.reachable',
      async check() {
        if (!gatewayPort) {
          return { status: 'pass', detail: 'gateway_port not configured; skipped.' };
        }
        const ok = await fetchOk(`http://127.0.0.1:${gatewayPort}/health`);
        return {
          status: ok ? 'pass' : 'fail',
          detail: ok
            ? `Gateway healthy on :${gatewayPort}`
            : `Gateway not healthy on :${gatewayPort}`,
        };
      },
    },
    {
      id: 'runtime.browser.open',
      async check(context) {
        try {
          await listCdpTargets('127.0.0.1', context.cdpPort);
          return { status: 'pass', detail: `CDP listening on :${context.cdpPort}` };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { status: 'fail', detail: message };
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

async function main() {
  const { recipePath, options } = parseArgs(process.argv.slice(2));
  const uiUrl = await resolveUiUrl(options.projectRoot, options.uiUrl);
  const recipeRaw = await readJson(recipePath);
  const manifest = await readJson(
    path.isAbsolute(options.actionManifest)
      ? options.actionManifest
      : path.resolve(options.projectRoot, options.actionManifest),
  );

  const inputs = {
    ui_url: uiUrl,
    cdp_port: String(options.cdpPort),
    gateway_port: options.gatewayPort,
    gateway_url: options.gatewayPort ? `ws://127.0.0.1:${options.gatewayPort}/ws` : '',
    slot_id: options.slotId,
    repo: options.projectRoot,
    ...((recipeRaw.inputs && typeof recipeRaw.inputs === 'object' && recipeRaw.inputs) || {}),
    ...options.inputs,
  };

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
      [
        'command_center.dev_server.ready',
        'gateway.reachable',
        'runtime.browser.open',
      ].includes(entry.id),
    ),
  };

  let preferredHash = '';
  const cdpTransport = createCdpWebUiTransport({
    async getPage(input) {
      if (input.action === 'ui.navigate') {
        preferredHash = hashFromNavigateTarget(
          String(input.node.url ?? input.node.target ?? ''),
        );
      }
      return connectPage(options.cdpPort, preferredHash);
    },
  });

  const transport = wrapTransportWithSlow(
    wrapTransportNavigate(cdpTransport, uiUrl),
    options.slowMs,
  );

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
    preconditions: buildPreconditions({ uiUrl, gatewayPort: options.gatewayPort }),
    logger: console,
  });

  const result = await runner.run({
    recipeDocument,
    recipePath,
    artifactsDir,
    projectRoot: options.projectRoot,
    recordVideo: options.recordVideo
      ? { mode: 'full-run' }
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

main().catch((error) => {
  die(error instanceof Error ? error.message : String(error), 2);
});