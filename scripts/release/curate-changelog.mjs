#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadWorkspacePackages } from './lib/workspace-utils.mjs';
import { parseChangelog } from './parse-changelog.mjs';
import { resolveReleaseGroup } from './release-groups.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFER_PATTERNS = [
  /\brefactor\b/i,
  /\binternal\b/i,
  /\bchore\b/i,
  /\bci\b/i,
  /\btest(?:s|ing)?\b/i,
  /\bdocs?\b/i,
  /\blint\b/i,
  /\btyping\b/i,
  /\bquality gate\b/i,
  /\bagent template\b/i,
  /\bplaceholder\b/i,
];

function classifyBullet(bullet) {
  return DEFER_PATTERNS.some((pattern) => pattern.test(bullet)) ? 'defer' : 'include';
}

function rewriteForOperator(bullet) {
  return bullet
    .replace(/^Add\s+/i, '')
    .replace(/^Show\s+/i, 'View ')
    .replace(/\.$/, '')
    .trim();
}

function buildWorkspaceProposal(dir, bullets) {
  const include = [];
  const defer = [];
  for (const bullet of bullets) {
    if (classifyBullet(bullet) === 'defer') defer.push(bullet);
    else include.push(rewriteForOperator(bullet));
  }
  return {
    include,
    defer,
    operatorSummary: include.slice(0, 5),
  };
}

function dedupeSummaries(workspaces) {
  const seen = new Set();
  for (const entry of Object.values(workspaces)) {
    entry.operatorSummary = entry.operatorSummary.filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

export function buildProposal({ groupId, bump = 'patch' }) {
  const group = resolveReleaseGroup(groupId);
  const packages = loadWorkspacePackages(repoRoot);
  const workspaces = {};

  for (const dir of group.workspaces) {
    const pkg = packages.get(dir);
    if (!pkg) throw new Error(`Workspace not found: ${dir}`);
    const changelogPath = path.join(repoRoot, dir, 'CHANGELOG.md');
    const content = readFileSync(changelogPath, 'utf8');
    const parsed = parseChangelog(changelogPath, content);
    workspaces[dir] = buildWorkspaceProposal(dir, parsed.unreleased);
  }

  dedupeSummaries(workspaces);

  return {
    group: groupId,
    bump,
    createdAt: new Date().toISOString(),
    workspaces,
  };
}

function printProposalSummary(proposal) {
  console.log(`Release proposal for group '${proposal.group}' (${proposal.bump}):`);
  for (const [dir, entry] of Object.entries(proposal.workspaces)) {
    console.log(`\n${dir}`);
    console.log(`  include (${entry.include.length}):`);
    for (const line of entry.include) console.log(`    - ${line}`);
    console.log(`  defer (${entry.defer.length}):`);
    for (const line of entry.defer) console.log(`    - ${line}`);
    console.log(`  operatorSummary:`);
    for (const line of entry.operatorSummary) console.log(`    * ${line}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const groupIndex = args.indexOf('--group');
  const bumpIndex = args.indexOf('--bump');
  const outIndex = args.indexOf('--out');
  const groupArg =
    args.find((arg) => arg.startsWith('--group='))?.slice('--group='.length) ??
    (groupIndex >= 0 ? args[groupIndex + 1] : undefined);
  const bumpArg =
    args.find((arg) => arg.startsWith('--bump='))?.slice('--bump='.length) ??
    (bumpIndex >= 0 ? args[bumpIndex + 1] : undefined) ??
    'patch';
  const outArg =
    args.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) ??
    (outIndex >= 0 ? args[outIndex + 1] : undefined) ??
    '.release-cut/proposal.json';

  if (!groupArg) {
    console.error(
      'Usage: node scripts/release/curate-changelog.mjs --group <id> [--bump patch|minor|major] [--out path]',
    );
    process.exit(1);
  }

  const proposal = buildProposal({ groupId: groupArg, bump: bumpArg });
  const outPath = path.resolve(repoRoot, outArg);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  printProposalSummary(proposal);
  console.log(`\nWrote ${path.relative(repoRoot, outPath)}`);
  console.log('Review/edit the proposal, then run cut-release with --from-proposal --execute.');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
