import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildProposal } from './curate-changelog.mjs';

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
