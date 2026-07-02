#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadWorkspacePackages } from './lib/workspace-utils.mjs';
import { extractSection, meaningfulBullets } from './parse-changelog.mjs';
import { RELEASE_GROUPS } from './release-groups.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function scanWorkspace(dir, pkg) {
  const changelogPath = path.join(repoRoot, dir, 'CHANGELOG.md');
  const content = readFileSync(changelogPath, 'utf8');
  const unreleased = extractSection(content, (line) => /^##\s+Unreleased\b/i.test(line));
  const bullets = unreleased ? meaningfulBullets(unreleased.body) : [];
  return {
    dir,
    name: pkg.name,
    version: pkg.version,
    unreleasedCount: bullets.length,
    unreleased: bullets,
  };
}

function verdictForGroup(group, scans) {
  const groupScans = group.workspaces
    .map((dir) => scans.find((scan) => scan.dir === dir))
    .filter(Boolean);
  const total = groupScans.reduce((sum, scan) => sum + scan.unreleasedCount, 0);
  if (total === 0) return 'NO';
  if (total < 3) return 'SOON';
  return 'YES';
}

function main() {
  const packages = loadWorkspacePackages(repoRoot);
  const scans = [...packages.entries()].map(([dir, pkg]) => scanWorkspace(dir, pkg));

  console.log('Farmslot release status\n');
  for (const group of RELEASE_GROUPS) {
    const groupScans = group.workspaces
      .map((dir) => scans.find((scan) => scan.dir === dir))
      .filter(Boolean);
    const verdict = verdictForGroup(group, scans);
    const total = groupScans.reduce((sum, scan) => sum + scan.unreleasedCount, 0);
    console.log(`${group.id} [${verdict}] — ${total} meaningful Unreleased bullet(s)`);
    for (const scan of groupScans) {
      console.log(`  ${scan.name}@${scan.version}: ${scan.unreleasedCount}`);
      for (const bullet of scan.unreleased.slice(0, 3)) console.log(`    - ${bullet}`);
      if (scan.unreleased.length > 3) console.log(`    … +${scan.unreleased.length - 3} more`);
    }
    console.log('');
  }

  const anyYes = RELEASE_GROUPS.some((group) => verdictForGroup(group, scans) === 'YES');
  const anySoon = RELEASE_GROUPS.some((group) => verdictForGroup(group, scans) === 'SOON');
  const overall = anyYes ? 'YES' : anySoon ? 'SOON' : 'NO';
  console.log(`Overall: ${overall}`);
  if (overall === 'YES') {
    console.log('Next: yarn release:cut --group hosted-cc --assist');
    console.log(
      'Then: yarn release:cut --group hosted-cc --from-proposal .release-cut/proposal.json --execute',
    );
  }
}

main();
