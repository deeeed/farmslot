import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { delay } from './durability.test-support.js';
import { socketDirectory } from './ipc.js';

test('unregistered host cannot bind and exits if its supervisor disappears', async () => {
  const { fork } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = mkdtempSync(join(tmpdir(), 'native-unregistered-host-'));
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const child = fork(fileURLToPath(new URL(`./host.${extension}`, import.meta.url)), [root], {
    execArgv: extension === 'ts' ? ['--import', import.meta.resolve('tsx')] : [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(child, 'exit');
  try {
    await delay(500);
    assert.equal(existsSync(join(root, 'sessions')), false);
    assert.equal(existsSync(join(socketDirectory(root), 's')), false);
    child.disconnect();
    const [code] = await exited;
    assert.notEqual(code, 0);
    assert.match(stderr, /before host registration/);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
