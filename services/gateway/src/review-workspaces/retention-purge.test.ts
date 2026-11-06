import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { REVIEW_WORKSPACE_SCRIPT } from './workspace-node.js';

function fixture(t: { after: (fn: () => void) => void }, allocated = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-expiry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'owned');
  const workspaceId = randomUUID(),
    sessionId = randomUUID();
  const identity = {
    runId: 'run',
    workspaceId,
    owner: 'owner',
    project: 'project',
    machine: 'node',
    executionNodeId: 'local',
    repositoryUrl: 'https://example.invalid/repo.git',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
  };
  const workspace = path.join(root, 'runs', workspaceId),
    cwd = path.join(workspace, 'source');
  const write = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  write(path.join(workspace, 'identity.json'), identity);
  write(path.join(workspace, 'allocation.json'), { state: 'cleaned' });
  write(path.join(workspace, 'task/report.json'), { verdict: 'APPROVE' });
  const cacheIdentity = {
    owner: identity.owner,
    project: identity.project,
    repositoryUrl: identity.repositoryUrl,
  };
  const key = createHash('sha256').update(JSON.stringify(cacheIdentity)).digest('hex');
  write(path.join(root, 'repositories', key + '.json'), cacheIdentity);
  const record = path.join(dir, 'run-records/run.json');
  write(record, { id: 'run', reviewedHead: identity.headSha });
  const transcript = path.join(dir, 'sessions', 'rollout-' + sessionId + '.jsonl');
  write(transcript, { type: 'session_meta', payload: { id: sessionId, cwd } });
  if (allocated) {
    fs.rmSync(workspace, { recursive: true });
    const upstream = path.join(dir, 'upstream');
    fs.mkdirSync(upstream);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: upstream,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git('init');
    fs.writeFileSync(path.join(upstream, 'source.txt'), 'retained source\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'fixture',
    );
    identity.repositoryUrl = upstream;
    identity.headSha = identity.baseSha = git('rev-parse', 'HEAD');
    execFileSync(
      process.execPath,
      ['-e', REVIEW_WORKSPACE_SCRIPT, JSON.stringify({ root, identity, action: 'allocate' })],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }
  const execute = (changes: Record<string, unknown> = {}) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          REVIEW_WORKSPACE_SCRIPT,
          JSON.stringify({
            root,
            identity,
            action: 'purge',
            session: { runnerSessionId: sessionId, format: 'codex-jsonl', path: transcript, cwd },
            ...changes,
          }),
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  return { dir, root, workspace, cwd, identity, sessionId, transcript, record, write, execute };
}

test('expiry removes only the owned workspace/conversation and preserves run records, idempotently', (t) => {
  const f = fixture(t);
  const record = fs.readFileSync(f.record, 'utf8');
  assert.deepEqual(f.execute(), { state: 'purged' });
  assert.equal(fs.existsSync(f.workspace), false);
  assert.equal(fs.existsSync(f.transcript), false);
  assert.equal(fs.readFileSync(f.record, 'utf8'), record);
  assert.deepEqual(f.execute(), { state: 'purged' });
});

test('foreign conversation metadata cannot authorize transcript deletion', (t) => {
  const f = fixture(t, true);
  f.write(f.transcript, { type: 'session_meta', payload: { id: 'foreign', cwd: f.cwd } });
  assert.throws(() => f.execute(), /does not match the review/);
  assert.ok(fs.existsSync(f.transcript));
  assert.ok(fs.existsSync(f.record));
  assert.equal(fs.readFileSync(path.join(f.cwd, 'source.txt'), 'utf8'), 'retained source\n');
});

test('a live explicit resume process protects its conversation file', async (t) => {
  const f = fixture(t, true);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', f.sessionId], {
    stdio: 'ignore',
  });
  await once(child, 'spawn');
  try {
    assert.throws(() => f.execute(), /live resume process/);
    assert.ok(fs.existsSync(f.transcript));
    assert.ok(fs.existsSync(path.join(f.cwd, 'source.txt')));
  } finally {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await exit;
  }
});
