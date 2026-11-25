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

/** A temporary pack a killed fetch left an hour ago. */
async function killedFetchPack(repo: string): Promise<string> {
  const pack = path.join(repo, await git(repo, 'rev-parse', '--git-path', 'objects/pack'));
  const stale = path.join(pack, 'tmp_pack_killed');
  await writeFile(stale, 'partial');
  const hourAgo = new Date(Date.now() - 61 * 60_000);
  await utimes(stale, hourAgo, hourAgo);
  return stale;
}

/** Prepare's step details, collected from its event stream. */
function stepMessages(): { messages: string[]; emit: (event: string, payload: unknown) => void } {
  const messages: string[] = [];
  return {
    messages,
    emit: (_event, payload) => {
      if (typeof payload !== 'object' || payload === null || !('detail' in payload)) return;
      if (typeof payload.detail === 'string') messages.push(payload.detail);
    },
  };
}

test(
  "prepare turns off the slot repo's git auto-maintenance and drops a killed fetch's temporary pack",
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo } = await stackFixture(t, 'git-maintenance', 48940);
    mockPrepareCommand(t, async () => ({ stdout: 'phase completed\n', stderr: '', exitCode: 0 }));
    await git(slotRepo, 'config', 'maintenance.auto', 'true');
    const stale = await killedFetchPack(slotRepo);
    const steps = stepMessages();
    await slotPrepare(
      { slotId, branch: 'feat/maintenance-proof', prepareProfile: 'core' },
      steps.emit,
    );
    assert.equal(await git(slotRepo, 'config', '--local', '--get', 'maintenance.auto'), 'false');
    assert.equal(await git(slotRepo, 'config', '--local', '--get', 'gc.auto'), '0');
    assert.equal(existsSync(stale), false);
    assert.ok(
      steps.messages.some((m) => m.includes('removed 1 stale tmp pack')),
      steps.messages.join('\n'),
    );
  },
);

test(
  'prepare on its already published branch turns off auto-maintenance before that fetch',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo } = await stackFixture(t, 'git-maintenance-current', 48942);
    mockPrepareCommand(t, async () => ({ stdout: 'phase completed\n', stderr: '', exitCode: 0 }));
    const branch = 'feat/maintenance-current';
    await git(slotRepo, 'checkout', '-b', branch);
    await git(slotRepo, 'push', '--set-upstream', 'origin', branch);
    const stale = await killedFetchPack(slotRepo);
    await slotPrepare(
      { slotId, branch, prepareProfile: 'core', forceNewBranch: false },
      () => undefined,
    );
    assert.equal(await git(slotRepo, 'config', '--local', '--get', 'maintenance.auto'), 'false');
    assert.equal(await git(slotRepo, 'config', '--local', '--get', 'gc.auto'), '0');
    assert.equal(existsSync(stale), false);
  },
);
