#!/usr/bin/env node
/**
 * Recipe v1 readiness doctor for Farmslot Command Center sandboxes.
 *
 * Usage:
 *   node apps/command-center/scripts/agentic/recipe-doctor.mjs \
 *     --cdp-port 9323 --gateway-port 8809 --slot-id macwork-ff-2 --json
 */
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createCdpVideoRecorder } from '@farmslot/recipe-harness';
import { listCdpTargets } from '@farmslot/recipe-harness/runtime/cdp';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FARMSLOT_ROOT = path.resolve(__dirname, '../../../..');

function parseArgs(argv) {
  const options = {
    cdpPort: Number(process.env.FARMSLOT_CDP_PORT ?? 9323),
    gatewayPort: process.env.GATEWAY_PORT ?? '',
    uiUrl: process.env.FARMSLOT_UI_URL ?? '',
    slotId: process.env.FARMSLOT_SLOT_ID ?? '',
    projectRoot: FARMSLOT_ROOT,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cdp-port') options.cdpPort = Number(argv[++i]);
    else if (arg.startsWith('--cdp-port=')) options.cdpPort = Number(arg.slice('--cdp-port='.length));
    else if (arg === '--gateway-port') options.gatewayPort = argv[++i] ?? '';
    else if (arg.startsWith('--gateway-port=')) options.gatewayPort = arg.slice(15);
    else if (arg === '--ui-url') options.uiUrl = argv[++i] ?? '';
    else if (arg.startsWith('--ui-url=')) options.uiUrl = arg.slice(9);
    else if (arg === '--slot-id') options.slotId = argv[++i] ?? '';
    else if (arg.startsWith('--slot-id=')) options.slotId = arg.slice(10);
    else if (arg === '--project-root') options.projectRoot = path.resolve(argv[++i] ?? '.');
    else if (arg.startsWith('--project-root=')) {
      options.projectRoot = path.resolve(arg.slice(15));
    } else if (arg === '--json') options.json = true;
  }
  return options;
}

async function resolveUiUrl(projectRoot, explicit) {
  if (explicit) return explicit.replace(/\/$/, '');
  try {
    const raw = await readFile(path.join(projectRoot, '.env.ports'), 'utf8');
    const match = raw.match(/^VITE_PORT=(\d+)/m);
    if (match) return `http://localhost:${match[1]}`;
  } catch {
    // optional
  }
  return 'http://localhost:5174';
}

async function loadSlotProjectRoot(slotId, farmslotRoot) {
  if (!slotId) return farmslotRoot;
  const poolDir = path.join(farmslotRoot, 'pool');
  let entries;
  try {
    const { readdir } = await import('node:fs/promises');
    entries = await readdir(poolDir);
  } catch {
    return farmslotRoot;
  }
  for (const file of entries) {
    if (!file.endsWith('.json') || file.endsWith('.example.json')) continue;
    const raw = await readFile(path.join(poolDir, file), 'utf8');
    const pool = JSON.parse(raw);
    const slot = pool.slots?.find((candidate) => candidate.id === slotId);
    if (slot?.repo) return path.resolve(slot.repo);
  }
  return farmslotRoot;
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

async function checkFetch(label, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return {
      id: label,
      status: response.ok ? 'pass' : 'fail',
      message: response.ok ? `${url} OK` : `${url} HTTP ${response.status}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: label, status: 'fail', message };
  }
}

function captureHelperBin() {
  return (
    process.env.CAPTURE_HELPER_PATH ?? process.env.SITEED_CAPTURE_HELPER_BIN ?? 'capture-helper'
  );
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
      // fall through to multi-line parse
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

function screenRecordingDenied(...parts) {
  const combined = parts.filter(Boolean).join('\n');
  return (
    combined.includes('screen_recording_denied') ||
    combined.includes('SCStreamErrorDomain Code=-3801')
  );
}

async function checkCdpVideoFallback(cdpPort) {
  const recorder = createCdpVideoRecorder({ cdpPort, urlIncludes: '#fleet' });
  const doctor = await recorder.doctor();
  return {
    ok: doctor.ok,
    message: doctor.message,
  };
}

async function passWithCdpFallbackWhenTccDenied(cdpPort, id, prefix) {
  const cdp = await checkCdpVideoFallback(cdpPort);
  if (cdp.ok) {
    return {
      id,
      status: 'pass',
      message: `${prefix}; ${cdp.message}`,
    };
  }
  return {
    id,
    status: 'fail',
    message: `${prefix}; CDP fallback unavailable (${cdp.message})`,
  };
}

async function checkCaptureHelperDoctor(cdpPort) {
  if (process.platform !== 'darwin') {
    return {
      id: 'capture_helper.doctor',
      status: 'pass',
      message: 'skipped (non-macOS)',
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync(captureHelperBin(), ['doctor', '--json']);
    const parsed = parseCaptureHelperJson(stdout, stderr);
    const ok = parsed?.ok === true;
    if (ok) {
      return {
        id: 'capture_helper.doctor',
        status: 'pass',
        message: `capture-helper ${parsed?.build?.version ?? ''} ready`.trim(),
      };
    }
    return passWithCdpFallbackWhenTccDenied(
      cdpPort,
      'capture_helper.doctor',
      screenRecordingDenied(stdout, stderr)
        ? 'capture-helper TCC denied'
        : 'capture-helper doctor failed',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stdout =
      error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    return passWithCdpFallbackWhenTccDenied(
      cdpPort,
      'capture_helper.doctor',
      screenRecordingDenied(message, stdout, stderr)
        ? 'capture-helper TCC denied'
        : 'capture-helper doctor failed',
    );
  }
}

async function checkCaptureWindowOnScreen(cdpPort) {
  if (process.platform !== 'darwin') {
    return {
      id: 'capture_helper.window.on_screen',
      status: 'pass',
      message: 'skipped (non-macOS)',
    };
  }
  const pid = await pidListeningOnPort(cdpPort);
  if (!pid) {
    return {
      id: 'capture_helper.window.on_screen',
      status: 'fail',
      message: `no listener on CDP :${cdpPort}`,
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync(captureHelperBin(), [
      'resolve',
      '--pid',
      String(pid),
      '--json',
    ]);
    const parsed = parseCaptureHelperJson(stdout, stderr);
    if (!parsed) {
      const errDoc = parseCaptureHelperJson('', stderr);
      if (errDoc?.code === 'screen_recording_denied') {
        const cdp = await checkCdpVideoFallback(cdpPort);
        if (cdp.ok) {
          return {
            id: 'capture_helper.window.on_screen',
            status: 'pass',
            message: `capture-helper resolve blocked by TCC; ${cdp.message}`,
          };
        }
        return {
          id: 'capture_helper.window.on_screen',
          status: 'fail',
          message:
            'Screen Recording permission denied for capture-helper; enable in System Settings',
        };
      }
      return {
        id: 'capture_helper.window.on_screen',
        status: 'fail',
        message: stderr.trim() || stdout.trim() || 'capture-helper resolve failed',
      };
    }
    const onScreen = parsed.selected?.onScreen === true;
    if (onScreen) {
      return {
        id: 'capture_helper.window.on_screen',
        status: 'pass',
        message: `Chrome window ${parsed.selected?.title ?? 'selected'} is on-screen`,
      };
    }
    return passWithCdpFallbackWhenTccDenied(
      cdpPort,
      'capture_helper.window.on_screen',
      `Chrome window off-screen (${parsed.selected?.title ?? 'unknown'}); using CDP screencast`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stdout =
      error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    if (screenRecordingDenied(message, stdout, stderr)) {
      return passWithCdpFallbackWhenTccDenied(
        cdpPort,
        'capture_helper.window.on_screen',
        'capture-helper resolve blocked by TCC',
      );
    }
    return { id: 'capture_helper.window.on_screen', status: 'fail', message };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const slotProjectRoot = await loadSlotProjectRoot(options.slotId, FARMSLOT_ROOT);
  const uiProjectRoot = options.projectRoot === FARMSLOT_ROOT ? slotProjectRoot : options.projectRoot;
  const uiUrl = await resolveUiUrl(uiProjectRoot, options.uiUrl);
  const checks = [];

  checks.push(await checkFetch('command_center.dev_server.ready', `${uiUrl}/`));

  if (options.gatewayPort) {
    checks.push(
      await checkFetch('gateway.reachable', `http://127.0.0.1:${options.gatewayPort}/health`),
    );
  } else {
    checks.push({
      id: 'gateway.reachable',
      status: 'pass',
      message: 'gateway_port not provided; skipped.',
    });
  }

  try {
    const targets = await listCdpTargets('127.0.0.1', options.cdpPort);
    const pages = targets.filter((target) => target.type === 'page');
    checks.push({
      id: 'runtime.browser.open',
      status: pages.length > 0 ? 'pass' : 'fail',
      message:
        pages.length > 0
          ? `CDP :${options.cdpPort} has ${pages.length} page target(s)`
          : `CDP :${options.cdpPort} has no page targets`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ id: 'runtime.browser.open', status: 'fail', message });
  }

  checks.push(await checkCaptureHelperDoctor(options.cdpPort));
  checks.push(await checkCaptureWindowOnScreen(options.cdpPort));

  const manifestPath = path.join(
    FARMSLOT_ROOT,
    'docs/examples/recipes/farmslot-v1.action-manifest.json',
  );
  try {
    await readFile(manifestPath, 'utf8');
    checks.push({
      id: 'recipe.action_manifest.present',
      status: 'pass',
      message: manifestPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ id: 'recipe.action_manifest.present', status: 'fail', message });
  }

  const runnerPath = path.join(FARMSLOT_ROOT, 'apps/command-center/scripts/agentic/run-recipe.mjs');
  try {
    await readFile(runnerPath, 'utf8');
    checks.push({
      id: 'project.recipe_run.ui_supported',
      status: 'pass',
      message: runnerPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ id: 'project.recipe_run.ui_supported', status: 'fail', message });
  }

  const document = {
    runner_protocol_version: 1,
    status: checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
    checks,
    ui_url: uiUrl,
    cdp_port: options.cdpPort,
    gateway_port: options.gatewayPort || null,
    slot_id: options.slotId || null,
    slot_project_root: slotProjectRoot,
    farmslot_root: FARMSLOT_ROOT,
  };

  if (options.json) console.log(JSON.stringify(document, null, 2));
  else {
    for (const check of checks) {
      console.log(`${check.status === 'pass' ? 'OK' : 'FAIL'} ${check.id}: ${check.message}`);
    }
  }

  if (document.status !== 'pass') process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});