#!/usr/bin/env node
// Deterministic lint for agent-authored backlog spec files (.backlog/specs/**).
// Hard rules only — heuristic judgment lives in SKILL.md. Exit 1 on any failure
// so authoring loops cannot hand-wave a broken acceptance contract.

import { readFileSync } from 'node:fs';
import process from 'node:process';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: spec-lint.mjs <spec.md> [more.md ...]');
  process.exit(2);
}

// An AC bullet must name a machine-checkable proof surface. Backtick refs cover
// commands/paths/symbols; the verb forms cover "X tests prove/reject/..." prose.
const CHECK_MARKER =
  /`[^`]+`|\btests?\b[^.]*\b(prove|show|assert|cover|pass(es)?|fail(s)?|reject(s)?)\b|\b(typecheck|lint|CI\b|CDP|recipe (run|regression)|exit (0|non-zero|code))\b/i;

// Operator-eyeball and wall-clock acceptance can never be verified by a worker
// or a reviewer inside one run — they fail hard, not as warnings.
const FORBIDDEN = [
  [/\bmanual(ly)?\s+(check|verify|test|inspect|confirm)/i, 'manual verification'],
  [/\boperator\s+(checks|verifies|confirms|inspects|reviews)\b/i, 'operator-dependent check'],
  [/\b(visually|eyeball|by hand)\b/i, 'visual/by-hand check'],
  [/\blooks\s+(right|correct|good|fine)\b/i, 'subjective appearance check'],
  [/\bwait\s+(for\s+)?(a\s+)?\d+\s*(minute|hour|day|week)/i, 'wall-clock wait'],
  [/\bafter\s+(the\s+)?soak\b/i, 'soak-period dependence'],
  [/\bover\s+time\b|\beventually\b/i, 'unbounded time dependence'],
];

let failed = false;
let fileFailed = false;
const fail = (file, msg) => {
  failed = true;
  fileFailed = true;
  console.error(`FAIL ${file}: ${msg}`);
};

for (const file of files) {
  fileFailed = false;
  const text = readFileSync(file, 'utf-8');
  const lines = text.split('\n');

  if (!/^#\s+\S/m.test(text)) fail(file, 'missing `# <title>` heading');
  if (!/^\*\*Project:\*\*\s*\S/m.test(text)) fail(file, 'missing `**Project:** <name>` line');
  if (!/^##\s+(Problem|Context|Why this exists)\b/m.test(text)) {
    fail(file, 'missing `## Problem` (or Context) section — state why the item exists');
  }
  if (!/^##\s+(Deliverables|Scope)\b/m.test(text)) {
    fail(file, 'missing `## Deliverables` (or Scope) section');
  }

  const acStart = lines.findIndex((l) => /^##\s+Acceptance Criteria\s*$/i.test(l));
  if (acStart === -1) {
    fail(file, 'missing `## Acceptance Criteria` section');
    continue;
  }
  const acEnd = lines.findIndex((l, i) => i > acStart && /^##\s+/.test(l));
  const acLines = lines.slice(acStart + 1, acEnd === -1 ? undefined : acEnd);

  // Bullets may wrap: continuation lines are indented and belong to the bullet.
  const bullets = [];
  for (const line of acLines) {
    if (/^\s*([-*]|\d+\.)\s+\S/.test(line)) bullets.push(line.trim());
    else if (/^\s{2,}\S/.test(line) && bullets.length > 0) {
      bullets[bullets.length - 1] += ` ${line.trim()}`;
    }
  }
  if (bullets.length === 0) {
    fail(file, 'Acceptance Criteria has no bullet items — criteria must be an enumerable list');
    continue;
  }
  for (const bullet of bullets) {
    if (!CHECK_MARKER.test(bullet)) {
      fail(
        file,
        `AC bullet lacks a concrete check marker (test/command/path/typecheck/CDP/recipe): "${bullet.slice(0, 100)}"`,
      );
    }
    for (const [pattern, label] of FORBIDDEN) {
      if (pattern.test(bullet)) {
        fail(file, `AC bullet uses forbidden ${label}: "${bullet.slice(0, 100)}"`);
      }
    }
  }
  if (!fileFailed) {
    console.log(`PASS ${file}: ${bullets.length} acceptance criteria, all checkable`);
  }
}

process.exit(failed ? 1 : 0);
