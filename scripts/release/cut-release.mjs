#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadWorkspacePackages, readJson } from './lib/workspace-utils.mjs';
import { buildProposal } from './curate-changelog.mjs';
import { applyChangelogCut, bumpSemver } from './parse-changelog.mjs';
import { resolveReleaseGroup } from './release-groups.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VALID_BUMPS = new Set(['patch', 'minor', 'major']);

const RELEASE_NOTES_TARGETS = {
  'apps/command-center/ui': 'apps/command-center/ui/src/generated/release-notes.json',
  'services/gateway': 'services/gateway/release-notes.json',
  'apps/companion': 'apps/companion/src/generated/release-notes.json',
};

function parseArgs(argv) {
  const args = {
    group: null,
    bump: 'patch',
    assist: false,
    execute: false,
    proposalPath: null,
    dryRun: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--assist') args.assist = true;
    else if (arg === '--execute') {
      args.execute = true;
      args.dryRun = false;
    } else if (arg.startsWith('--group=')) args.group = arg.slice('--group='.length);
    else if (arg === '--group') args.group = argv[++i];
    else if (arg.startsWith('--bump=')) args.bump = arg.slice('--bump='.length);
    else if (arg === '--bump') args.bump = argv[++i];
    else if (arg.startsWith('--from-proposal='))
      args.proposalPath = arg.slice('--from-proposal='.length);
    else if (arg === '--from-proposal') args.proposalPath = argv[++i];
  }
  return args;
}

function loadProposal(proposalPath) {
  const absolute = path.resolve(repoRoot, proposalPath);
  return JSON.parse(readFileSync(absolute, 'utf8'));
}

function validateProposal(proposal, groupId) {
  const group = resolveReleaseGroup(groupId);
  if (proposal.group !== groupId) {
    throw new Error(`Proposal group '${proposal.group}' does not match '${groupId}'`);
  }
  if (!VALID_BUMPS.has(proposal.bump)) {
    throw new Error(`Proposal bump '${proposal.bump}' must be patch, minor, or major`);
  }
  const allowed = new Set(group.workspaces);
  const proposalDirs = Object.keys(proposal.workspaces ?? {});
  const unknown = proposalDirs.filter((dir) => !allowed.has(dir));
  if (unknown.length > 0) {
    throw new Error(
      `Proposal workspaces [${unknown.join(', ')}] are not in release group '${groupId}'`,
    );
  }
  for (const dir of group.workspaces) {
    if (!proposal.workspaces[dir]) {
      throw new Error(`Proposal missing required workspace entry: ${dir}`);
    }
  }
}

function planCut(proposal) {
  const packages = loadWorkspacePackages(repoRoot);
  const date = new Date().toISOString().slice(0, 10);
  const versionByDir = new Map();
  const writes = [];
  const commitParts = [];

  for (const [dir, entry] of Object.entries(proposal.workspaces)) {
    const pkg = packages.get(dir);
    if (!pkg) throw new Error(`Unknown workspace: ${dir}`);
    if (!entry.include?.length) {
      console.log(`[skip] ${dir} — no bullets to release`);
      continue;
    }
    const nextVersion = bumpSemver(pkg.version, proposal.bump);
    versionByDir.set(dir, nextVersion);

    const changelogPath = path.join(repoRoot, dir, 'CHANGELOG.md');
    const content = readFileSync(changelogPath, 'utf8');
    const nextChangelog = applyChangelogCut(content, {
      version: nextVersion,
      date,
      include: entry.include,
      defer: entry.defer,
    });
    writes.push({ path: changelogPath, content: nextChangelog });
    console.log(`[plan] ${dir}/CHANGELOG.md → ${nextVersion}`);

    const pkgPath = path.join(repoRoot, dir, 'package.json');
    const pkgJson = readJson(pkgPath);
    pkgJson.version = nextVersion;
    writes.push({ path: pkgPath, content: `${JSON.stringify(pkgJson, null, 2)}\n` });
    console.log(`[plan] ${pkg.name} → ${nextVersion}`);
    commitParts.push(`${path.basename(dir)}@${nextVersion}`);

    const notesTarget = RELEASE_NOTES_TARGETS[dir];
    if (notesTarget && entry.operatorSummary?.length) {
      const absolute = path.join(repoRoot, notesTarget);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writes.push({
        path: absolute,
        content: `${JSON.stringify({ version: nextVersion, date, items: entry.operatorSummary }, null, 2)}\n`,
      });
      console.log(`[plan] ${notesTarget}`);
    }
  }

  if (proposal.workspaces['packages/protocol']) {
    const protocolVersion = versionByDir.get('packages/protocol');
    if (protocolVersion) {
      const versionTs = path.join(repoRoot, 'packages/protocol/src/version.ts');
      const content = readFileSync(versionTs, 'utf8');
      const next = content.replace(
        /export const PROTOCOL_VERSION = '[^']+';/,
        `export const PROTOCOL_VERSION = '${protocolVersion}';`,
      );
      if (next === content) {
        throw new Error('Failed to update PROTOCOL_VERSION in packages/protocol/src/version.ts');
      }
      writes.push({ path: versionTs, content: next });
      console.log(`[plan] PROTOCOL_VERSION → ${protocolVersion}`);
    }
  }

  return { writes, commitParts };
}

function applyCut(proposal, dryRun) {
  const { writes, commitParts } = planCut(proposal);
  if (!dryRun) {
    for (const write of writes) {
      writeFileSync(write.path, write.content, 'utf8');
    }
  }
  console.log(`\nSuggested commit: chore(release): cut ${commitParts.join(', ')}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.group) {
    console.error(
      'Usage: node scripts/release/cut-release.mjs --group <id> [--assist] [--bump patch|minor|major] [--from-proposal path] [--execute]',
    );
    process.exit(1);
  }

  resolveReleaseGroup(args.group);

  if (args.assist) {
    const proposal = buildProposal({ groupId: args.group, bump: args.bump });
    const outPath = path.join(repoRoot, '.release-cut', 'proposal.json');
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${path.relative(repoRoot, outPath)}`);
    console.log(
      'Review the proposal, then re-run with --from-proposal .release-cut/proposal.json --execute',
    );
    return;
  }

  if (!args.proposalPath) {
    console.error('Refusing to cut without a reviewed proposal. Run with --assist first.');
    process.exit(1);
  }

  try {
    const proposal = loadProposal(args.proposalPath);
    validateProposal(proposal, args.group);
    applyCut(proposal, args.dryRun);
    if (args.dryRun) console.log('\nDry-run only. Pass --execute to write files.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
