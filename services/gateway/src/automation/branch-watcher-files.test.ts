import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import '../runtime/mock-pty.test-support.js';

import * as realConfig from '../core/config.js';
import * as realExec from '../core/exec.js';
import * as realState from '../fleet/state.js';
import type { GitRunOptions } from '../host-services/git.js';
import * as realGit from '../host-services/git.js';

const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'branch-watcher-files-'));
const repo = path.join(root, 'repo');
const git = (...args: string[]) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
git('init', '-q', '-b', 'feature/x', repo);
git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'a');

const commands: string[] = [];
const gitRunCalls: string[][] = [];
mock.module('../host-services/git.js', {
  namedExports: {
    ...realGit,
    gitService: {
      ...realGit.gitService,
      run(argv: string[], options?: GitRunOptions) {
        gitRunCalls.push(argv);
        return realGit.gitService.run(argv, options);
      },
    },
  },
});
mock.module('../core/exec.js', {
  namedExports: {
    ...realExec,
    execOnSlot: (
      vars: realConfig.SlotVars,
      command: string,
      options?: realExec.ExecOnSlotOptions,
    ) => {
      commands.push(command);
      return realExec.execOnSlot(vars, command, options);
    },
  },
});
mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async (slotId: string) => ({
      slotId,
      host: 'localhost',
      machine: 'branch-watcher-files-test',
      sshTarget: 'localhost',
      remoteRepo: repo,
    }),
  },
});
mock.module('../fleet/state.js', {
  namedExports: {
    ...realState,
    loadFleetStatus: async () => ({
      slots: [{ slot: 'files-slot', machine: 'branch-watcher-files-test', enabled: true }],
    }),
  },
});
const { onBranchChange, stopAllBranchWatches, watchBranch, unwatchBranch } =
  await import('./branch-watcher.js');

test.after(async () => {
  await stopAllBranchWatches();
  await rm(root, { recursive: true, force: true });
});

test('a local slot branch is read from its files; only a detached HEAD asks git', async () => {
  const branches: string[] = [];
  onBranchChange((_slot, branch) => {
    branches.push(branch);
  });
  await watchBranch('files-slot');
  assert.deepEqual(branches, [git('-C', repo, 'symbolic-ref', '--short', 'HEAD')]);
  assert.deepEqual(commands, [], 'neither the HEAD path nor the branch spawned git');

  await unwatchBranch('files-slot');
  git('-C', repo, 'checkout', '-q', '--detach');
  await watchBranch('files-slot');
  assert.deepEqual(branches.slice(1), [git('-C', repo, 'rev-parse', '--short', 'HEAD')]);
  // A detached HEAD's abbreviated SHA comes from gitService.run directly, not execOnSlot.
  assert.deepEqual(commands, []);
  // Positive proof: gitService.run was called with rev-parse --short HEAD for the detached case.
  assert.ok(
    gitRunCalls.some(
      (argv) => argv[0] === 'rev-parse' && argv[1] === '--short' && argv[2] === 'HEAD',
    ),
    `expected gitService.run(['rev-parse', '--short', 'HEAD', …]) but got: ${JSON.stringify(gitRunCalls)}`,
  );
});
