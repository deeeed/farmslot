#!/usr/bin/env node
/**
 * Recipe v1 readiness doctor for Farmslot Command Center sandboxes.
 *
 * Usage:
 *   node apps/command-center/scripts/agentic/recipe-doctor.mjs \
 *     --cdp-port 9323 --gateway-port 8809 --json
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listCdpTargets } from '@farmslot/recipe-harness/runtime/cdp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function parseArgs(argv) {
  const options = {
    cdpPort: Number(process.env.FARMSLOT_CDP_PORT ?? 9323),
    gatewayPort: process.env.GATEWAY_PORT ?? '',
    uiUrl: process.env.FARMSLOT_UI_URL ?? '',
    projectRoot: REPO_ROOT,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cdp-port') options.cdpPort = Number(argv[++i]);
    else if (arg.startsWith('--cdp-port=')) options.cdpPort = Number(arg.slice(10));
    else if (arg === '--gateway-port') options.gatewayPort = argv[++i] ?? '';
    else if (arg.startsWith('--gateway-port=')) options.gatewayPort = arg.slice(15);
    else if (arg === '--ui-url') options.uiUrl = argv[++i] ?? '';
    else if (arg.startsWith('--ui-url=')) options.uiUrl = arg.slice(9);
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
    if (match) return `http://127.0.0.1:${match[1]}`;
  } catch {
    // optional
  }
  return 'http://127.0.0.1:5174';
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const uiUrl = await resolveUiUrl(options.projectRoot, options.uiUrl);
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

  const manifestPath = path.join(
    options.projectRoot,
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

  const runnerPath = path.join(options.projectRoot, 'apps/command-center/scripts/agentic/run-recipe.mjs');
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