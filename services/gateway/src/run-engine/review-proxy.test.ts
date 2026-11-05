import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { codexProxy } from '../../../../scripts/runner-validation/lib/remote-node-stack.mjs';

test(
  'review proxy exits with its child while the supervisor keeps input open',
  { timeout: 2000 },
  async (t) => {
    const dir = await mkdtemp('/tmp/f416-review-proxy-');
    const backend = path.join(dir, 'backend');
    const proxy = path.join(dir, 'proxy.cjs');
    await writeFile(
      backend,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({method:'fixture/ready'})+'\\n');\n`,
      { mode: 0o755 },
    );
    await writeFile(proxy, codexProxy(backend, dir));
    const child = spawn(process.execPath, [proxy, 'app-server'], { stdio: 'pipe' });
    t.after(async () => {
      child.kill('SIGKILL');
      child.stdin.destroy();
      await rm(dir, { recursive: true, force: true });
    });
    const output: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    const [code, signal] = await once(child, 'exit', { signal: AbortSignal.timeout(1000) });
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.deepEqual(JSON.parse(Buffer.concat(output).toString('utf8')), {
      method: 'fixture/ready',
    });
  },
);
