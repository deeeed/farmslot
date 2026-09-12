import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JsonLineProcess } from './process.js';

for (const intentional of [true, false]) {
  test(`exit 143 is ${intentional ? 'closed after requested termination' : 'failed without requested termination'}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'native-signal-exit-'));
    const script = join(cwd, 'runner.cjs');
    await writeFile(
      script,
      `
      process.on('SIGTERM', () => process.exit(143));
      console.log(JSON.stringify({ ready: true }));
      ${intentional ? 'setInterval(() => {}, 1000);' : 'setTimeout(() => process.exit(143), 25);'}
    `,
    );
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const errors: Array<Error | undefined> = [];
    const runner = new JsonLineProcess(process.execPath, [script], { cwd }, ready, (error) =>
      errors.push(error),
    );
    try {
      const exited = once(runner.child, 'close');
      await started;
      if (intentional) await runner.close();
      else {
        await exited;
        await runner.close();
      }
      assert.equal(errors.length, 1);
      if (intentional) assert.equal(errors[0], undefined);
      else assert.match(errors[0]?.message ?? '', /code=143/);
    } finally {
      await runner.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

for (const malformed of ['null', '{"method":"broken"}']) {
  test(`protocol failure isolates the child for ${malformed}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'native-protocol-failure-'));
    const script = join(cwd, 'runner.cjs');
    await writeFile(script, `console.log(${JSON.stringify(malformed)});setInterval(()=>{},1000);`);
    const errors: Array<Error | undefined> = [];
    const process = new JsonLineProcess(
      globalThis.process.execPath,
      [script],
      { cwd },
      () => {
        throw new Error('Invalid native event');
      },
      (error) => errors.push(error),
    );
    try {
      await once(process.child, 'close');
      await process.close();
      assert.equal(errors.length, 1);
      assert.match(
        errors[0]?.message ?? '',
        /Native runner (emitted invalid JSON|protocol event failed)/,
      );
      assert.throws(() => process.write({ method: 'next' }), /closed/);
    } finally {
      await process.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test(
  'cleanup denial with inherited stdio fails only its session and close rejects',
  { timeout: 15_000 },
  async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), 'native-cleanup-denial-'));
    const script = join(cwd, 'runner.cjs');
    await writeFile(
      script,
      `
    const { spawn } = require('node:child_process');
    const readline = require('node:readline');
    const tool = process.argv.includes('tool')
      ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
      : undefined;
    console.log(JSON.stringify({ ready: true, toolPid: tool?.pid }));
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'exit') process.exit(0);
      else console.log(JSON.stringify({ id: message.id, result: message.params }));
    });
  `,
    );
    let started!: (message: Record<string, unknown>) => void;
    const ready = new Promise<Record<string, unknown>>((resolve) => {
      started = resolve;
    });
    let settled!: () => void;
    const completed = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const exits: Array<{ error?: Error; processStopped: boolean; childClosed: boolean }> = [];
    let childClosed = false;
    const runner = new JsonLineProcess(
      process.execPath,
      [script, 'tool'],
      { cwd },
      started,
      (error, processStopped) => {
        exits.push({ error, processStopped, childClosed });
        settled();
      },
    );
    runner.child.on('close', () => {
      childClosed = true;
    });
    let siblingReady!: () => void;
    const siblingStarted = new Promise<void>((resolve) => {
      siblingReady = resolve;
    });
    const sibling = new JsonLineProcess(
      process.execPath,
      [script],
      { cwd },
      siblingReady,
      () => {},
    );
    let toolPid: number | undefined;
    const kill = process.kill.bind(process);
    try {
      const message = await ready;
      toolPid = message.toolPid as number;
      assert.ok(Number.isInteger(toolPid));
      await siblingStarted;
      // Let the actual process census observe the tool before its parent exits.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const denied = t.mock.method(
        process,
        'kill',
        (pid: number, signal?: number | NodeJS.Signals) => {
          if (pid === -runner.child.pid! || pid === toolPid) {
            throw Object.assign(new Error('test cleanup denied'), { code: 'EPERM' });
          }
          return kill(pid, signal);
        },
      );
      runner.write({ method: 'exit' });
      await completed;
      assert.equal(exits.length, 1);
      assert.equal(exits[0]!.processStopped, false);
      assert.equal(
        exits[0]!.childClosed,
        false,
        'Completion must not await inherited pipe closure',
      );
      assert.match(exits[0]!.error?.message ?? '', /cleanup failed/);
      await assert.rejects(runner.close(), /cleanup failed/);
      assert.deepEqual(await sibling.request('echo', { alive: true }), { alive: true });
      denied.mock.restore();
    } finally {
      t.mock.restoreAll();
      const stopTool = () => {
        if (!toolPid) return;
        try {
          kill(toolPid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      };
      stopTool();
      await sibling.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
