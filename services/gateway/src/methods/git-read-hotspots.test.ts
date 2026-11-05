import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { runWorkspaceObservedRead } from '../resources/workspace-read.js';
import { makeVars } from '../runners/test-fixtures.js';

const { gitDiff, gitShow, gitShowBatch } = await import('./git.js');
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const blob = 'c'.repeat(40);

test('remote single and batch git.show each use one host call', { timeout: 1000 }, async () => {
  let calls = 0;
  let vars = makeVars({ host: 'remote.example', machine: 'remote' });
  const deps = {
    resolveRepo: async () => '/example/repo',
    loadVars: async () => vars,
    runOnSlot: async (_vars: unknown, argv: string[]) => {
      calls++;
      if (argv[0] === 'git')
        return { stdout: argv[1] === 'rev-parse' ? blob : 'hello', stderr: '', exitCode: 0 };
      let stdout = '';
      runInNewContext(argv[2], {
        Buffer,
        Set,
        require: (name: string) => {
          assert.equal(name, 'node:child_process');
          return {
            spawnSync: (_file: string, args: string[]) => ({
              status: 0,
              stderr: Buffer.alloc(0),
              stdout: Buffer.from(
                args.includes('--batch-check')
                  ? `${head} commit 20\n${blob} blob 5\n`
                  : `${blob} blob 5\nhello\n`,
              ),
            }),
          };
        },
        process: {
          argv: ['node', ...argv.slice(3)],
          stdout: {
            write: (v: string) => {
              stdout += v;
            },
          },
          stderr: { write() {} },
        },
      });
      return { stdout, stderr: '', exitCode: 0 };
    },
  };
  assert.deepEqual(await gitShow({ slotId: 'example', ref: head, path: 'a.txt' }, deps), {
    id: blob,
    content: 'hello',
  });
  assert.equal(calls, 1, 'single path');
  calls = 0;
  assert.deepEqual(await gitShowBatch({ slotId: 'example', ref: head, paths: ['a.txt'] }, deps), {
    entries: [{ path: 'a.txt', status: 'ok', id: blob, size: 5, content: 'aGVsbG8=' }],
    cursor: 'a.txt',
    hasMore: false,
  });
  assert.equal(calls, 1, 'batch page');
  // A local single path keeps plain git, which starts faster than a node process.
  vars = makeVars();
  calls = 0;
  assert.deepEqual(await gitShow({ slotId: 'example', ref: head, path: 'a.txt' }, deps), {
    id: blob,
    content: 'hello',
  });
  assert.equal(calls, 2, 'local single path');
});

test('exact git.diff reuses range and path results', { timeout: 1000 }, async () => {
  const commands: string[][] = [];
  const deps = {
    runCommand: async (args: string[]) => {
      commands.push(args);
      return {
        stdout:
          args[0] === 'diff'
            ? 'exact diff'
            : `${args[0] === 'merge-base' ? base : args.at(-1)?.replace(/\^\{commit\}$/, '')}\n`,
        stderr: '',
      };
    },
  };
  const params = { slotId: 'example', base, head, path: 'a.txt' };
  const first = await gitDiff(params, deps);
  assert.deepEqual(first, { diff: 'exact diff', mergeBaseSha: base, headSha: head });
  const count = commands.length;
  assert.deepEqual(await gitDiff(params, deps), first);
  assert.equal(commands.length, count, 'unchanged exact range performs no more commands');
  assert.equal(commands.filter((args) => args[0] === 'merge-base').length, 1);
});

test(
  'observed worktree diffs share observations and expire with the existing source',
  { timeout: 1000 },
  async (t) => {
    const { workspaceObservations } = await import('../resources/workspace-observations.js');
    const sourceId = 'example-worktree-source';
    await workspaceObservations.capture({
      root: '/example/repo',
      sourceId,
      keys: [{ family: 'workspace', slotId: 'observed-example' }],
      current: async () => true,
      arm: async () => () => {},
    });
    t.after(() => workspaceObservations.release(sourceId));
    const commands: string[][] = [];
    let version = 1;
    const deps = {
      runCommand: async (args: string[]) => {
        commands.push(args);
        return {
          stdout:
            args[0] === 'diff' ? `diff ${version}` : `${args[0] === 'merge-base' ? base : head}\n`,
          stderr: '',
        };
      },
    };
    const read = (path: string) =>
      runWorkspaceObservedRead(() =>
        gitDiff(
          {
            slotId: 'observed-example',
            base: 'main',
            target: 'worktree',
            path,
          },
          deps,
        ),
      );
    assert.deepEqual(await read('a.ts'), { diff: 'diff 1', headSha: head, mergeBaseSha: base });
    assert.deepEqual(await read('b.ts'), { diff: 'diff 1', headSha: head, mergeBaseSha: base });
    assert.deepEqual(
      commands.map((args) => args[0]),
      ['rev-parse', 'rev-parse', 'merge-base', 'diff', 'diff'],
    );
    await read('a.ts');
    assert.equal(commands.length, 5);
    version++;
    workspaceObservations.changed(sourceId);
    assert.deepEqual(await read('a.ts'), { diff: 'diff 2', headSha: head, mergeBaseSha: base });
    assert.deepEqual(
      commands.slice(5).map((args) => args[0]),
      ['rev-parse', 'rev-parse', 'merge-base', 'diff'],
    );
    await workspaceObservations.capture({
      root: '/example/other-repo',
      sourceId: 'relocated-example',
      keys: [{ family: 'workspace', slotId: 'observed-example' }],
      current: async () => true,
      arm: async () => () => {},
    });
    t.after(() => workspaceObservations.release('relocated-example'));
    version++;
    assert.equal((await read('a.ts')).diff, 'diff 3');
    workspaceObservations.release(sourceId);
    workspaceObservations.release('relocated-example');
    version++;
    assert.equal((await read('a.ts')).diff, 'diff 4');
  },
);

test(
  'exact diff keys isolate paths and slots and evict old results',
  { timeout: 1000 },
  async () => {
    let diffs = 0;
    const deps = {
      runCommand: async (args: string[]) => ({
        stdout: args[0] === 'diff' ? `diff ${++diffs}` : args[0] === 'merge-base' ? base : head,
        stderr: '',
      }),
    };
    const read = (slotId: string, path: string) => gitDiff({ slotId, base, head, path }, deps);
    assert.equal((await read('one', 'a')).diff, 'diff 1');
    assert.equal((await read('two', 'a')).diff, 'diff 2');
    assert.equal((await read('one', 'b')).diff, 'diff 3');
    assert.equal((await read('one', 'a')).diff, 'diff 1');
    for (let i = 0; i < 128; i++) await read('one', `file-${i}`);
    assert.equal((await read('one', 'a')).diff, 'diff 132');
  },
);

test(
  'large source inventories stay below the host argv limit per page',
  { timeout: 1000 },
  async () => {
    let calls = 0;
    const paths = Array.from({ length: 10000 }, (_, i) => `src/file-${i}.ts`);
    const result = await gitShowBatch(
      { slotId: 'large-example', ref: head, paths },
      {
        resolveRepo: async () => '/example/repo',
        loadVars: async () => makeVars(),
        runOnSlot: async (_vars, argv) => {
          calls++;
          assert.ok(Buffer.byteLength(argv[3]) < 128 * 1024, 'host input is one argv element');
          const input = JSON.parse(argv[3]);
          return {
            stdout: JSON.stringify({
              entries: [{ path: input.paths[0], status: 'missing' }],
              cursor: input.paths[0],
              hasMore: false,
            }),
            stderr: '',
            exitCode: 0,
          };
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.cursor, paths[0]);
    assert.equal(result.hasMore, true);
  },
);
