import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildProposal, buildWorkspaceProposal, parseCurateArgs } from './curate-changelog.mjs';
import {
  parseCutArgs,
  proposalCutDisposition,
  protocolVersionFromSource,
  resolveProtocolPackageVersion,
} from './cut-release.mjs';
import { publishableWorkspaces, resolveReleaseGroup } from './release-groups.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('buildProposal includes every hosted-cc workspace', () => {
  const proposal = buildProposal({ groupId: 'hosted-cc', bump: 'patch' });
  assert.equal(proposal.group, 'hosted-cc');
  for (const dir of [
    'apps/command-center/ui',
    'apps/command-center',
    'services/gateway',
    'packages/protocol',
  ]) {
    assert.ok(proposal.workspaces[dir], `missing ${dir}`);
  }
});

test('buildProposal stamps every shipped bullet while curating operator summaries', () => {
  const companion = buildWorkspaceProposal('apps/companion', [
    'chore(deps): upgrade Companion to Expo SDK 57',
    'feat(companion): add mobile Roadmap and Backlog workspaces',
  ]);
  assert.deepEqual(companion.include, [
    'chore(deps): upgrade Companion to Expo SDK 57',
    'feat(companion): add mobile Roadmap and Backlog workspaces',
  ]);
  assert.equal(companion.defer.length, 0);
  assert.ok(companion.include.some((bullet) => bullet.includes('Expo SDK 57')));
  assert.ok(companion.operatorSummary.length <= 5);
  assert.ok(!companion.operatorSummary.some((bullet) => bullet.includes('Expo SDK 57')));
});

test('cut-release parses values without consuming adjacent flags', () => {
  assert.deepEqual(parseCutArgs(['--group', 'hosted-cc', '--assist', '--execute']), {
    group: 'hosted-cc',
    bump: 'patch',
    assist: true,
    execute: true,
    proposalPath: null,
    dryRun: false,
  });
  assert.throws(() => parseCutArgs(['--bump', '--group', 'hosted-cc']), /requires a value/);
  assert.throws(() => parseCutArgs(['--group', 'hosted-cc', '--bump', 'feature']), /Invalid/);
});

test('cut-release recognizes an already-applied proposal and refuses partial drift', () => {
  const bulletA = 'feat: first change.';
  const bulletB = 'fix: second change.';
  const pending = `# Changelog\n\n## Unreleased\n\n- ${bulletA}\n- ${bulletB}\n`;
  const released = `# Changelog\n\n## Unreleased\n\n- Active-development baseline; add user-facing changes here before release or package publication.\n\n## 1.0.0 - 2026-08-10\n\n- ${bulletA}\n- ${bulletB}\n`;
  assert.equal(proposalCutDisposition(pending, [bulletA, bulletB]), 'cut');
  assert.equal(proposalCutDisposition(released, [bulletA, bulletB]), 'already-cut');
  assert.throws(() => proposalCutDisposition(pending, [bulletA, 'missing']), /partially/);
});

test('curate-changelog parses optional values without consuming adjacent flags', () => {
  assert.deepEqual(parseCurateArgs(['--group', 'companion']), {
    group: 'companion',
    bump: 'patch',
    out: '.release-cut/proposal.json',
  });
  assert.deepEqual(
    parseCurateArgs(['--group=hosted-cc', '--bump', 'minor', '--out=proposal.json']),
    { group: 'hosted-cc', bump: 'minor', out: 'proposal.json' },
  );
  assert.throws(
    () => parseCurateArgs(['--group', 'companion', '--bump', '--out', 'proposal.json']),
    /--bump requires a value/,
  );
  assert.throws(
    () => parseCurateArgs(['--group', 'companion', '--bump', 'feature']),
    /Invalid --bump/,
  );
});

test('protocol release version is idempotent and never moves behind the runtime contract', () => {
  const source = "export const PROTOCOL_VERSION = '0.20.0';\n";
  assert.equal(protocolVersionFromSource(source), '0.20.0');
  assert.equal(resolveProtocolPackageVersion('0.19.0', 'minor', '0.20.0'), '0.20.0');
  assert.equal(resolveProtocolPackageVersion('0.19.0', 'patch', '0.20.0'), '0.20.0');
  assert.equal(resolveProtocolPackageVersion('0.20.0', 'minor', '0.20.0'), '0.21.0');
  assert.throws(() => protocolVersionFromSource('export const OTHER = 1;'), /Failed to find/);
});

test('npm release group is every non-private package, dependency-first', () => {
  const workspaces = resolveReleaseGroup('npm').workspaces;
  for (const dir of [
    'packages/protocol',
    'packages/agent-runtime',
    'packages/capabilities',
    'packages/recipe-harness',
    'packages/expo-recipe',
    'packages/handoff',
    'packages/skills',
  ]) {
    assert.ok(workspaces.includes(dir), `${dir} is publishable and must be in the npm group`);
  }
  assert.ok(!workspaces.includes('packages/cli'), 'private packages never enter the npm group');
  const at = (dir) => workspaces.indexOf(dir);
  for (const dir of workspaces) {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys({
      ...(pkg.dependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    })) {
      if (!dep.startsWith('@farmslot/')) continue;
      const depDir = workspaces.find(
        (candidate) =>
          JSON.parse(readFileSync(path.join(repoRoot, candidate, 'package.json'), 'utf8')).name ===
          dep,
      );
      if (depDir) assert.ok(at(depDir) < at(dir), `${depDir} precedes its dependent ${dir}`);
    }
  }
});

test('publishableWorkspaces refuses a dependency cycle', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-groups-cycle-'));
  for (const [name, dep] of [
    ['a', '@farmslot/b'],
    ['b', '@farmslot/a'],
  ]) {
    mkdirSync(path.join(dir, name));
    writeFileSync(
      path.join(dir, name, 'package.json'),
      JSON.stringify({
        name: `@farmslot/${name}`,
        version: '0.0.0',
        dependencies: { [dep]: 'workspace:*' },
      }),
    );
  }
  assert.throws(() => publishableWorkspaces(dir), /dependency cycle through @farmslot\/(a|b)/);
});

test('cut-release rejects proposal workspaces outside release group', () => {
  const proposal = buildProposal({ groupId: 'hosted-cc', bump: 'patch' });
  proposal.workspaces['packages/cli'] = { include: ['Hack'], defer: [], operatorSummary: ['Hack'] };
  const proposalDir = path.join(repoRoot, '.release-cut');
  mkdirSync(proposalDir, { recursive: true });
  const proposalPath = path.join(proposalDir, 'bad-proposal.json');
  writeFileSync(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  const result = spawnSync(
    'node',
    [
      'scripts/release/cut-release.mjs',
      '--group',
      'hosted-cc',
      '--from-proposal',
      '.release-cut/bad-proposal.json',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr ?? result.stdout, /not in release group/i);
});
