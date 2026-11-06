import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { configureHarnessHost, harnessHost } from '../src/harness/host.js';
import { observeTaskRun, type TaskRunObserver } from '../src/harness/task-run.js';

async function until(observer: TaskRunObserver, check: () => boolean) {
  if (check()) return;
  assert.ok(observer.onChange);
  const listen = observer.onChange;
  await new Promise<void>((resolve) => {
    const off = listen(() => {
      if (check()) {
        off();
        resolve();
      }
    });
  });
}

function cli(t: TestContext, project = 'example') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-run-child-'));
  const executable = path.join(root, 'cli with spaces');
  const control = path.join(root, 'control');
  const pid = path.join(root, 'pid');
  const args = path.join(root, 'args');
  fs.writeFileSync(control, '');
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));
fs.writeFileSync(${JSON.stringify(args)},JSON.stringify(process.argv.slice(2)));
let stopped=false;const close=()=>{if(stopped)return;stopped=true;watch.close();process.exit(0);};
const send=(status,terminal,done)=>process.stdout.write(JSON.stringify({status:'ok',data:{run:{id:'run',project:${JSON.stringify(project)},status,terminal,secret:'never expose'}}})+'\\n',done);
const watch=fs.watch(${JSON.stringify(control)},()=>{const command=fs.readFileSync(${JSON.stringify(control)},'utf8');if(command==='done')send('done',true,close);else if(command==='drop')close();});
process.stdin.resume();process.stdin.once('end',close);process.on('SIGTERM',close);
send('reviewing',false);
`,
  );
  fs.chmodSync(executable, 0o755);
  const previous = process.env.FARMSLOT_CLI;
  process.env.FARMSLOT_CLI = executable;
  let observer: TaskRunObserver | undefined;
  t.after(async () => {
    await observer?.close();
    if (previous === undefined) delete process.env.FARMSLOT_CLI;
    else process.env.FARMSLOT_CLI = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    control,
    pid,
    args,
    set(value: TaskRunObserver) {
      observer = value;
    },
  };
}

test(
  'the public CLI observer preserves lifecycle and releases its owned process',
  { timeout: 4900 },
  async (t) => {
    const f = cli(t);
    const observer = await observeTaskRun({ id: 'run', project: 'example' });
    f.set(observer);
    assert.deepEqual(observer.current(), {
      id: 'run',
      project: 'example',
      status: 'reviewing',
      terminal: false,
    });
    fs.writeFileSync(f.control, 'done');
    await until(observer, () => observer.current()?.terminal === true);
    await observer.close();
    assert.throws(() => process.kill(Number(fs.readFileSync(f.pid, 'utf8')), 0), { code: 'ESRCH' });
  },
);

test('loss of a live source clears its cached lifecycle', { timeout: 4900 }, async (t) => {
  const f = cli(t);
  const observer = await observeTaskRun({ id: 'run', project: 'example' });
  f.set(observer);
  assert.equal(observer.current()?.status, 'reviewing');
  fs.writeFileSync(f.control, 'drop');
  await until(observer, () => observer.current() === undefined);
});

test(
  'a mismatched source is unavailable and cannot populate this task',
  { timeout: 4900 },
  async (t) => {
    const f = cli(t, 'other');
    const observer = await observeTaskRun({ id: 'run', project: 'example' });
    f.set(observer);
    assert.equal(observer.current(), undefined);
    await observer.close();
  },
);

test(
  'a hosted observer preserves explicit gateway selection in the authenticated CLI',
  { timeout: 4900 },
  async (t) => {
    const f = cli(t);
    const previous = harnessHost();
    configureHarnessHost({
      ...previous,
      taskRunCliArgs: ['--gateway', 'selected-profile', '--url', 'ws://127.0.0.1:12345/ws'],
    });
    t.after(() => configureHarnessHost(previous));
    const observer = await observeTaskRun({ id: 'run', project: 'example' });
    f.set(observer);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.args, 'utf8')), [
      '--gateway',
      'selected-profile',
      '--url',
      'ws://127.0.0.1:12345/ws',
      '--json',
      'run',
      'get',
      '--watch',
      '--',
      'run',
    ]);
  },
);
