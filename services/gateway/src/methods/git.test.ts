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

function branchDiffDeps(outputs: {
  nameStatus: string;
  numstat: string;
  untracked?: string;
  committedNameStatus?: string;
}): {
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
        if (
          argv.includes('--name-status') &&
          argv.includes('mb123..HEAD') &&
          outputs.committedNameStatus !== undefined
        )
          return { stdout: outputs.committedNameStatus, stderr: '', exitCode: 0 };
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
  const listDiffArgs = argvLog.filter(
    (argv) => argv[1] === 'diff' && !argv.includes('mb123..HEAD'),
  );
  // Single-ref diff = merge-base vs working tree (committed + uncommitted).
  assert.ok(listDiffArgs.every((argv) => argv.includes('mb123')));
  assert.deepEqual(
    result.files.map((f) => f.path),
    ['a.ts', 'new.ts', 'brand-new.md'],
  );
  // Untracked file appended with A status; already-listed paths not duplicated.
  const untracked = result.files.find((f) => f.path === 'brand-new.md');
  assert.equal(untracked?.status, 'A');
  assert.equal(result.totalAdditions, 12);
});

test('gitBranchDiff aligns rename numstat paths with name-status newPath', async () => {
  const { deps } = branchDiffDeps({
    nameStatus: 'R100\tsrc/old.ts\tsrc/renamed.ts\nR095\told-name.txt\tnew-name.txt\n',
    numstat: '3\t1\tsrc/{old.ts => renamed.ts}\n5\t2\told-name.txt => new-name.txt\n',
  });
  const result = await gitBranchDiff({ slotId: 's', base: 'main' }, deps);
  assert.deepEqual(result.files, [
    { path: 'src/renamed.ts', status: 'R', oldPath: 'src/old.ts', additions: 3, deletions: 1 },
    { path: 'new-name.txt', status: 'R', oldPath: 'old-name.txt', additions: 5, deletions: 2 },
  ]);
  assert.equal(result.totalAdditions, 8);
  assert.equal(result.totalDeletions, 3);
});

test('gitBranchDiff worktree target flags committed vs purely-local files', async () => {
  const { deps } = branchDiffDeps({
    nameStatus: 'M\tcommitted-and-edited.ts\nM\tlocal-only.ts\n',
    numstat: '3\t1\tcommitted-and-edited.ts\n2\t0\tlocal-only.ts\n',
    untracked: 'brand-new.md\n',
    committedNameStatus: 'M\tcommitted-and-edited.ts\n',
  });
  const result = await gitBranchDiff({ slotId: 's', base: 'main', target: 'worktree' }, deps);
  const byPath = new Map(result.files.map((f) => [f.path, f.committed]));
  assert.equal(byPath.get('committed-and-edited.ts'), true);
  assert.equal(byPath.get('local-only.ts'), false);
  assert.equal(byPath.get('brand-new.md'), false);
});

test('gitBranchDiff head target leaves committed undefined', async () => {
  const { deps } = branchDiffDeps({ nameStatus: 'M\ta.ts\n', numstat: '1\t0\ta.ts\n' });
  const result = await gitBranchDiff({ slotId: 's', base: 'main' }, deps);
  assert.equal(result.files[0].committed, undefined);
});

test('gitBranchDiff worktree rename keeps its committed flag via the old path', async () => {
  const { deps } = branchDiffDeps({
    nameStatus: 'R100\told.txt\tnew.txt\n',
    numstat: '0\t0\told.txt => new.txt\n',
    committedNameStatus: 'M\told.txt\n',
  });
  const result = await gitBranchDiff({ slotId: 's', base: 'main', target: 'worktree' }, deps);
  assert.equal(result.files[0].path, 'new.txt');
  assert.equal(result.files[0].committed, true);
});

test('numstatNewPath normalizes rename notations and passes plain paths through', async () => {
  const { numstatNewPath } = await import('./git.js');
  assert.equal(numstatNewPath('old.txt => new.txt'), 'new.txt');
  assert.equal(numstatNewPath('src/{old.ts => renamed.ts}/index.ts'), 'src/renamed.ts/index.ts');
  assert.equal(numstatNewPath('src/{old.ts => renamed.ts}'), 'src/renamed.ts');
  assert.equal(numstatNewPath('plain/path.ts'), 'plain/path.ts');
});
