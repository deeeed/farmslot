// @farmslot:serial. Drives detached host crash recovery and OS process censuses.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { NativeSessionClient } from './client.js';
import { setup, until } from './durability.test-support.js';
import { type HostIdentity, requestHost, socketDirectory } from './ipc.js';
import { alive, readJson, type RecordedProcess, recordedProcessAlive } from './storage.js';

test('local host survives caller exit, authenticates IPC, replays once and cleans host-crash descendants', async () => {
  const fixture = setup({ manualTurns: true });
  const { cwd, root } = fixture;
  const client = new NativeSessionClient(root);
  try {
    // Two independent clients race the first daemon launch.
    assert.deepEqual(await Promise.all([client.warm(), new NativeSessionClient(root).warm()]), [
      undefined,
      undefined,
    ]);
    const host = readJson<HostIdentity>(join(root, 'host.json'));
    // Cleanup must work even when periodic observation misses the runner's descendants.
    process.kill(-host.pid, 'SIGSTOP');
    const worker = readJson<RecordedProcess>(join(root, 'worker.json'));
    process.kill(worker.pid, 'SIGCONT');
    assert.ok(Buffer.byteLength(host.socket) < 104);
    assert.equal(statSync(host.socket).mode & 0o777, 0o600);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    await assert.rejects(
      requestHost({ ...host, token: '0'.repeat(64) }, { method: 'list', owner: 'owner' }),
      /authentication/,
    );
    const callerFile = join(cwd, 'caller.mjs');
    const clientUrl = new URL(
      `./client.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
      import.meta.url,
    ).href;
    writeFileSync(
      callerFile,
      `import {NativeSessionClient} from ${JSON.stringify(clientUrl)}; const c=new NativeSessionClient(${JSON.stringify(root)});const s=await c.create('owner',{runner:'codex',cwd:${JSON.stringify(cwd)}});await c.send('owner',s.id,'once','side-effect');console.log(JSON.stringify(s));`,
    );
    const caller = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), callerFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    caller.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    caller.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const [code] = await once(caller, 'exit');
    assert.equal(code, 0, stderr);
    const session = JSON.parse(output) as {
      id: string;
      nativeSessionId: string;
      hostPid: number;
      processPid: number;
    };
    assert.ok(alive(session.processPid));
    assert.equal(existsSync(join(cwd, 'effects')), false, 'Task completed before caller exit');
    await fixture.completeTurn();
    await until(() => existsSync(join(cwd, 'effects')));
    await until(async () => (await client.read('owner', session.id)).session.state === 'idle');
    const reconnected = new NativeSessionClient(root);
    const replay = [];
    let cursor = 0;
    let more = true;
    while (more) {
      const page = await reconnected.read('owner', session.id, cursor, 23);
      replay.push(...page.events);
      cursor = page.cursor;
      more = page.hasMore;
    }
    assert.equal(new Set(replay.map((event) => event.sequence)).size, replay.length);
    assert.equal((await reconnected.read('owner', session.id, cursor)).events.length, 0);
    assert.equal((await reconnected.read('owner', session.id)).session.hostPid, session.hostPid);
    await reconnected.send('owner', session.id, 'once', 'side-effect');
    assert.equal(readFileSync(join(cwd, 'effects'), 'utf8'), 'side-effect\n');
    await reconnected.send('owner', session.id, 'approval', 'approval');
    await until(async () => (await client.read('owner', session.id)).pendingRequests.length === 1);
    const secondCwd = join(cwd, 'second');
    mkdirSync(secondCwd);
    const second = await client.create('owner', { runner: 'codex', cwd: secondCwd });
    assert.notEqual(second.nativeSessionId, session.nativeSessionId);
    const pending = (await new NativeSessionClient(root).read('owner', session.id))
      .pendingRequests[0]!;
    await assert.rejects(
      client.respond('other', session.id, pending.request!.id, { decision: 'approve' }),
      /not found/,
    );
    await assert.rejects(
      client.respond('owner', second.id, pending.request!.id, { decision: 'approve' }),
      /stale/,
    );
    await client.close('owner', second.id);
    assert.ok(alive(session.processPid));
    await reconnected.respond('owner', session.id, pending.request!.id, { decision: 'deny' });
    await until(async () => (await client.read('owner', session.id)).session.state === 'idle');
    rmSync(join(cwd, 'descendant'));
    writeFileSync(join(cwd, 'gate-crash-descendant'), '');
    await reconnected.send('owner', session.id, 'crash', 'crash');
    // Neither observer can see this child before its parent host is killed.
    process.kill(session.hostPid, 'SIGSTOP');
    writeFileSync(join(cwd, 'release-crash-descendant'), '');
    await until(() => existsSync(join(cwd, 'descendant')));
    const descendant = Number(readFileSync(join(cwd, 'descendant'), 'utf8'));
    // Stop the fixture's timer from cleaning up the child instead of the runtime.
    process.kill(-session.processPid, 'SIGSTOP');
    appendFileSync(join(root, 'sessions', `${session.id}.journal`), '{"event":');
    process.kill(session.hostPid, 'SIGKILL');
    await until(() => {
      const observation = spawnSync('ps', ['-p', String(session.hostPid), '-o', 'stat='], {
        encoding: 'utf8',
      });
      assert.equal(observation.status, 0, observation.stderr);
      return observation.stdout.trim().startsWith('Z');
    });
    process.kill(-host.pid, 'SIGCONT');
    await until(() => !alive(session.processPid) && !alive(descendant) && !alive(host.pid));
    const failed = await new NativeSessionClient(root).read('owner', session.id);
    assert.equal(failed.session.state, 'failed');
    assert.ok(failed.session.recovery);
    assert.ok(
      !failed.events.some(
        (event) => event.commandId === 'crash' && event.type === 'turn.completed',
      ),
    );
    const resumed = await client.create('owner', {
      runner: 'codex',
      cwd,
      resumeSessionId: session.nativeSessionId,
    });
    assert.equal(resumed.nativeSessionId, session.nativeSessionId);
    assert.equal((await client.send('owner', session.id, 'crash', 'crash')).state, 'accepted');
    assert.equal(
      readFileSync(join(cwd, 'inputs'), 'utf8')
        .split('\n')
        .filter((line) => line === 'crash').length,
      1,
    );
    await client.close('owner', session.id);
  } catch (error) {
    const log = join(root, 'host.log');
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${existsSync(log) ? readFileSync(log, 'utf8') : ''}`,
      { cause: error },
    );
  } finally {
    const path = join(root, 'host.json');
    if (existsSync(path)) {
      const host = readJson<HostIdentity>(path);
      if (alive(host.pid)) {
        process.kill(-host.pid, 'SIGCONT');
        const child = readJson<RecordedProcess>(join(root, 'worker.json'));
        if (recordedProcessAlive(child)) process.kill(child.pid, 'SIGCONT');
        process.kill(host.pid, 'SIGTERM');
        await until(() => !alive(host.pid));
      }
    }
    // Fixture owns this socket directory, never a production host.
    rmSync(socketDirectory(root), { recursive: true, force: true });
    fixture.restore();
  }
});
