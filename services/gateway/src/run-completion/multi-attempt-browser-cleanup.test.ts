import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

import { closeProofBrowser } from './multi-attempt-browser.live-support.js';

for (const stalled of [true, false]) {
  test(
    `browser proof cleanup stops its child when close ${stalled ? 'never responds' : 'rejects'}`,
    { timeout: 2_000 },
    async (t) => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      const exited = once(child, 'exit');
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      });
      const failure = new Error('Disposable close transport failed');
      let connectionsClosed = 0;
      const cleanup = closeProofBrowser(
        child,
        exited,
        {
          requestClose: () => (stalled ? new Promise<never>(() => {}) : Promise.reject(failure)),
          closeConnection: () => {
            connectionsClosed++;
          },
        },
        20,
      );
      if (stalled) await cleanup;
      else await assert.rejects(cleanup, (error: unknown) => error === failure);
      assert.equal(child.signalCode, 'SIGKILL');
      assert.equal(connectionsClosed, 1);
    },
  );
}
