import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { NativeSessionClient } from './client.js';
import { setup, stopNativeStack } from './durability.test-support.js';
import { type HostIdentity } from './ipc.js';
import { alive, readJson } from './storage.js';

test('a supervisor whose home is removed stops its host instead of running on', async () => {
  const fixture = setup();
  try {
    await new NativeSessionClient(fixture.root).warm();
    const supervisor = readJson<HostIdentity>(join(fixture.root, 'host.json')).pid;
    const host = readJson<{ pid: number }>(join(fixture.root, 'worker.json')).pid;
    rmSync(fixture.root, { recursive: true, force: true });
    const deadline = Date.now() + 4_000;
    while ((alive(supervisor) || alive(host)) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(alive(host), false, 'the host stopped');
    assert.equal(alive(supervisor), false, 'the supervisor exited');
  } finally {
    await stopNativeStack(fixture);
  }
});
