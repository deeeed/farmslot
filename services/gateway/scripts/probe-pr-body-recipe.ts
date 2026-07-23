#!/usr/bin/env -S npx tsx
// probe-pr-body-recipe.ts — fetch a PR body via gh, run the LLM extractor,
// materialize results to a temp dir for inspection.
//
// Usage:
//   cd services/gateway
//   npx tsx scripts/probe-pr-body-recipe.ts example-org/example-browser#41949
//
// Optional env:
//   PROBE_OUT=/tmp/my-probe   # output dir (default: mktemp under /tmp)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  extractRecipeFromPRBody,
  materializeExtractedRecipe,
} from '../src/quality/pr-body-recipe.js';

function fetchPRBody(ref: string): string {
  const match = ref.match(/^([^/#\s]+\/[^/#\s]+)#(\d+)$/);
  if (!match) {
    throw new Error(`Bad PR ref: "${ref}". Expected OWNER/REPO#NUMBER.`);
  }
  const [, repo, num] = match;
  // unset GH_TOKEN — fine-grained PAT may lack PR read on some repos; keyring
  // token has full repo scope (per ~/.claude/CLAUDE.md GH_TOKEN guidance).
  const env = { ...process.env };
  delete env.GH_TOKEN;
  const out = execFileSync('gh', ['pr', 'view', num, '-R', repo, '--json', 'body', '-q', '.body'], {
    env,
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out;
}

async function main() {
  const ref = process.argv[2];
  if (!ref) {
    console.error('Usage: npx tsx scripts/probe-pr-body-recipe.ts OWNER/REPO#NUMBER');
    process.exit(2);
  }

  console.log(`[probe] fetching PR body for ${ref}...`);
  const body = fetchPRBody(ref);
  console.log(`[probe] body length: ${body.length} chars`);

  const outDir = process.env.PROBE_OUT
    ? (mkdirSync(process.env.PROBE_OUT, { recursive: true }), process.env.PROBE_OUT)
    : mkdtempSync(path.join(os.tmpdir(), 'pr-recipe-probe-'));
  console.log(`[probe] output dir: ${outDir}`);

  console.log('[probe] calling LLM extractor...');
  const t0 = Date.now();
  const result = await extractRecipeFromPRBody(body);
  const dt = Date.now() - t0;
  console.log(`[probe] reason=${result.reason}  duration=${dt}ms`);
  console.log(`[probe] usage=${JSON.stringify(result.usage)}`);

  if (!result.bundle) {
    console.log('[probe] no recipe extracted. exiting.');
    process.exit(0);
  }

  const recipeNames = Object.keys(result.bundle.recipes);
  console.log(
    `[probe] extracted recipe + ${recipeNames.length} dependencies: ${recipeNames.join(', ') || '(none)'}`,
  );

  const { inheritedRecipePath, inheritedRecipeFiles, provenancePath } =
    await materializeExtractedRecipe(result.bundle, outDir);
  console.log(`[probe] wrote ${inheritedRecipePath}  (staged — untrusted, gated)`);
  console.log(`[probe] wrote ${provenancePath}  (provenance marker)`);
  for (const f of inheritedRecipeFiles) console.log(`[probe] wrote ${f}`);
  console.log('[probe] done. Recipe is staged for review only — NOT seeded into artifacts/.');
  console.log('[probe] Inspect with:');
  console.log(`  jq . ${inheritedRecipePath}`);
  console.log(`  jq . ${provenancePath}`);
  if (existsSync(path.join(outDir, 'inputs', 'inherited', 'recipe-library'))) {
    console.log(`  find ${outDir}/inputs/inherited/recipe-library -type f`);
  }
}

main().catch((err) => {
  console.error(`[probe] failed: ${(err as Error).message}`);
  process.exit(1);
});
