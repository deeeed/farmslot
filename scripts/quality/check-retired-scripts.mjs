#!/usr/bin/env node
// CI gate: retired lifecycle scripts must stay deleted and unreferenced by
// live code. Historical records (ADRs, archives, changelogs, the retirement
// inventory) may keep mentioning them.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const RETIRED = [
  'release-slot.sh',
  'pr-status.sh',
  'migrate-task-root.sh',
  'validate-tmux-driver.sh',
  'find-slot.sh',
  'dispatch.sh',
];

// Paths whose mentions are historical narration, not live callers.
const HISTORICAL = [
  /^docs\/adr\//,
  /^docs\/archive\//,
  /^docs\/reference\/adr-implementation-status\.md$/,
  /^docs\/reference\/bash-decision-core-inventory\.md$/,
  /CHANGELOG\.md$/,
  /^scripts\/quality\/check-retired-scripts\.mjs$/,
];

const problems = [];
for (const name of RETIRED) {
  if (existsSync(resolve(repoRoot, 'scripts', name))) {
    problems.push(`retired script still exists: scripts/${name}`);
  }
  // Bare-name search; prose/comment lines are tolerated, anything that looks
  // like an invocation or path reference is flagged.
  let hits = '';
  try {
    hits = execFileSync('git', ['grep', '-nF', '--', name], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch (err) {
    // git grep exits 1 for "no matches" — the desired state. Anything else
    // (bad repo, tool failure) must fail the guard, not fake a pass.
    if (err && err.status === 1) continue;
    throw err;
  }
  for (const line of hits.split('\n')) {
    if (!line.trim()) continue;
    const [file, , ...rest] = line.split(':');
    if (HISTORICAL.some((pattern) => pattern.test(file))) continue;
    const text = rest.join(':').trim();
    // Code-comment mentions are historical narration. Markdown bullets are
    // NOT tolerated — a doc line like `- bash release-slot.sh` is a live
    // instruction operators copy-paste.
    if (/^(#|\/\/|\*)/.test(text)) continue;
    problems.push(`live reference to retired ${name}: ${line}`);
  }
}

if (problems.length > 0) {
  console.error(`Retired-scripts guard failed (${problems.length} problem(s)):`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    'Repoint callers to the farmslot CLI (see docs/reference/bash-decision-core-inventory.md, Retirement section).',
  );
  process.exit(1);
}
console.log(`Retired-scripts guard passed (${RETIRED.length} scripts verified gone).`);
