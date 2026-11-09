import assert from 'node:assert/strict';
import os from 'node:os';
import { mock, test } from 'node:test';

import type { ExecResult } from '@farmslot/protocol';

// Real exports spread in, so every other importer of the module still loads.
const realExec = await import('../core/exec.js');
const calls: string[][] = [];
let reply: (argv: string[]) => Promise<ExecResult> = async () => ({
  stdout: '',
  stderr: 'probe unavailable',
  exitCode: 1,
});
mock.module('../core/exec.js', {
  namedExports: {
    ...realExec,
    execFileArgv: (argv: string[]) => {
      calls.push(argv);
      return reply(argv);
    },
  },
});
const { collectLocalMetrics, startLocalCollection, stopLocalCollection } =
  await import('./node-health.js');

test('failed host probes fall back to documented defaults without blocking', async () => {
  calls.length = 0;
  const metrics = await collectLocalMetrics();
  assert.equal(metrics.diskPercent, 0);
  if (process.platform === 'darwin') assert.equal(metrics.thermalPressure, undefined);
  const expected = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
  assert.ok(Math.abs(metrics.memoryPercent - expected) <= 2, 'memory falls back to os.freemem');
  assert.ok(
    calls.every((argv) => !argv.some((arg) => arg.includes('|') || arg.includes(' '))),
    'probes run as argv, never through a shell',
  );
});

test('a slow collection is not stacked behind by the next tick', async (t) => {
  calls.length = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  reply = async () => {
    await pending;
    return { stdout: '', stderr: '', exitCode: 1 };
  };
  t.after(() => {
    stopLocalCollection();
    release();
  });
  startLocalCollection('local-test', 10);
  const first = await new Promise<number>((resolve) => setTimeout(() => resolve(calls.length), 25));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(first > 0, 'the first tick started a collection');
  assert.equal(calls.length, first, 'later ticks waited for the pending collection');
});
