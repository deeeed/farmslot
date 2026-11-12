// Opt-in real Git transfer proof; subprocess allocation exceeds the default five-second test budget.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
  const runtime = path.join(source, 'ignored.tmp');
  writeFileSync(runtime, 'Retained runtime data\n');
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
  assert.equal(readFileSync(runtime, 'utf8'), 'Retained runtime data\n');
  assert.deepEqual(f.execute('allocate', changes, false, extra), { state: 'ready' });
  const previousIdentity = { ...f.identity, ...changes };
  writeFileSync(path.join(taskPath, '.terminal-cancelled'), changes.runId);
  f.execute('cancel', changes);
  const retry = { ...changes, runId: 'retry-run' };
  const retryExtra = {
    previousIdentity,
    previousTaskPath: taskPath,
    taskPath: path.join(f.workspace, 'tasks', retry.runId),
  };
  assert.deepEqual(f.execute('allocate', retry, false, retryExtra), { state: 'ready' });
  assert.throws(() => f.execute('cleanup', changes), /Workspace identity conflict/);
  assert.throws(() => f.execute('cleanup'), /Workspace identity conflict/);
  assert.equal(readFileSync(path.join(source, 'source.txt'), 'utf8'), 'next head\n');
  assert.throws(() => f.execute('cleanup', retry, false, retryExtra), /refusing to discard/);
  assert.equal(readFileSync(runtime, 'utf8'), 'Retained runtime data\n');
  unlinkSync(runtime);
  assert.deepEqual(f.execute('cleanup', retry, false, retryExtra), { state: 'cleaned' });
  assert.equal(readFileSync(path.join(oldTask, 'report.md'), 'utf8'), 'Original review evidence\n');
});
