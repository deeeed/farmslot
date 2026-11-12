import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { NativeProcessTree } from './process-tree.js';

test('async launch census retains the combined sync output limit', async (t) => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const spy = t.mock.method(
    childProcess,
    'execFile',
    (...args: Parameters<typeof childProcess.execFile>) => {
      const callback = args.at(-1);
      if (typeof callback !== 'function') throw new Error('Census callback missing');
      const child = new childProcess.ChildProcess();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      child.stdout = stdout;
      child.stderr = stderr;
      t.mock.method(child, 'kill', (signal?: NodeJS.Signals | number) => {
        signals.push(signal);
        return true;
      });
      queueMicrotask(() => {
        stdout.emit('data', Buffer.alloc(8 * 1024 * 1024 + 1));
        stderr.emit('data', Buffer.alloc(8 * 1024 * 1024));
        callback(
          null,
          Buffer.from(`${process.pid} 1 ${process.pid} fixture start\n`),
          Buffer.alloc(0),
        );
        stdout.destroy();
        stderr.destroy();
      });
      return child;
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(NativeProcessTree.create(process.pid, { gated: true }), {
      code: 'ENOBUFS',
    });
    assert.deepEqual(signals, ['SIGKILL']);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});
