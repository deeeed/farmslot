import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('post-review dry run renders the exact reviewed commit', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'post-review-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const poolDir = path.join(fixtureRoot, 'pool');
  const repoDir = path.join(fixtureRoot, 'repo');
  const artifactDir = path.join(repoDir, 'task', 'artifacts');
  fs.mkdirSync(poolDir, { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'review.md'), '# Review\n\n## Summary\n\nPass.\n');
  fs.writeFileSync(
    path.join(poolDir, 'test.json'),
    JSON.stringify({
      machine: 'test',
      project: 'farmslot-farm',
      platform: 'cli',
      host: 'localhost',
      ssh_user: 'test',
      slots: [{ id: 'test-review', repo: repoDir, session: 'review' }],
    }),
  );
  const commitId = 'c43949daf0c2a35f4a293f7078b5a00d3afa036b';

  const args = [
    path.join(root, 'scripts/post-review.sh'),
    '--pr',
    '489',
    '--repo',
    'deeeed/farmslot',
    '--commit-id',
    commitId,
    '--slot',
    'test-review',
    '--task-dir',
    'task',
    '--recommendation',
    'COMMENT',
    '--skip-session-usage',
    '--skip-artifact-upload',
    '--skip-archive',
    '--dry-run',
  ];
  const options = {
    cwd: root,
    env: { ...process.env, FARMSLOT_POOL_DIR: poolDir },
    encoding: 'utf8',
  };
  const output = execFileSync('bash', args, options);

  assert.match(output, new RegExp(`Reviewed commit.*${commitId}`));
  assert.match(output, new RegExp(`Reviewed commit.*${commitId}.*\\n\\| \\*\\*Tier\\*\\* \\|`));
  assert.doesNotMatch(output, /\| \*\*Runner\*\* \|/);
  assert.doesNotMatch(output, /\| \*\*Cost\*\* \|/);

  const metricsOutput = execFileSync(
    'bash',
    [...args.slice(0, -1), '--include-internal-metrics', '--dry-run'],
    { cwd: root, env: { ...process.env, FARMSLOT_POOL_DIR: poolDir }, encoding: 'utf8' },
  );
  assert.match(metricsOutput, /\| \*\*Runner\*\* \| unknown \/ unknown \|/);
  assert.match(metricsOutput, /\| \*\*Cost\*\* \| N\/A \(N\/A tokens\) \|/);
});
