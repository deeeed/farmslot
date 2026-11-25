import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import '../core/private-pool.test-support.js';

// The shared fixture calls mock.module(...) and needs the module-mock test lane.
import {
  git,
  mockPrepareCommand,
  needsTmuxSandbox,
  slotPrepare,
  stackFixture,
} from './stack-base-prepare.test-support.js';

test(
  "prepare turns off the slot repo's git auto-maintenance and drops a killed fetch's temporary pack",
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo } = await stackFixture(t, 'git-maintenance', 48940);
    mockPrepareCommand(t, async () => ({ stdout: 'phase completed\n', stderr: '', exitCode: 0 }));
    await git(slotRepo, 'config', 'maintenance.auto', 'true');
    const pack = path.join(slotRepo, await git(slotRepo, 'rev-parse', '--git-path', 'objects/pack'));
    const stale = path.join(pack, 'tmp_pack_killed');
    await writeFile(stale, 'partial');
    const hourAgo = new Date(Date.now() - 61 * 60_000);
    await utimes(stale, hourAgo, hourAgo);
    await slotPrepare({ slotId, branch: 'feat/maintenance-proof', prepareProfile: 'core' }, () => {});
    assert.equal(await git(slotRepo, 'config', '--get', 'maintenance.auto'), 'false');
    assert.equal(await git(slotRepo, 'config', '--get', 'gc.auto'), '0');
    assert.equal(existsSync(stale), false);
  },
);
