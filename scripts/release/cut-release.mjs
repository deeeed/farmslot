#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadWorkspacePackages, readJson } from './lib/workspace-utils.mjs';
import { buildProposal, optionValue } from './curate-changelog.mjs';
import {
  applyChangelogCut,
  bumpSemver,
  compareSemver,
  parseBullets,
  unreleasedMeaningfulBullets,
} from './parse-changelog.mjs';
import { resolveReleaseGroup } from './release-groups.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VALID_BUMPS = new Set(['patch', 'minor', 'major']);

const RELEASE_NOTES_TARGETS = {
  'apps/command-center/ui': 'apps/command-center/ui/src/generated/release-notes.json',
  'services/gateway': 'services/gateway/release-notes.json',
  'apps/companion': 'apps/companion/src/generated/release-notes.json',
};

export function parseCutArgs(argv) {
  const bump = optionValue(argv, '--bump') ?? 'patch';
  if (!VALID_BUMPS.has(bump)) {
    throw new Error(`Invalid --bump '${bump}' (expected patch, minor, or major)`);
  }
  return {
    group: optionValue(argv, '--group') ?? null,
    bump,
    assist: argv.includes('--assist'),
    execute: argv.includes('--execute'),
    proposalPath: optionValue(argv, '--from-proposal') ?? null,
    dryRun: !argv.includes('--execute'),
  };
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
  if (groupId === 'npm' && proposal.workspaces['packages/protocol']?.include?.length > 0) {
    const hostedOnly = resolveReleaseGroup('hosted-cc').workspaces.filter(
      (dir) => dir !== 'packages/protocol',
    );
    const pendingHosted = hostedOnly.filter((dir) => {
      const changelog = readFileSync(path.join(repoRoot, dir, 'CHANGELOG.md'), 'utf8');
      return unreleasedMeaningfulBullets(changelog).length > 0;
    });
    if (pendingHosted.length > 0) {
      throw new Error(
        `Cut hosted-cc before npm while protocol changes are pending; unreleased hosted workspaces: ${pendingHosted.join(', ')}`,
      );
    }
  }
}

export function protocolVersionFromSource(content) {
  const match = content.match(/export const PROTOCOL_VERSION = '([^']+)';/);
  if (!match)
    throw new Error('Failed to find PROTOCOL_VERSION in packages/protocol/src/version.ts');
  return match[1];
}

export function resolveProtocolPackageVersion(packageVersion, bump, protocolVersion) {
  const requested = bumpSemver(packageVersion, bump);
  return compareSemver(protocolVersion, requested) > 0 ? protocolVersion : requested;
}

export function proposalCutDisposition(changelogContent, include) {
  const pending = new Set(unreleasedMeaningfulBullets(changelogContent));
  const pendingCount = include.filter((bullet) => pending.has(bullet)).length;
  if (pendingCount === include.length) return 'cut';
  if (pendingCount > 0) {
    throw new Error('Release proposal only partially matches the current Unreleased section');
  }
  const archived = new Set(parseBullets(changelogContent));
  if (include.every((bullet) => archived.has(bullet))) return 'already-cut';
  throw new Error('Release proposal does not match the current changelog');
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
    const changelogPath = path.join(repoRoot, dir, 'CHANGELOG.md');
    const content = readFileSync(changelogPath, 'utf8');
    if (proposalCutDisposition(content, entry.include) === 'already-cut') {
      console.log(`[skip] ${dir} — proposal already cut`);
      continue;
    }
    let nextVersion = bumpSemver(pkg.version, proposal.bump);
    if (dir === 'packages/protocol') {
      const versionSource = readFileSync(
        path.join(repoRoot, 'packages/protocol/src/version.ts'),
        'utf8',
      );
      nextVersion = resolveProtocolPackageVersion(
        pkg.version,
        proposal.bump,
        protocolVersionFromSource(versionSource),
      );
    }
    versionByDir.set(dir, nextVersion);

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
      const currentProtocolVersion = protocolVersionFromSource(content);
      if (compareSemver(currentProtocolVersion, protocolVersion) > 0) {
        throw new Error(
          `Refusing to downgrade PROTOCOL_VERSION ${currentProtocolVersion} → ${protocolVersion}`,
        );
      }
      const versionPattern = /export const PROTOCOL_VERSION = '[^']+';/;
      const next = content.replace(
        versionPattern,
        `export const PROTOCOL_VERSION = '${protocolVersion}';`,
      );
      if (next !== content) {
        writes.push({ path: versionTs, content: next });
        console.log(`[plan] PROTOCOL_VERSION → ${protocolVersion}`);
      } else {
        console.log(`[skip] PROTOCOL_VERSION already ${protocolVersion}`);
      }
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
  if (commitParts.length > 0) {
    console.log(`\nSuggested commit: chore(release): cut ${commitParts.join(', ')}`);
  } else {
    console.log('\nNo release changes planned.');
  }
}

function main() {
  let args;
  try {
    args = parseCutArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
