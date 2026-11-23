import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ensureLiveBrowserPid } from './screen-browser-pid.js';

test('lsof output names the browser even when lsof exits non-zero', async (t) => {
  // lsof reports some errors through its exit status while still listing the
  // socket; the old `lsof … | head -1` pipeline ignored that status.
  const bin = mkdtempSync(path.join(tmpdir(), 'farmslot-lsof-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const lsof = path.join(bin, 'lsof');
  writeFileSync(lsof, `#!/bin/sh\necho ${process.pid}\nexit 1\n`);
  chmodSync(lsof, 0o755);

  const pid = await ensureLiveBrowserPid(
    { slotId: 'mini-x-1', cdpPort: 9222, platform: 'web' },
    lsof,
  );
  assert.equal(pid, process.pid);
});
