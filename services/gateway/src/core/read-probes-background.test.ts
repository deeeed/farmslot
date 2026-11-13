import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { ExecResult } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const execution = await import('./exec.js');
const background = await import('../host-services/background/client.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const result: ExecResult = { stdout: 'observed', stderr: '', exitCode: 0 };
let heldChild: Promise<ExecResult> | undefined;
let latestChildSignal: AbortSignal | undefined;
let directCalls = 0;
let plainLocal = true;
let backgroundActive = true;
const childCalls: Array<{ operation: string; params: unknown }> = [];
mock.module('./exec.js', {
  namedExports: {
    ...execution,
    slotFilesReadInProcess: () => plainLocal,
    execOnSlot: async () => {
      directCalls++;
      return result;
    },
  },
});
mock.module('../host-services/background/client.js', {
  namedExports: {
    ...background,
    backgroundHost: {
      active: () => backgroundActive,
      request: async (
        operation: string,
        params: unknown,
        options: { signal?: AbortSignal },
      ): Promise<ExecResult> => {
        childCalls.push({ operation, params });
        latestChildSignal = options.signal;
        return heldChild ? await heldChild : result;
      },
    },
  },
});
const modulePath: string = './read-probes.js?background-probe-test';
const { readSlotProbe }: typeof import('./read-probes.js') = await import(modulePath);

test('local read probes spawn in the existing background host', async () => {
  const vars = makeVars({
    host: 'localhost',
    machine: 'fixture',
    remoteRepo: '/fixture/background',
  });
  const observed = await readSlotProbe(vars, 'read workspace', 'workspace', 5000, '/');
  assert.deepEqual(observed, result);
  assert.equal(directCalls, 0, 'the request-loop process must not start the command');
  assert.equal(childCalls.length, 1);
  assert.deepEqual(childCalls[0]?.params, { command: 'read workspace', cwd: '/', timeout: 5000 });
});

test('a disabled background host keeps the canonical execution path', async () => {
  backgroundActive = false;
  const before = directCalls;
  const children = childCalls.length;
  await readSlotProbe(makeVars({ remoteRepo: '/fixture/disabled' }), 'read', 'workspace', 5000);
  assert.equal(directCalls, before + 1);
  assert.equal(childCalls.length, children);
  backgroundActive = true;
});

test('owned or node-routed work keeps its authorized executor', async () => {
  plainLocal = false;
  const before = directCalls;
  const children = childCalls.length;
  await readSlotProbe(makeVars({ remoteRepo: '/fixture/owned' }), 'read', 'workspace', 5000);
  assert.equal(directCalls, before + 1);
  assert.equal(childCalls.length, children);
  plainLocal = true;
});

test('background reads inherit cleanup cancellation and remain tracked through closeout', async () => {
  const { withCleanupSignal, drainCleanupCommands } = await import('./cleanup-scope.js');
  const commands = { pending: new Set<Promise<unknown>>(), unconfirmed: false };
  const cancellation = new AbortController();
  let finish: (value: ExecResult) => void = () => assert.fail('missing closeout gate');
  heldChild = new Promise<ExecResult>((resolve) => {
    finish = resolve;
  });
  const pending = withCleanupSignal(
    cancellation.signal,
    () =>
      readSlotProbe(
        makeVars({ remoteRepo: '/fixture/cleanup' }),
        'read',
        'workspace-recovery',
        120000,
        '/',
      ),
    commands,
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(commands.pending.size, 1, 'cleanup must wait for the child closeout');
    assert.equal(latestChildSignal?.aborted, false);
    cancellation.abort();
    assert.equal(latestChildSignal?.aborted, true, 'inherited cleanup cancellation reaches IPC');
  } finally {
    finish(result);
    heldChild = undefined;
    await pending;
  }
  assert.equal(await drainCleanupCommands(commands), true);
  assert.equal(commands.pending.size, 0);
});
