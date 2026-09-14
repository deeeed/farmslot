import assert from 'node:assert/strict';
import test from 'node:test';

import { JsonLineProcess } from './process.js';
import { NativeProcessTree } from './process-tree.js';

test('a shutdown race is resolved only by fresh process absence after the child exits', async (t) => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let exited: { error?: Error; stopped: boolean } | undefined;
  const original = NativeProcessTree.prototype.stop;
  t.mock.method(NativeProcessTree.prototype, 'stop', function (this: NativeProcessTree) {
    original.call(this);
    throw new Error('Shutdown observation raced process exit');
  });
  const child = new JsonLineProcess(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify({ready:true})+"\\n");setInterval(()=>{},1000);'],
    { cwd: process.cwd() },
    () => ready(),
    (error, stopped) => {
      exited = { error, stopped };
    },
  );
  await started;
  await child.close();
  assert.equal(exited?.stopped, true);
  assert.equal(exited?.error, undefined);
});

test('a stop error cannot become successful cleanup while process absence remains unverified', async (t) => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let stopped: boolean | undefined;
  const original = NativeProcessTree.prototype.stop;
  t.mock.method(NativeProcessTree.prototype, 'stop', function (this: NativeProcessTree) {
    original.call(this);
    throw new Error('Owned process cleanup unconfirmed');
  });
  // The actual child is stopped, but this negative withholds the OS absence proof.
  t.mock.method(NativeProcessTree.prototype, 'empty', () => false);
  const child = new JsonLineProcess(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify({ready:true})+"\\n");setInterval(()=>{},1000);'],
    { cwd: process.cwd() },
    () => ready(),
    (_error, confirmed) => {
      stopped = confirmed;
    },
  );
  await started;
  await assert.rejects(child.close(), /Owned process cleanup unconfirmed/);
  assert.equal(stopped, false);
});
