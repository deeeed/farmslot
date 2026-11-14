import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { NativeSessionClient } from './client.js';
import { setup, stopNativeStack } from './durability.test-support.js';

test('a supervisor that cannot read its own start identity leaves no lock behind', async () => {
  const fixture = setup();
  const entry = fileURLToPath(new URL('./supervisor.ts', import.meta.url));
  const marker = join(fixture.cwd, 'fail-next-lstart');
  try {
    // One failed `ps -o lstart=` read, as a timeout on a loaded node would give; every other
    // `ps` call reaches the real one. The fixture directory leads PATH for this test.
    writeFileSync(
      join(fixture.cwd, 'ps'),
      `#!/bin/sh\ncase "$*" in *lstart=*) if [ -f '${marker}' ]; then rm -f '${marker}'; exit 1; fi;; esac\nexec /bin/ps "$@"\n`,
      { mode: 0o700 },
    );
    writeFileSync(marker, '');
    const failed = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), entry, fixture.root],
      { encoding: 'utf8', timeout: 20_000 },
    );
    assert.notEqual(failed.status, 0);
    assert.equal(existsSync(join(fixture.root, 'lock')), false, 'no lock without an owner');
    await new NativeSessionClient(fixture.root).warm();
    assert.ok(existsSync(join(fixture.root, 'host.json')), 'the next start owns the host');
  } finally {
    await stopNativeStack(fixture);
  }
});
