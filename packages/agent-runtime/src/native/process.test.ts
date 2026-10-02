import assert from 'node:assert/strict';
import test from 'node:test';

import { JsonLineProcess } from './process.js';
import { NativeProcessTree } from './process-tree.js';

test(
  'signal exit retains bounded redacted stderr and proves process closure',
  { timeout: 60_000 },
  async (t) => {
    const secret = 'native-fixture-secret-value';
    let complete!: (value: {
      error?: Error;
      stopped: boolean;
      evidence?: { exitCode: number | null; signal: string | null; stderrTail: string[] };
    }) => void;
    const exited = new Promise<{
      error?: Error;
      stopped: boolean;
      evidence?: { exitCode: number | null; signal: string | null; stderrTail: string[] };
    }>((resolve) => {
      complete = resolve;
    });
    const child = new JsonLineProcess(
      process.execPath,
      [
        '-e',
        `const lines=Array.from({length:60},(_,i)=>'line '+i+(i===58?' Authorization: Bearer '+process.env.PROBE_SECRET:''));process.stderr.write(lines.join('\\n')+'\\n',()=>process.kill(process.pid,'SIGTERM'));`,
      ],
      { cwd: process.cwd(), env: { ...process.env, PROBE_SECRET: secret } },
      () => {},
      (error, stopped, evidence) => complete({ error, stopped, evidence }),
    );
    t.after(() => child.close());
    const result = await exited;
    assert.equal(result.stopped, true);
    assert.ok(result.evidence, 'exit callback must retain structured evidence');
    assert.equal(result.evidence.exitCode, null);
    assert.equal(result.evidence.signal, 'SIGTERM');
    assert.equal(result.evidence.stderrTail.length, 50);
    assert.equal(result.evidence.stderrTail.at(-1), 'line 59');
    assert.ok(!JSON.stringify(result.evidence).includes(secret));
    assert.match(result.evidence.stderrTail.join('\n'), /redacted/i);
  },
);

test('aborting startup rejects pending protocol work and confirms process cleanup', async () => {
  const abort = new AbortController();
  let stopped = false;
  const child = new JsonLineProcess(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    { cwd: process.cwd(), signal: abort.signal },
    () => {},
    (_error, confirmed) => {
      stopped = confirmed;
    },
  );
  const pending = assert.rejects(child.request('initialize', {}), /closed/);
  abort.abort();
  await pending;
  await child.close();
  assert.equal(stopped, true);
});

test('a shutdown race is resolved only by fresh process absence after the child exits', async (t) => {
  let ready!: () => void;
  let rejectReady!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
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
      rejectReady(error ?? new Error('Process closed before readiness'));
    },
  );
  await started;
  await child.close();
  assert.equal(exited?.stopped, true);
  assert.equal(exited?.error, undefined);
});

test('a stop error cannot become successful cleanup while process absence remains unverified', async (t) => {
  let ready!: () => void;
  let rejectReady!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
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
    (error, confirmed) => {
      stopped = confirmed;
      rejectReady(error ?? new Error('Process closed before readiness'));
    },
  );
  await started;
  await assert.rejects(child.close(), /Owned process cleanup unconfirmed/);
  assert.equal(stopped, false);
});
