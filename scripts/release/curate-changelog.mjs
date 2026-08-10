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

function isOperatorFacing(bullet) {
  return !DEFER_PATTERNS.some((pattern) => pattern.test(bullet));
}

function rewriteForOperator(bullet) {
  return bullet
    .replace(/^Add\s+/i, '')
    .replace(/^Show\s+/i, 'View ')
    .replace(/\.$/, '')
    .trim();
}

export function buildWorkspaceProposal(dir, bullets) {
  const include = [...bullets];
  const operatorSummary = bullets.filter(isOperatorFacing).map(rewriteForOperator).slice(0, 5);
  return {
    include,
    defer: [],
    operatorSummary,
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

export function optionValue(args, name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export function parseCurateArgs(args) {
  const group = optionValue(args, '--group');
  const bump = optionValue(args, '--bump') ?? 'patch';
  const out = optionValue(args, '--out') ?? '.release-cut/proposal.json';
  if (!['patch', 'minor', 'major'].includes(bump)) {
    throw new Error(`Invalid --bump '${bump}' (expected patch, minor, or major)`);
  }
  return { group, bump, out };
}

function main() {
  const { group: groupArg, bump: bumpArg, out: outArg } = parseCurateArgs(process.argv.slice(2));

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
