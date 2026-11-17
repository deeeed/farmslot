import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import { codexProxy } from './remote-node-stack.mts';

for (const refuse of [false, true]) {
  test(
    `swallowed review input is durably injected before acceptance, refusal=${refuse}`,
    { timeout: 15_000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'review-proxy-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const holds = path.join(root, 'holds');
      await mkdir(holds);
      await writeFile(path.join(holds, 'review'), 'swallow');
      const log = path.join(root, 'wire');
      const real = path.join(root, 'real.cjs');
      await writeFile(
        real,
        `#!/usr/bin/env node
const fs = require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)}, line+'\\n');
 const send = result => process.stdout.write(JSON.stringify({id:m.id,...result})+'\\n');
 if(m.method==='thread/start') send({result:{thread:{id:'retained-thread'}}});
 if(m.method==='thread/inject_items') send(${refuse ? "{error:{code:-32600,message:'injection refused'}}" : '{result:{}}'});
});
`,
        { mode: 0o700 },
      );
      const script = path.join(root, 'proxy.cjs');
      await writeFile(script, codexProxy(real, holds));
      const child = spawn(process.execPath, [script, 'app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      t.after(async () => {
        if (child.exitCode === null) {
          const exited = once(child, 'exit');
          child.stdin.end();
          await exited;
        }
      });
      const responses = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      child.stdin.write(JSON.stringify({ id: 1, method: 'thread/start', params: {} }) + '\n');
      assert.equal(JSON.parse((await responses.next()).value!).result.thread.id, 'retained-thread');
      child.stdin.write(
        JSON.stringify({
          id: 2,
          method: 'turn/start',
          params: { threadId: 'retained-thread', input: [{ type: 'text', text: 'review input' }] },
        }) + '\n',
      );
      const reply = JSON.parse((await responses.next()).value!);
      const wire = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const injected = wire.find((message) => message.method === 'thread/inject_items');
      assert.ok(
        injected,
        'the real runner must persist the user input before the fixture accepts it',
      );
      assert.deepEqual(injected.params, {
        threadId: 'retained-thread',
        items: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'review input' }],
          },
        ],
      });
      assert.equal(
        wire.some((message) => message.method === 'turn/start'),
        false,
        'no model turn is forwarded',
      );
      assert.equal(reply.id, 2);
      if (refuse) assert.equal(reply.error.message, 'injection refused');
      else assert.ok(reply.result.turn.id);
    },
  );
}
