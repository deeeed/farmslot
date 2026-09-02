import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { gitBranchDiff, gitDiff, gitExec, gitStatus } from './git.js';

const execFileAsync = promisify(execFile);

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

test('gitStatus keeps an unborn repository readable with an empty HEAD', async () => {
  const result = await gitStatus(
    { slotId: 'unborn-slot' },
    {
      resolveRepo: async () => '/repo',
      loadVars: async () => ({ host: 'localhost', machine: 'local', remoteRepo: '/repo' }) as any,
      runOnSlot: async (_vars, argv) => {
        if (argv[1] === 'status') return { stdout: '?? README.md\n', stderr: '', exitCode: 0 };
        if (argv[1] === 'branch') return { stdout: 'main\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: 'Needed a single revision', exitCode: 128 };
      },
    },
  );

  assert.equal(result.branch, 'main');
  assert.equal(result.headSha, '');
  assert.deepEqual(result.changes, [{ path: 'README.md', status: '?', staged: false }]);
});

function branchDiffDeps(outputs: {
  nameStatus: string;
  numstat: string;
  untracked?: string;
  committedNameStatus?: string;
  remoteMissing?: boolean;
}): {
  deps: Parameters<typeof gitBranchDiff>[1];
  argvLog: string[][];
} {
  const argvLog: string[][] = [];
  let remoteFetched = false;
  return {
    argvLog,
    deps: {
      resolveRepo: async () => '/repo',
      loadVars: async () => ({ host: 'localhost', machine: 'local', remoteRepo: '/repo' }) as any,
      runOnSlot: async (_vars: unknown, argv: string[]) => {
        argvLog.push(argv);
        const sub = argv[1];
        if (sub === 'rev-parse') {
          const remoteAvailable = !outputs.remoteMissing || remoteFetched;
          return remoteAvailable
            ? { stdout: 'base123\n', stderr: '', exitCode: 0 }
            : { stdout: '', stderr: '', exitCode: 1 };
        }
        if (sub === 'fetch') {
          remoteFetched = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
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
  assert.ok(
    argvLog.some(
      (argv) => argv[1] === 'fetch' && argv.includes('refs/heads/main:refs/remotes/origin/main'),
    ),
  );
  assert.ok(!argvLog.some((argv) => argv[1] === 'ls-files'));
});

test('gitBranchDiff fetches an exact stacked PR base that is missing locally', async () => {
  const { deps, argvLog } = branchDiffDeps({
    nameStatus: 'M\ta.ts\n',
    numstat: '1\t0\ta.ts\n',
    remoteMissing: true,
  });
  await gitBranchDiff({ slotId: 's', base: 'feature/base' }, deps);
  assert.ok(
    argvLog.some(
      (argv) =>
        argv[1] === 'fetch' &&
        argv.includes('refs/heads/feature/base:refs/remotes/origin/feature/base'),
    ),
  );
});

function exactSnapshotDeps(params: { available?: string[]; fetchError?: string }): {
  deps: Parameters<typeof gitBranchDiff>[1];
  argvLog: string[][];
} {
  const available = new Set(params.available ?? []);
  const argvLog: string[][] = [];
  return {
    argvLog,
    deps: {
      resolveRepo: async () => '/repo',
      loadVars: async () => ({ host: 'localhost', machine: 'local', remoteRepo: '/repo' }) as any,
      runOnSlot: async (_vars: unknown, argv: string[]) => {
        argvLog.push(argv);
        const sub = argv[1];
        if (sub === 'rev-parse') {
          const ref = argv.at(-1)?.replace(/\^\{commit\}$/, '') ?? '';
          return available.has(ref)
            ? { stdout: `${ref}\n`, stderr: '', exitCode: 0 }
            : { stdout: '', stderr: `missing ${ref}`, exitCode: 128 };
        }
        if (sub === 'fetch') {
          if (params.fetchError) return { stdout: '', stderr: params.fetchError, exitCode: 128 };
          available.add(argv.at(-1) ?? '');
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (sub === 'branch') return { stdout: 'unrelated-slot-branch\n', stderr: '', exitCode: 0 };
        if (argv.includes('--name-status')) {
          return { stdout: 'M\tsrc/reviewed.ts\n', stderr: '', exitCode: 0 };
        }
        if (argv.includes('--numstat')) {
          return { stdout: '4\t1\tsrc/reviewed.ts\n', stderr: '', exitCode: 0 };
        }
        if (sub === 'diff') return { stdout: 'saved review diff', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
  };
}

test('gitBranchDiff fetches missing commits for an exact review snapshot', async () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const { deps, argvLog } = exactSnapshotDeps({});

  const result = await gitBranchDiff({ slotId: 's', base, head }, deps);

  assert.equal(result.base, base);
  assert.equal(result.head, head);
  assert.deepEqual(result.files, [
    { path: 'src/reviewed.ts', status: 'M', additions: 4, deletions: 1 },
  ]);
  assert.deepEqual(
    argvLog.filter((argv) => argv[1] === 'fetch').map((argv) => argv.at(-1)),
    [base, head],
  );
  assert.ok(argvLog.some((argv) => argv[1] === 'rev-parse' && argv.at(-1) === `${base}^{commit}`));
  assert.ok(!argvLog.some((argv) => argv[1] === 'checkout'));
});

test('gitDiff recovers a missing head for an exact review snapshot', async () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const { deps, argvLog } = exactSnapshotDeps({ available: [base] });

  const result = await gitDiff({ slotId: 's', base, head, path: 'src/reviewed.ts' }, deps);

  assert.equal(result.diff, 'saved review diff');
  assert.deepEqual(
    argvLog.filter((argv) => argv[1] === 'fetch').map((argv) => argv.at(-1)),
    [head],
  );
  assert.ok(argvLog.some((argv) => argv[1] === 'diff' && argv.includes(`${base}...${head}`)));
});

test('gitBranchDiff reports an unavailable exact review commit after fetch fails', async () => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const { deps, argvLog } = exactSnapshotDeps({ fetchError: 'origin offline' });

  await assert.rejects(
    gitBranchDiff({ slotId: 's', base, head }, deps),
    new RegExp(`Review commit ${base} is unavailable after fetch: origin offline`),
  );
  assert.ok(!argvLog.some((argv) => argv[1] === 'diff'));
});

test('real git: exact review diff restores a shallow merge base without changing triple-dot semantics', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-git-shallow-review-'));
  const remote = path.join(root, 'origin.git');
  const source = path.join(root, 'source');
  const repo = path.join(root, 'repo');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(source);
  await execFileAsync('git', ['init', '--bare', remote]);
  await execFileAsync('git', ['init'], { cwd: source });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: source });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: source });
  await writeFile(path.join(source, 'shared.txt'), 'shared\n');
  await execFileAsync('git', ['add', 'shared.txt'], { cwd: source });
  await execFileAsync('git', ['commit', '-m', 'shared ancestor'], { cwd: source });
  await execFileAsync('git', ['branch', '-M', 'main'], { cwd: source });
  const { stdout: ancestorOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: source,
  });
  const ancestor = ancestorOutput.trim();
  await writeFile(path.join(source, 'base-only.txt'), 'base\n');
  await execFileAsync('git', ['add', 'base-only.txt'], { cwd: source });
  await execFileAsync('git', ['commit', '-m', 'base change'], { cwd: source });
  const { stdout: baseOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: source });
  const base = baseOutput.trim();
  await execFileAsync('git', ['checkout', '-b', 'feature', ancestor], { cwd: source });
  await writeFile(path.join(source, 'feature-only.txt'), 'feature\n');
  await execFileAsync('git', ['add', 'feature-only.txt'], { cwd: source });
  await execFileAsync('git', ['commit', '-m', 'feature change'], { cwd: source });
  const { stdout: headOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: source });
  const head = headOutput.trim();
  await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: source });
  await execFileAsync('git', ['push', 'origin', 'main', 'feature'], { cwd: source });
  await execFileAsync('git', [
    'clone',
    '--depth=1',
    '--branch',
    'feature',
    `file://${remote}`,
    repo,
  ]);
  await execFileAsync('git', ['fetch', '--depth=1', '--no-tags', 'origin', base], { cwd: repo });

  await execFileAsync('git', ['rev-parse', '--verify', `${base}^{commit}`], { cwd: repo });
  await execFileAsync('git', ['rev-parse', '--verify', `${head}^{commit}`], { cwd: repo });
  assert.equal(
    (
      await execFileAsync('git', ['rev-parse', '--is-shallow-repository'], { cwd: repo })
    ).stdout.trim(),
    'true',
  );
  await assert.rejects(execFileAsync('git', ['merge-base', base, head], { cwd: repo }));

  const deps: Parameters<typeof gitBranchDiff>[1] = {
    resolveRepo: async () => repo,
    loadVars: async () => ({ host: 'localhost', machine: 'local', remoteRepo: repo }) as any,
    runOnSlot: async (_vars, argv, options) => {
      try {
        const executed = await execFileAsync(argv[0], argv.slice(1), { cwd: options?.cwd });
        return { stdout: executed.stdout, stderr: executed.stderr, exitCode: 0 };
      } catch (error) {
        const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
        return {
          stdout: failed.stdout ?? '',
          stderr: failed.stderr ?? failed.message,
          exitCode: typeof failed.code === 'number' ? failed.code : 1,
        };
      }
    },
  };
  const result = await gitBranchDiff({ slotId: 'shallow-review-slot', base, head }, deps);
  const fileResult = await gitDiff(
    { slotId: 'shallow-review-slot', base, head, path: 'feature-only.txt' },
    deps,
  );

  assert.deepEqual(result.files, [
    { path: 'feature-only.txt', status: 'A', additions: 1, deletions: 0 },
  ]);
  assert.match(fileResult.diff, /^\+feature$/m);
  assert.equal(result.base, base);
  assert.equal(result.head, head);
  assert.equal(
    (await execFileAsync('git', ['merge-base', base, head], { cwd: repo })).stdout.trim(),
    ancestor,
  );
  assert.equal(
    (
      await execFileAsync('git', ['rev-parse', '--is-shallow-repository'], { cwd: repo })
    ).stdout.trim(),
    'false',
  );
});

test('gitDiff accepts a concurrent unshallow through a fetchable remote branch ref', async () => {
  const head = 'b'.repeat(40);
  const argvLog: string[][] = [];
  let concurrentRecovery = false;
  const result = await gitDiff(
    { slotId: 'shallow-named-base', base: 'main', head, path: 'feature-only.txt' },
    {
      resolveRepo: async () => '/repo',
      loadVars: async () => ({ host: 'localhost', machine: 'local', remoteRepo: '/repo' }) as any,
      runOnSlot: async (_vars, argv) => {
        argvLog.push(argv);
        if (argv[1] === 'fetch') {
          if (argv.includes('--unshallow')) {
            concurrentRecovery = true;
            return { stdout: '', stderr: 'repository is already complete', exitCode: 128 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (argv[1] === 'rev-parse' && argv.includes('--is-shallow-repository')) {
          return { stdout: 'true\n', stderr: '', exitCode: 0 };
        }
        if (argv[1] === 'rev-parse') {
          return {
            stdout: `${argv.at(-1)?.replace(/\^\{commit\}$/, '')}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (argv[1] === 'merge-base') {
          return concurrentRecovery
            ? { stdout: 'ancestor\n', stderr: '', exitCode: 0 }
            : { stdout: '', stderr: '', exitCode: 1 };
        }
        if (argv[1] === 'diff') return { stdout: 'saved review diff', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
  );

  assert.equal(result.diff, 'saved review diff');
  assert.ok(
    argvLog.some(
      (argv) =>
        argv[1] === 'fetch' &&
        argv.includes('--unshallow') &&
        argv.includes('refs/heads/main') &&
        !argv.includes('origin/main'),
    ),
  );
});

test('gitDiff refreshes the remote base when called directly', async () => {
  const { deps, argvLog } = branchDiffDeps({ nameStatus: '', numstat: '' });
  await gitDiff({ slotId: 's', base: 'main', path: 'src/a.ts' }, deps);
  assert.ok(argvLog.some((argv) => argv[1] === 'fetch'));
  assert.ok(argvLog.some((argv) => argv[1] === 'rev-parse' && argv.includes('origin/main')));
});

test('gitDiff falls back to a local base branch when the remote ref is unavailable', async () => {
  const argvLog: string[][] = [];
  const result = await gitDiff(
    { slotId: 's', base: 'main', path: 'src/a.ts' },
    {
      resolveRepo: async () => '/repo',
      loadVars: async () => ({ host: 'localhost', machine: 'local', remoteRepo: '/repo' }) as any,
      runOnSlot: async (_vars: unknown, argv: string[]) => {
        argvLog.push(argv);
        if (argv[1] === 'rev-parse' && argv.includes('origin/main')) {
          return { stdout: '', stderr: 'missing', exitCode: 1 };
        }
        if (argv[1] === 'rev-parse') return { stdout: 'local-base\n', stderr: '', exitCode: 0 };
        if (argv[1] === 'merge-base') return { stdout: 'mb-local\n', stderr: '', exitCode: 0 };
        if (argv[1] === 'diff') return { stdout: 'diff body', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
  );
  assert.equal(result.diff, 'diff body');
  assert.ok(argvLog.some((argv) => argv[1] === 'merge-base' && argv.includes('main')));
  assert.ok(argvLog.some((argv) => argv[1] === 'fetch'));
});

test('gitDiff uses an existing remote-tracking base when refresh is offline', async () => {
  const argvLog: string[][] = [];
  const result = await gitDiff(
    { slotId: 's', base: 'main', path: 'src/a.ts' },
    {
      resolveRepo: async () => '/repo',
      loadVars: async () => ({ host: 'localhost', machine: 'local', remoteRepo: '/repo' }) as any,
      runOnSlot: async (_vars: unknown, argv: string[]) => {
        argvLog.push(argv);
        if (argv[1] === 'fetch') return { stdout: '', stderr: 'offline', exitCode: 1 };
        if (argv[1] === 'rev-parse') return { stdout: 'remote-base\n', stderr: '', exitCode: 0 };
        if (argv[1] === 'merge-base') return { stdout: 'mb-remote\n', stderr: '', exitCode: 0 };
        if (argv[1] === 'diff') return { stdout: 'diff body', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
  );
  assert.equal(result.diff, 'diff body');
  assert.ok(argvLog.some((argv) => argv[1] === 'fetch'));
  assert.ok(argvLog.some((argv) => argv[1] === 'merge-base' && argv.includes('origin/main')));
});

test('real git: direct gitDiff keeps the last remote base when origin is offline', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-git-diff-offline-'));
  const remote = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(repo);
  await execFileAsync('git', ['init', '--bare', remote]);
  await execFileAsync('git', ['init'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repo });
  await writeFile(path.join(repo, 'proof.txt'), 'base\n');
  await execFileAsync('git', ['add', 'proof.txt'], { cwd: repo });
  await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repo });
  await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
  await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: repo });
  await execFileAsync('git', ['checkout', '-b', 'feature'], { cwd: repo });
  await writeFile(path.join(repo, 'proof.txt'), 'base\nfeature\n');
  await execFileAsync('git', ['commit', '-am', 'feature'], { cwd: repo });
  await execFileAsync('git', ['remote', 'set-url', 'origin', path.join(root, 'offline.git')], {
    cwd: repo,
  });

  const result = await gitDiff(
    { slotId: 'offline-slot', base: 'main', path: 'proof.txt' },
    {
      resolveRepo: async () => repo,
      loadVars: async () => ({ host: 'localhost', machine: 'local', remoteRepo: repo }) as any,
      runOnSlot: async (_vars, argv, options) => {
        try {
          const executed = await execFileAsync(argv[0], argv.slice(1), { cwd: options?.cwd });
          return { stdout: executed.stdout, stderr: executed.stderr, exitCode: 0 };
        } catch (error) {
          const failed = error as Error & {
            code?: number;
            stdout?: string;
            stderr?: string;
          };
          return {
            stdout: failed.stdout ?? '',
            stderr: failed.stderr ?? failed.message,
            exitCode: typeof failed.code === 'number' ? failed.code : 1,
          };
        }
      },
    },
  );

  assert.match(result.diff, /^\+feature$/m);
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
