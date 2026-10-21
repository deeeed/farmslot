import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

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

// A Claude Read of a 409,378-byte PNG streams one 1,092,250-byte line: the image is in both the
// tool result and `tool_use_result` (Claude Code 2.1.292). Reviewers died on it (TAT-4146 70bf7864).
const runnerScript = (lines: string[]) => `
const { randomBytes } = require('node:crypto');
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(409378 - 8)]);
const image = png.toString('base64');
const read = {
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: 'toolu_read', type: 'tool_result',
    content: [{ type: 'image', source: { type: 'base64', data: image, media_type: 'image/png' } }] }] },
  tool_use_result: { type: 'image', file: { base64: image, type: 'image/png', originalSize: 409378 } },
};
const named = { read: JSON.stringify(read), text: JSON.stringify({ type: 'user', text: 'x'.repeat(1100000) }) };
process.stdout.write(${JSON.stringify(lines)}.map((line) => named[line] ?? line).join('\\n') + '\\n');
setInterval(() => {}, 1000);`;

function runLines(t: TestContext, lines: string[]) {
  const messages: Array<Record<string, unknown>> = [];
  let exit!: (error: Error | undefined) => void;
  const exited = new Promise<Error | undefined>((resolve) => {
    exit = resolve;
  });
  const child = new JsonLineProcess(
    process.execPath,
    ['-e', runnerScript(lines)],
    { cwd: process.cwd() },
    (message) => messages.push(message),
    (error) => exit(error),
  );
  t.after(() => child.close());
  return { child, messages, exited };
}

test('an oversized image read keeps the runner and records the image size, not its bytes', async (t) => {
  const { child, messages, exited } = runLines(t, ['read', '{"type":"after"}']);
  const runner: { stopped?: Error } = {};
  void exited.then((error) => (runner.stopped = error ?? new Error('runner closed')));
  const deadline = Date.now() + 10_000;
  while (messages.length < 2 && !runner.stopped && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runner.stopped, undefined, `runner stopped: ${runner.stopped?.message}`);
  assert.equal(messages.length, 2, 'both runner events arrive');
  const read = JSON.stringify(messages[0]);
  // Both copies keep their place and size; no PNG bytes (base64 `iVBORw0KGgo`) remain.
  assert.equal(read.split('"[base64 data omitted: 409378 bytes]"').length - 1, 2);
  assert.ok(!read.includes('iVBORw0KGgo'));
  assert.match(read, /"media_type":"image\/png"/);
  assert.match(read, /"originalSize":409378/);
  assert.deepEqual(messages[1], { type: 'after' });
  await child.close();
  assert.equal(await exited, undefined);
});

test('a runner event still over 1 MiB without its base64 payloads stops the runner', async (t) => {
  const { messages, exited } = runLines(t, ['text', '{"type":"after"}']);
  assert.equal((await exited)?.message, 'Native runner event exceeds 1 MiB');
  assert.deepEqual(messages, []);
});

test('a large retained thread response resolves without becoming a runner event', async (t) => {
  let notify!: (message: Record<string, unknown>) => void;
  const notification = new Promise<Record<string, unknown>>((resolve) => {
    notify = resolve;
  });
  let stopped: boolean | undefined;
  const child = new JsonLineProcess(
    process.execPath,
    [
      '-e',
      `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        if (!line.trim()) return;
        const request = JSON.parse(line);
        const result = {
          thread: {id: request.params.threadId, turns: [{text: 'x'.repeat(1100000)}]},
          activePermissionProfile: {id: 'read-only-worker'},
        };
        process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
        process.stdout.write(JSON.stringify({method:'thread/started',params:{threadId:result.thread.id}})+'\\n');
      });`,
    ],
    { cwd: process.cwd() },
    notify,
    (_error, confirmed) => {
      stopped = confirmed;
    },
  );
  t.after(() => child.close());
  const result = await child.request('thread/resume', { threadId: 'retained-thread' });
  assert.deepEqual(result, {
    thread: { id: 'retained-thread', turns: [{ text: 'x'.repeat(1100000) }] },
    activePermissionProfile: { id: 'read-only-worker' },
  });
  assert.deepEqual(await notification, {
    method: 'thread/started',
    params: { threadId: 'retained-thread' },
  });
  assert.equal(stopped, undefined);
  await child.close();
  assert.equal(stopped, true);
});
