import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
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

const DRIFT_LOG =
  '➤ YN0000: │ @metamask/perps-controller@npm:25.0.0: This package doesn\'t seem to be present in your lockfile; run "yarn install" to update the lockfile\n';

/** Origin's main tracks a yarn.lock; `branch` is published at main, an existing PR branch. */
async function lockedFixture(t: import('node:test').TestContext, label: string, port: number) {
  const fixture = await stackFixture(t, label, port);
  const { slotRepo } = fixture;
  await writeFile(path.join(slotRepo, 'yarn.lock'), '# lock\n');
  await git(slotRepo, 'add', 'yarn.lock');
  await git(slotRepo, 'commit', '-m', 'lockfile');
  await git(slotRepo, 'push', 'origin', 'main');
  await git(slotRepo, 'push', 'origin', 'main:refs/heads/pr-branch');
  return fixture;
}

/** The deps hook as a project's would run it: commands seen, and what the install does. */
function depsHook(
  t: import('node:test').TestContext,
  slotRepo: string,
  install: (command: string, logPath: string) => Promise<number>,
) {
  const commands: string[] = [];
  mockPrepareCommand(t, async (_vars, logPath, command, opts) => {
    if (opts?.phase !== 'deps')
      return { stdout: 'state-only phase completed\n', stderr: '', exitCode: 0 };
    commands.push(command);
    await mkdir(path.dirname(logPath), { recursive: true });
    return { stdout: '', stderr: '', exitCode: await install(command, logPath) };
  });
  return { commands, lock: path.join(slotRepo, 'yarn.lock') };
}

test(
  'a PR-branch run lets its install update a drifted lockfile, and says the worker must commit it',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo } = await lockedFixture(t, 'drift-allowed', 48860);
    const hook = depsHook(t, slotRepo, async (command, logPath) => {
      if (!command.includes('export FARMSLOT_PREPARE_LOCKFILE_DRIFT=allow;')) {
        await writeFile(logPath, DRIFT_LOG);
        return 1;
      }
      // The project's hook falls back to a mutable install, which rewrites the lockfile.
      await writeFile(hook.lock, '# lock\n"@metamask/perps-controller@npm:25.0.0":\n');
      return 0;
    });
    const events: unknown[] = [];
    await slotPrepare(
      { slotId, branch: 'pr-branch', prepareProfile: 'core', flowType: 'pr-complete' },
      (_event, payload) => events.push(payload),
    );
    assert.equal(hook.commands.length, 1);
    assert.match(
      JSON.stringify(events),
      /LOCKFILE DRIFT: prepare deps rewrote yarn\.lock on this PR branch; the worker must commit it/,
    );
  },
);

test(
  'a PR-branch run whose install rewrites another tracked file still fails',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo } = await lockedFixture(t, 'drift-other', 48862);
    depsHook(t, slotRepo, async () => {
      await writeFile(path.join(slotRepo, 'README.md'), 'rewritten\n');
      return 0;
    });
    await assert.rejects(
      slotPrepare(
        { slotId, branch: 'pr-branch', prepareProfile: 'core', flowType: 'pr-complete' },
        () => undefined,
      ),
      /prepare deps changed 1 tracked file .*README\.md/,
    );
  },
);

test(
  'drift a run may not fix, or that its hook did not fix, fails with a typed reason naming the package',
  needsTmuxSandbox,
  async (t) => {
    const { slotId, slotRepo } = await lockedFixture(t, 'drift-refused', 48864);
    const hook = depsHook(t, slotRepo, async (_command, logPath) => {
      await writeFile(logPath, DRIFT_LOG);
      return 1;
    });
    // A new fix-bug branch: no PR yet, so the run is not allowed to change the lockfile.
    await assert.rejects(
      slotPrepare(
        {
          slotId,
          branch: 'TAT-9-fix-new',
          prepareProfile: 'core',
          flowType: 'fix-bug',
          forceNewBranch: true,
        },
        () => undefined,
      ),
      (error: Error & { failureKind?: string }) => {
        assert.equal(error.failureKind, 'lockfile-drift');
        assert.match(
          error.message,
          /^lockfile drift: @metamask\/perps-controller in package\.json does not match the lockfile/,
        );
        return true;
      },
    );
    assert.doesNotMatch(hook.commands[0]!, /FARMSLOT_PREPARE_LOCKFILE_DRIFT/);
    // A PR branch whose hook has no fallback yet.
    await assert.rejects(
      slotPrepare(
        { slotId, branch: 'pr-branch', prepareProfile: 'core', flowType: 'pr-complete' },
        () => undefined,
      ),
      /^Error: lockfile drift on PR branch: @metamask\/perps-controller .*commit the updated lockfile on pr-branch/,
    );
    assert.match(hook.commands[1]!, /export FARMSLOT_PREPARE_LOCKFILE_DRIFT=allow;/);
  },
);
