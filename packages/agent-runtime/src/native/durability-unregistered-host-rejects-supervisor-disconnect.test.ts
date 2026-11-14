import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { socketDirectory } from './ipc.js';

test('unregistered host rejects a supervisor disconnect before module evaluation', async () => {
  const { fork } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'native-disconnected-host-'));
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const host = new URL(`./host.${extension}`, import.meta.url).href;
  const entry = join(root, 'deferred-host.mjs');
  writeFileSync(
    entry,
    `process.channel.ref();
const disconnected = new Promise(resolve => process.once('disconnect', resolve));
process.send('waiting-for-disconnect');
await disconnected;
await import(${JSON.stringify(host)});
`,
  );
  const child = fork(entry, [root], {
    execArgv: extension === 'ts' ? ['--import', import.meta.resolve('tsx')] : [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = once(child, 'exit');
  try {
    const [message] = await once(child, 'message');
    assert.equal(message, 'waiting-for-disconnect');
    child.disconnect();
    const [code] = await exited;
    assert.notEqual(code, 0);
    assert.match(stderr, /before host registration/);
    assert.equal(existsSync(join(root, 'sessions')), false);
    assert.equal(existsSync(join(socketDirectory(root), 's')), false);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
