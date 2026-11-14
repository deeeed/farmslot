import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { setup } from './durability.test-support.js';
import { privateDirectory, processStartIdentity } from './storage.js';

test('a recorded supervisor that is still running keeps the host, with or without a start identity', () => {
  const fixture = setup();
  const entry = fileURLToPath(new URL('./supervisor.ts', import.meta.url));
  try {
    for (const owner of [
      { pid: process.pid, identity: processStartIdentity(process.pid) },
      { pid: process.pid },
    ]) {
      privateDirectory(join(fixture.root, 'lock'));
      writeFileSync(join(fixture.root, 'lock/owner.json'), JSON.stringify(owner), { mode: 0o600 });
      const started = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), entry, fixture.root],
        { encoding: 'utf8', timeout: 20_000 },
      );
      assert.equal(started.status, 0);
      assert.match(started.stderr, new RegExp(`supervisor ${process.pid} owns the host`));
      assert.equal(existsSync(join(fixture.root, 'host.json')), false);
    }
  } finally {
    fixture.restore();
  }
});
