import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// Deterministically deliver process exit while the final output still awaits credit.
// The native adapter tests use real PTYs; this case controls lifecycle ordering.
let onData!: (text: string) => void;
let onExit!: (event: { exitCode: number }) => void;
mock.module('node-pty', {
  namedExports: {
    spawn: () => ({
      pause() {},
      resume() {},
      kill() {
        throw new Error('Cannot signal an already exited fixture');
      },
      resize() {},
      onData: (callback: typeof onData) => {
        onData = callback;
        return { dispose() {} };
      },
      onExit: (callback: typeof onExit) => {
        onExit = callback;
        return { dispose() {} };
      },
    }),
  },
});
const { openNodeLinkTerminal } = await import('./terminal.js');

test('PTY exit waits for final stream delivery and can cancel a stalled final delivery', async () => {
  const controller = new AbortController();
  let consuming!: () => void;
  const outputPending = new Promise<void>((resolve) => {
    consuming = resolve;
  });
  const terminal = await openNodeLinkTerminal(
    {
      argv: ['/fixture/terminal'],
      cwd: '/',
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      terminal: { cols: 80, rows: 24 },
    },
    controller.signal,
    async (update, signal) => {
      if (update.kind === 'started') return;
      consuming();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
    },
  );
  onData('final bytes');
  await outputPending;
  let resolved = false;
  void terminal.result.then(() => {
    resolved = true;
  });
  onExit({ exitCode: 0 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(resolved, false, 'process exit cannot acknowledge undelivered output');
  controller.abort();
  assert.equal((await terminal.result).exitCode, 130);
});
