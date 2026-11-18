import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { retireIdleNativeHost } from './host-runtime.js';
import type { HostIdentity } from './ipc.js';
import type { RecordedProcess } from './storage.js';

test(
  'idle retirement completes when its lock disappears between stat and rescan',
  { timeout: 5000 },
  async (t) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'host-watch-'));
    const lock = join(root, 'lock');
    fs.mkdirSync(lock);
    const host: HostIdentity = {
      pid: 100039801,
      token: 'fixture-token',
      socket: join(root, 'ipc'),
      supportsRuntimeUpgrade: true,
    };
    const worker = { pid: 100039802, identity: 'fixture worker start' } satisfies RecordedProcess;
    const write = (file: string, value: unknown) =>
      fs.writeFileSync(join(root, file), JSON.stringify(value), { mode: 0o600 });
    write('lock/owner.json', { pid: host.pid, identity: 'fixture supervisor start' });
    write('worker.json', worker);
    write('host.json', host);
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.resume();
      socket.on('end', () => socket.end('{"value":{"idle":true}}'));
    });
    let workerAlive = true;
    let stopping = false;
    let signalCount = 0;
    let turn: ReturnType<typeof setImmediate> | undefined;
    const finish = () => {
      if (!stopping) return;
      stopping = false;
      write('cleanup.json', { state: 'complete', hostPid: worker.pid });
      fs.rmSync(lock, { recursive: true, force: true });
      workerAlive = false;
    };
    t.after(async () => {
      if (turn) clearImmediate(turn);
      try {
        finish();
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    await new Promise<void>((resolve) => server.listen(host.socket, resolve));
    t.mock.method(childProcess, 'execFileSync', (_file: string, args: string[]) => {
      if (args.includes('command=')) return `node /fixture/native/supervisor.js ${root}`;
      if (args.includes('lstart='))
        return Number(args[1]) === host.pid ? 'fixture supervisor start' : worker.identity;
      throw new Error('Unexpected process inspection');
    });
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number): true => {
      if (signal === 0 && (pid === host.pid || (pid === worker.pid && workerAlive))) return true;
      if (signal === 0) throw Object.assign(new Error('Fixture worker stopped'), { code: 'ESRCH' });
      assert.equal(pid, host.pid);
      assert.equal(signal, 'SIGTERM');
      signalCount++;
      stopping = true;
      fs.writeFileSync(join(lock, 'retiring'), '');
      turn = setImmediate(() => (turn = setImmediate(finish)));
      return true;
    });
    const stat = fs.statSync;
    t.mock.method(fs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
      const result = stat(...args);
      // Reproduce the supervisor removing the lock after a recursive watcher's stat.
      if (stopping && args[0] === lock) finish();
      return result;
    });
    syncBuiltinESMExports();
    assert.equal(await retireIdleNativeHost(root, host), true);
    assert.equal(signalCount, 1);
    assert.equal(workerAlive, false);
  },
);
