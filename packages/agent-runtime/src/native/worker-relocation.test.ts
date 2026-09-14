import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { NativeSessionClient } from './client.js';
import { decodeRequest } from './ipc.js';
import { NativeSessionManager } from './manager.js';
import { NATIVE_WORKER_RESUME, type NativeWorkerLaunch } from './worker-launch.js';

const executable = `#!/usr/bin/env node
if(process.argv.includes('--version')) { console.log('fixture 1'); process.exit(0); }
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:m.params.threadId||'saved-conversation'}}});
});
`;

test('worker relocation preserves lease/account and requires an explicit sibling-worktree move', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-relocation-'));
  const source = join(root, 'source');
  const target = join(root, 'target');
  const unrelated = join(root, 'unrelated');
  const binary = join(root, 'codex');
  writeFileSync(binary, executable);
  chmodSync(binary, 0o700);
  const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(['init', source]);
  git(
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'test: initialize fixture',
    ],
    source,
  );
  git(['worktree', 'add', '-b', 'target', target], source);
  git(['init', unrelated]);
  const manager = new NativeSessionManager(join(root, 'state'));
  const launch: NativeWorkerLaunch = {
    leaseId: randomUUID(),
    executable: binary,
    accountLabel: 'original',
    safetyTier: 'full-auto',
    environment: { set: { CODEX_HOME: join(root, 'account') }, unset: [] },
  };
  let sessionId: string | undefined;
  try {
    const before = await manager.ensure(
      'owner',
      { sessionId: randomUUID(), runner: 'codex', cwd: source },
      launch,
    );
    sessionId = before.id;
    const params = {
      sessionId: before.id,
      resumeSessionId: before.nativeSessionId,
      runner: 'codex',
      cwd: target,
      generation: before.generation,
      commandId: randomUUID(),
    };
    await assert.rejects(
      manager.resumeWorker('owner', { ...params, relocation: { fromCwd: source } }, launch),
      /Close the current/,
    );
    await manager.closeWorker('owner', before.id, before.generation, launch.leaseId);
    await assert.rejects(manager.resumeWorker('owner', params, launch), /working directory/);
    await assert.rejects(
      manager.resumeWorker('owner', { ...params, relocation: { fromCwd: unrelated } }, launch),
      /exact previous workspace/,
    );
    await assert.rejects(
      manager.resumeWorker(
        'owner',
        { ...params, cwd: unrelated, relocation: { fromCwd: source } },
        launch,
      ),
      /sibling worktrees/,
    );
    await assert.rejects(
      manager.resumeWorker(
        'owner',
        { ...params, relocation: { fromCwd: source } },
        { ...launch, accountLabel: 'other' },
      ),
      /account execution context/,
    );
    const cancelledCommand = randomUUID();
    await manager.cancelWorker(
      'owner',
      before.id,
      launch.leaseId,
      before.generation,
      undefined,
      cancelledCommand,
    );
    await assert.rejects(
      manager.resumeWorker(
        'owner',
        { ...params, commandId: cancelledCommand, relocation: { fromCwd: source } },
        launch,
      ),
      /cancelled before launch/,
    );
    const next = await manager.resumeWorker(
      'owner',
      { ...params, relocation: { fromCwd: source } },
      launch,
    );
    assert.equal(next.id, before.id);
    assert.equal(next.nativeSessionId, before.nativeSessionId);
    assert.equal(next.workerLeaseId, launch.leaseId);
    assert.equal(next.cwd, target);
    assert.notEqual(next.generation, before.generation);
    await assert.rejects(
      manager.resumeWorker('owner', { ...params, relocation: { fromCwd: source } }, launch),
      /generation|lease/i,
    );
  } finally {
    if (sessionId) await manager.close('owner', sessionId);
    rmSync(root, { recursive: true, force: true });
  }
});

test('private state routing separates owners and IPC preserves explicit relocation', () => {
  const client = new NativeSessionClient('/private/native-state');
  const sessionId = randomUUID();
  assert.notEqual(
    client.workerStateDirectory('one', sessionId),
    client.workerStateDirectory('two', sessionId),
  );
  assert.ok(
    client.workerStateDirectory('one', sessionId).startsWith('/private/native-state/workers/'),
  );
  const request = decodeRequest({
    method: NATIVE_WORKER_RESUME,
    owner: 'owner',
    params: {
      sessionId,
      runner: 'codex',
      cwd: '/target',
      generation: 'generation',
      commandId: 'command',
      resumeSessionId: 'saved',
      relocation: { fromCwd: '/source' },
    },
    launch: { leaseId: randomUUID(), safetyTier: 'full-auto', environment: { set: {}, unset: [] } },
  });
  assert.equal(request.method, NATIVE_WORKER_RESUME);
  if (request.method !== NATIVE_WORKER_RESUME) throw new Error('Wrong request');
  assert.deepEqual(request.params.relocation, { fromCwd: '/source' });
});
