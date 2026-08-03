import assert from 'node:assert/strict';
import test from 'node:test';

import { gitBranchDiff, gitExec } from './git.js';

test('gitExec remote branch transmits shell metacharacters as one argv element', async () => {
  const payload = 'feature/foo;touch /tmp/pwned`id`$(id)';
  let transmitted: string[] | undefined;

  const result = await gitExec('remote-slot', ['show', payload], undefined, {
    resolveRepo: async () => '/repo',
    loadVars: async () =>
      ({
        host: 'remote.example',
        machine: 'remote-machine',
        remoteRepo: '/repo',
      }) as any,
    runOnSlot: async (_slotVars, argv) => {
      transmitted = argv;
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  });

  assert.deepEqual(transmitted, ['git', 'show', payload]);
  assert.equal(result.stdout, 'ok');
});

test('gitExec rejects a non-zero exit even when git emits no stderr', async () => {
  await assert.rejects(
    gitExec('local-slot', ['status'], undefined, {
      resolveRepo: async () => '/repo',
      loadVars: async () =>
        ({
          host: 'localhost',
          machine: 'local-machine',
          remoteRepo: '/repo',
        }) as any,
      runOnSlot: async () => ({ stdout: '', stderr: '', exitCode: 7 }),
    }),
    /git exited with code 7/,
  );
});

function branchDiffDeps(outputs: { nameStatus: string; numstat: string; untracked?: string }): {
  deps: Parameters<typeof gitBranchDiff>[1];
  argvLog: string[][];
} {
  const argvLog: string[][] = [];
  return {
    argvLog,
    deps: {
      resolveRepo: async () => '/repo',
      loadVars: async () => ({ host: 'localhost', machine: 'local', remoteRepo: '/repo' }) as any,
      runOnSlot: async (_vars: unknown, argv: string[]) => {
        argvLog.push(argv);
        const sub = argv[1];
        if (sub === 'rev-parse') return { stdout: '', stderr: '', exitCode: 1 };
        if (sub === 'merge-base') return { stdout: 'mb123\n', stderr: '', exitCode: 0 };
        if (sub === 'branch') return { stdout: 'feat/x\n', stderr: '', exitCode: 0 };
        if (sub === 'ls-files') return { stdout: outputs.untracked ?? '', stderr: '', exitCode: 0 };
        if (argv.includes('--name-status'))
          return { stdout: outputs.nameStatus, stderr: '', exitCode: 0 };
        if (argv.includes('--numstat')) return { stdout: outputs.numstat, stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
  };
}

test('gitBranchDiff default target diffs committed history only', async () => {
  const { deps, argvLog } = branchDiffDeps({
    nameStatus: 'M\ta.ts\n',
    numstat: '3\t1\ta.ts\n',
  });
  const result = await gitBranchDiff({ slotId: 's', base: 'main' }, deps);
  assert.deepEqual(result.files, [{ path: 'a.ts', status: 'M', additions: 3, deletions: 1 }]);
  const diffArgs = argvLog.filter((argv) => argv[1] === 'diff');
  assert.ok(diffArgs.every((argv) => argv.includes('mb123..HEAD')));
  assert.ok(!argvLog.some((argv) => argv[1] === 'ls-files'));
});

test('gitBranchDiff worktree target diffs against the working tree and appends untracked files', async () => {
  const { deps, argvLog } = branchDiffDeps({
    nameStatus: 'M\ta.ts\nA\tnew.ts\n',
    numstat: '3\t1\ta.ts\n9\t0\tnew.ts\n',
    untracked: 'brand-new.md\nnew.ts\n',
  });
  const result = await gitBranchDiff({ slotId: 's', base: 'main', target: 'worktree' }, deps);
  const diffArgs = argvLog.filter((argv) => argv[1] === 'diff');
  // Single-ref diff = merge-base vs working tree (committed + uncommitted).
  assert.ok(diffArgs.every((argv) => argv.includes('mb123') && !argv.includes('mb123..HEAD')));
  assert.deepEqual(
    result.files.map((f) => f.path),
    ['a.ts', 'new.ts', 'brand-new.md'],
  );
  // Untracked file appended with A status; already-listed paths not duplicated.
  const untracked = result.files.find((f) => f.path === 'brand-new.md');
  assert.equal(untracked?.status, 'A');
  assert.equal(result.totalAdditions, 12);
});
