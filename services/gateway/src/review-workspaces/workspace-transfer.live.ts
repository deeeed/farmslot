// Opt-in real Git transfer proof; subprocess allocation exceeds the default five-second test budget.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { workspaceGitFixture as fixture } from './workspace-git.test-support.js';

test('a stopped reviewer transfers its source checkout and preserves predecessor reports', (t) => {
  const f = fixture(t);
  f.execute();
  const source = path.join(f.workspace, 'source');
  const oldTask = path.join(f.workspace, 'task');
  writeFileSync(path.join(oldTask, '.terminal-cancelled'), f.identity.runId);
  writeFileSync(path.join(oldTask, 'report.md'), 'Original review evidence\n');
  writeFileSync(path.join(f.source, 'source.txt'), 'next head\n');
  f.git('add', '.');
  f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'next');
  const headSha = f.git('rev-parse', 'HEAD');
  const changes = { runId: 'successor-run', baseSha: f.identity.headSha, headSha };
  const taskPath = path.join(f.workspace, 'tasks', changes.runId);
  const extra = { previousIdentity: f.identity, previousTaskPath: oldTask, taskPath };
  assert.deepEqual(f.execute('allocate', changes, false, extra), { state: 'ready' });
  assert.equal(
    execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    headSha,
  );
  assert.equal(readFileSync(path.join(oldTask, 'report.md'), 'utf8'), 'Original review evidence\n');
  assert(existsSync(path.join(taskPath, 'artifacts')));
  assert.deepEqual(f.execute('allocate', changes, false, extra), { state: 'ready' });
  assert.throws(() => f.execute('cleanup'), /Workspace identity conflict/);
  assert.equal(readFileSync(path.join(source, 'source.txt'), 'utf8'), 'next head\n');
  assert.deepEqual(f.execute('cleanup', changes, false, extra), { state: 'cleaned' });
  assert.equal(readFileSync(path.join(oldTask, 'report.md'), 'utf8'), 'Original review evidence\n');
});
