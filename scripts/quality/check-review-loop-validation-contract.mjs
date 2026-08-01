#!/usr/bin/env node
// CI gate: the cross-review loop skill must keep naming the exact validation
// commands for each round. Guidance that drifts back to "run the full gate every
// cycle" is what made review-fix loops saturate the machine (see MANUAL-000064);
// this check keeps the intermediate/final split enforceable instead of advisory.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SKILL_PATH = '.agents/skills/fs-cross-review-loop/SKILL.md';

export const REQUIRED_ANCHORS = [
  {
    id: 'heading',
    text: '## Validation Contract',
    why: 'the skill needs a dedicated, findable section for the per-round validation commands',
  },
  {
    id: 'intermediate',
    text:
      'Intermediate rounds: run the exact affected tests for the changed files, ' +
      'then `yarn prepush:quality`.',
    why: 'intermediate rounds must use the existing changed-file lane, not the full gate',
  },
  {
    id: 'final',
    text: 'Final round: run the full `yarn quality` once on the final committed SHA.',
    why: 'the canonical gate stays mandatory exactly once, on the SHA that ships',
  },
  {
    id: 'stop-criteria',
    text: 'the full `yarn quality` has been run once on the final committed SHA',
    why: 'the loop may not stop clean before the canonical gate has run',
  },
];

/** Collapse markdown soft wrapping so an anchor can be written on one line. */
export function normalize(markdown) {
  return markdown.replace(/\s+/g, ' ').trim();
}

export function missingAnchors(markdown, anchors = REQUIRED_ANCHORS) {
  const haystack = normalize(markdown);
  return anchors.filter((anchor) => !haystack.includes(normalize(anchor.text)));
}

function main() {
  const markdown = readFileSync(resolve(repoRoot, SKILL_PATH), 'utf8');
  const missing = missingAnchors(markdown);
  if (missing.length > 0) {
    console.error(`${SKILL_PATH} is missing required review-loop validation anchors:`);
    for (const anchor of missing) {
      console.error(`  - [${anchor.id}] ${anchor.why}`);
      console.error(`    expected text: ${anchor.text}`);
    }
    process.exit(1);
  }
  console.log(
    `review-loop validation contract satisfied (${REQUIRED_ANCHORS.length} anchors in ${SKILL_PATH})`,
  );
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
