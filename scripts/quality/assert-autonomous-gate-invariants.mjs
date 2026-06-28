#!/usr/bin/env node
/**
 * Assert autonomous dev runs are blocked at the publication gate — not terminal, not published.
 *
 * Usage:
 *   node scripts/quality/assert-autonomous-gate-invariants.mjs <runId> [--gateway ws://127.0.0.1:7777]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GW = path.join(ROOT, 'scripts/lib/gw.mjs');

function parseArgs(argv) {
  let runId = '';
  let gatewayUrl = process.env.GW_URL || 'ws://localhost:7777';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--gateway') {
      gatewayUrl = argv[++i] ?? gatewayUrl;
      continue;
    }
    if (!arg.startsWith('-') && !runId) {
      runId = arg;
    }
  }
  return { runId, gatewayUrl };
}

function gwCall(method, params, gatewayUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GW, method, JSON.stringify(params)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GW_URL: gatewayUrl },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `gw exit ${code}`));
      else resolve(JSON.parse(stdout.trim()));
    });
  });
}

const { runId, gatewayUrl } = parseArgs(process.argv.slice(2));
if (!runId) {
  process.stderr.write(
    'Usage: assert-autonomous-gate-invariants.mjs <runId> [--gateway ws://127.0.0.1:7777]\n',
  );
  process.exit(1);
}

const { run } = await gwCall('run.get', { runId }, gatewayUrl);
const failures = [];

if (run.mode !== 'autonomous') failures.push(`mode=${run.mode} (expected autonomous)`);
if (run.status !== 'blocked') failures.push(`status=${run.status} (expected blocked at gate)`);
if (run.publicationStatus && run.publicationStatus !== 'not_published') {
  failures.push(`publicationStatus=${run.publicationStatus} (expected not_published)`);
}
if (run.prNumber) failures.push(`prNumber=${run.prNumber} (expected no PR before gate approval)`);

const humanGate = (run.steps ?? []).find((s) => s.name === 'human-gate');
if (!humanGate || humanGate.status !== 'running') {
  failures.push('human-gate step not running');
}

const terminal = new Set(['done', 'failed', 'cancelled']);
if (terminal.has(run.status)) {
  failures.push(`run is terminal (${run.status}) — cannot be reused for gate proof`);
}

if (failures.length) {
  process.stderr.write(`Gate invariant failures for ${runId}:\n`);
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}

process.stdout.write(`OK: ${runId} blocked at autonomous publication gate\n`);
