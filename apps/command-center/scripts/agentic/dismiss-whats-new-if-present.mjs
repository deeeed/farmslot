#!/usr/bin/env node
/**
 * Dismiss Command Center "What's new" modal when it covers the fleet UI.
 * Always exits 0 — no-op when the modal is already dismissed.
 *
 * Usage:
 *   node apps/command-center/scripts/agentic/dismiss-whats-new-if-present.mjs
 *
 * Env: FARMSLOT_CDP_PORT (default 9323), FARMSLOT_UI_URL (optional, for hash tab match)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cdp = path.join(__dirname, '../cdp.mjs');

const expr = `(() => {
  const deep = (s, r = document) => {
    const out = [...r.querySelectorAll(s)];
    for (const el of r.querySelectorAll('*')) {
      if (el.shadowRoot) out.push(...deep(s, el.shadowRoot));
    }
    return out;
  };
  const btn = deep('button').find((b) => /^\\s*Got it\\s*$/i.test(b.textContent || ''));
  if (btn) {
    btn.click();
    return { dismissed: true };
  }
  return { dismissed: false };
})()`;

const result = spawnSync(process.execPath, [cdp, 'eval', 'fleet', expr], {
  env: process.env,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
// Never fail the recipe when CDP is mid-navigation; wait step still proves Accounts.
process.exit(0);
