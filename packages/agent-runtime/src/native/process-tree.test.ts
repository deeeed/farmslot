import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

import { NativeProcessTree } from './process-tree.js';
import { alive } from './storage.js';

test('cleanup retains a detached child after its title changes and parent exits', async () => {
  const childCode = `
    process.send(process.pid);
    process.on('message', () => { process.title = 'native-renamed-tool'; process.send('renamed'); });
    setInterval(() => {}, 1000);
  `;
  const root = spawn(
    process.execPath,
    [
      '-e',
      `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    child.on('message', message => process.send(message));
    process.on('message', () => child.send('rename'));
  `,
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  let descendant: number | undefined;
  try {
    [descendant] = await once(root, 'message');
    assert.ok(typeof descendant === 'number');
    const tree = new NativeProcessTree(root.pid!);
    const renamed = once(root, 'message');
    root.send('rename');
    assert.equal((await renamed)[0], 'renamed');
    const exited = once(root, 'exit');
    root.kill('SIGKILL');
    await exited;
    assert.ok(alive(descendant));
    tree.stop();
    const deadline = Date.now() + 3_000;
    while (alive(descendant) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(alive(descendant), false, 'Detached renamed child survived cleanup');
    assert.equal(tree.empty(), true);
  } finally {
    if (root.pid && alive(root.pid)) root.kill('SIGKILL');
    if (descendant && alive(descendant)) process.kill(descendant, 'SIGKILL');
  }
});
