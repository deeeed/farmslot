#!/usr/bin/env node
/**
 * Dispatch a comparison family in one shot — one run.create per variant/slot.
 *
 * Usage:
 *   node scripts/dispatch-comparison-family.mjs \
 *     --family-id <uuid> \
 *     --project farmslot-farm \
 *     --ticket "farmslot-farm#28" \
 *     --flow dev \
 *     --start-ref main \
 *     --mode autonomous \
 *     --variants claude:macwork-ff-2,codex:macwork-ff-3,grok:macwork-ff-4
 *
 * Environment:
 *   GW_URL      — gateway WebSocket URL (default ws://localhost:7777)
 *   GW_TIMEOUT  — per-call timeout ms (default 30000)
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GW = path.join(ROOT, 'scripts/lib/gw.mjs');

function usage() {
  process.stderr.write(`Usage: dispatch-comparison-family.mjs \\
  --family-id <uuid> --project <name> --ticket <ref> \\
  [--flow dev|fix-bug] [--start-ref main] [--mode autonomous] \\
  --variants <runner-or-variant>:<slotId>[,...]

Example:
  --variants claude:macwork-ff-2,codex:macwork-ff-3,grok:macwork-ff-4
`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    familyId: '',
    project: '',
    ticket: '',
    flow: 'dev',
    startRef: 'main',
    mode: 'autonomous',
    prepareProfile: 'sandbox',
    variants: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--family-id') out.familyId = next() ?? '';
    else if (arg === '--project') out.project = next() ?? '';
    else if (arg === '--ticket') out.ticket = next() ?? '';
    else if (arg === '--flow') out.flow = next() ?? out.flow;
    else if (arg === '--start-ref') out.startRef = next() ?? out.startRef;
    else if (arg === '--mode') out.mode = next() ?? out.mode;
    else if (arg === '--prepare-profile') out.prepareProfile = next() ?? out.prepareProfile;
    else if (arg === '--variants') {
      const raw = next() ?? '';
      out.variants = raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [variant, slotId] = entry.split(':');
          if (!variant?.trim() || !slotId?.trim()) {
            throw new Error(`Invalid --variants entry '${entry}' (expected variant:slotId)`);
          }
          return { variant: variant.trim(), slotId: slotId.trim() };
        });
    } else if (arg === '-h' || arg === '--help') usage();
    else throw new Error(`Unknown arg: ${arg}`);
  }
  if (!out.familyId || !out.project || !out.ticket || out.variants.length === 0) usage();
  return out;
}

function gwCall(method, params) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GW, method, JSON.stringify(params)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `gw exit ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (err) {
        reject(new Error(`Invalid gw JSON: ${(err instanceof Error ? err.message : String(err))}`));
      }
    });
  });
}

const args = parseArgs(process.argv.slice(2));

const results = [];
for (const { variant, slotId } of args.variants) {
  const payload = {
    project: args.project,
    flowType: args.flow,
    ticketOrPr: args.ticket,
    mode: args.mode,
    lane: 'comparison',
    familyId: args.familyId,
    variant,
    completionPolicy: 'artifact-only',
    startRef: args.startRef,
    prepareProfile: args.prepareProfile,
    slotId,
  };
  process.stderr.write(`[dispatch-comparison-family] ${variant} → ${slotId}\n`);
  const created = await gwCall('run.create', payload);
  results.push({ variant, slotId, runId: created.run?.id });
}

process.stdout.write(`${JSON.stringify({ familyId: args.familyId, runs: results }, null, 2)}\n`);