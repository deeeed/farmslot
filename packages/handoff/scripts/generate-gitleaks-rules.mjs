#!/usr/bin/env node
// One-shot generator: ports the gitleaks vendor detector ruleset into the
// floor as a TypeScript data file. Reproducible provenance - re-run against a
// newer gitleaks.toml to regenerate.
//
//   node scripts/generate-gitleaks-rules.mjs <path-to-gitleaks.toml> <commit-sha>
//
// Source ruleset: https://github.com/gitleaks/gitleaks (config/gitleaks.toml),
// MIT License. The generated file carries the MIT attribution notice.
//
// What is ported: VENDOR-SPECIFIC detector rules (each keyed by a provider
// keyword). What is SKIPPED: the generic high-entropy rules (ids containing
// "generic"), which false-positive on hashes/uuids - our explicit non-goal.
// Go/RE2 -> JS conversion: leading `(?i)` becomes the `i` flag; scoped flag
// groups `(?i:...)`/`(?-i:...)` collapse to `(?:...)` (widening to
// case-insensitive under the global `i` flag - ported rules only ever widen);
// named groups `(?P<x>...)` become `(?:...)`. Any rule that still fails to
// compile as a JS RegExp, or that trips the clean-prose corpus below, is
// dropped with its reason recorded in the run summary.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [, , tomlPath, commitSha] = process.argv;
if (!tomlPath || !commitSha) {
  console.error('usage: generate-gitleaks-rules.mjs <gitleaks.toml> <commit-sha>');
  process.exit(2);
}

const toml = readFileSync(tomlPath, 'utf8');

// Clean-prose corpus: a ported rule that matches ANY of these is dropped. Keeps
// the union floor from regressing the false-positive guarantee. Mirrors the
// test suite's clean cases plus common technical prose/identifiers.
const CLEAN_PROSE = [
  'the access account balance was verified and the token refresh worked as designed here',
  '"sha256": "' + 'a'.repeat(64) + '"',
  'txHash: 0x' + 'b'.repeat(64),
  'commit abc1234 and slug a1b2c3d4 are fine',
  'the private key was rotated and stored safely',
  'id: 550e8400-e29b-41d4-a716-446655440000',
  'to: 0x' + 'Ab12'.repeat(10),
  'commit: ' + 'a1b2c3d4'.repeat(5),
  'set the _authToken setting in your npmrc',
  'version a.b.c and module x.y.z are fine',
  'the access token refresh flow worked as designed',
  'update the api key rotation policy documented in the runbook',
  'the client secret is stored in the vault, reference it by name',
  'password reset emails are sent through the notification service',
  'our github repository and gitlab mirror are both public',
  'the aws region is us-east-1 and the gcp project is billing-enabled',
  'run `npm install` then `yarn build` to compile the workspace',
  'the authorization header carries a bearer token in production',
  'connect to the database with the configured connection string',
  'rotate credentials quarterly per the security policy',
];

const blocks = toml.split(/\n\[\[rules\]\]\n/).slice(1);
const kept = [];
const dropped = [];

for (const block of blocks) {
  const id = block.match(/^id = "([^"]+)"/m)?.[1];
  const regexRaw = block.match(/^regex = '''([\s\S]*?)'''/m)?.[1];
  if (!id || !regexRaw) continue;

  // SKIP the generic high-entropy rules (our explicit non-goal).
  if (id.includes('generic')) {
    dropped.push({ id, reason: 'generic-high-entropy (skipped by policy)' });
    continue;
  }

  // Go/RE2 -> JS conversion.
  let src = regexRaw;
  let flags = 'g';
  // Inline `(?i)` appears leading OR mid-pattern (e.g. `SG\.(?i)[a-z0-9]{66}`).
  // JS only takes flags globally, so strip every occurrence and set the `i`
  // flag when any appeared - widening a case-sensitive prefix to
  // case-insensitive is acceptable (ported rules only ever widen).
  if (src.includes('(?i)')) {
    src = src.replaceAll('(?i)', '');
    flags = 'gi';
  }
  // Collapse scoped flag groups and named groups to plain non-capturing groups.
  src = src
    .replace(/\(\?i:/g, '(?:')
    .replace(/\(\?-i:/g, '(?:')
    .replace(/\(\?s:/g, '(?:')
    .replace(/\(\?m:/g, '(?:')
    .replace(/\(\?P<[A-Za-z0-9_]+>/g, '(?:');
  // POSIX character classes (Go/RE2) -> JS equivalents. They compile in JS as
  // literal char sets otherwise, silently mismatching real tokens.
  src = src
    .replace(/\[:alnum:\]/g, 'A-Za-z0-9')
    .replace(/\[:alpha:\]/g, 'A-Za-z')
    .replace(/\[:digit:\]/g, '0-9')
    .replace(/\[:xdigit:\]/g, '0-9A-Fa-f')
    .replace(/\[:upper:\]/g, 'A-Z')
    .replace(/\[:lower:\]/g, 'a-z')
    .replace(/\[:space:\]/g, '\\s')
    .replace(/\[:punct:\]/g, '!-/:-@\\[-`{-~');

  // Reject anything still carrying Go-only inline-flag or atomic/possessive
  // constructs JS cannot represent.
  if (/\(\?[a-zA-Z-]+[:)]/.test(src.replace(/\(\?:/g, '')) || /\(\?>/.test(src)) {
    dropped.push({ id, reason: 'unconvertible Go regex construct' });
    continue;
  }

  let compiled;
  try {
    compiled = new RegExp(src, flags);
  } catch (error) {
    dropped.push({ id, reason: `does not compile as JS RegExp (${error.message})` });
    continue;
  }

  // False-positive guard: drop any rule that matches clean prose.
  const trippedOn = CLEAN_PROSE.find((prose) => {
    compiled.lastIndex = 0;
    return compiled.test(prose);
  });
  if (trippedOn !== undefined) {
    dropped.push({ id, reason: `trips clean prose: ${JSON.stringify(trippedOn.slice(0, 40))}` });
    continue;
  }

  kept.push({ id, source: src, flags });
}

const header = `/**
 * Ported gitleaks vendor detector rules - GENERATED, do not edit by hand.
 * Regenerate with: node scripts/generate-gitleaks-rules.mjs <gitleaks.toml> <commit>
 *
 * Source: gitleaks default ruleset (https://github.com/gitleaks/gitleaks,
 * config/gitleaks.toml @ ${commitSha}). Licensed MIT.
 *
 * MIT License, Copyright (c) 2019 Zachary Rice (gitleaks). Full text:
 * https://github.com/gitleaks/gitleaks/blob/master/LICENSE
 *
 * Ported: ${kept.length} vendor rules. Skipped generic high-entropy rules and
 * any rule that could not convert to JS or tripped the clean-prose guard (see
 * the generator's run summary). These rules run THROUGH the floor's JSON-unescape
 * pipeline and are UNION-only additions over the hand-authored floor - they
 * never narrow existing coverage.
 */

export interface GitleaksRule {
  /** The gitleaks rule id, used as the floor hit \`kind\`. */
  kind: string;
  /** The detector pattern (Go/RE2 converted to JS; global flag applied at use). */
  pattern: RegExp;
}

export const GITLEAKS_RULES: GitleaksRule[] = [
${kept
  .map((r) => {
    // Emit via the RegExp constructor with a JSON-stringified source to keep
    // the pattern exact and avoid regex-literal escaping pitfalls.
    return `  { kind: ${JSON.stringify(`gitleaks:${r.id}`)}, pattern: new RegExp(${JSON.stringify(
      r.source,
    )}, ${JSON.stringify(r.flags)}) },`;
  })
  .join('\n')}
];
`;

const outPath = fileURLToPath(new URL('../src/scrub/data/gitleaks-rules.ts', import.meta.url));
writeFileSync(outPath, header);

// Format the generated file so regeneration stays prettier-clean and
// reproducible (matches the bip39 data file convention).
execFileSync('npx', ['prettier', '--write', '--ignore-path', '../../.prettierignore', outPath], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'ignore',
});

console.log(`ported ${kept.length} rules, dropped ${dropped.length}`);
for (const d of dropped) console.log(`  drop ${d.id}: ${d.reason}`);
