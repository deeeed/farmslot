import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { ExecResult, GitShowBatchEntry } from '@farmslot/protocol';

const remoteArgv: string[][] = [];
const unexpected = (name: string) => () => assert.fail(`${name} is not under test`);
// A connected node runs the argv and returns stdout decoded as text, as services/node does.
mock.module('../fleet/node-rpc.js', {
  namedExports: {
    nodeExecArgv: (_machine: string, argv: string[], cwd: string) => {
      remoteArgv.push(argv);
      return new Promise<ExecResult>((resolve) => {
        const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
      });
    },
    nodeExec: unexpected('nodeExec'),
    sendNodeRequest: unexpected('sendNodeRequest'),
    waitForNode: unexpected('waitForNode'),
    getSlotLocality: unexpected('getSlotLocality'),
    assertNodeReconnectCurrent: unexpected('assertNodeReconnectCurrent'),
    withNodeReconnectWait: unexpected('withNodeReconnectWait'),
    withoutNodeReconnectWait: unexpected('withoutNodeReconnectWait'),
    resolveAfterNodeReconnect: unexpected('resolveAfterNodeReconnect'),
    handleNodeResponse: unexpected('handleNodeResponse'),
    handleNodeExecOutput: unexpected('handleNodeExecOutput'),
    failRequestsBoundTo: unexpected('failRequestsBoundTo'),
    isNodeTransportUnavailableError: () => false,
    NodeTransportUnavailableError: class extends Error {},
    NodeRpcTimeoutError: class extends Error {},
    NodeExecUnconfirmedError: class extends Error {},
  },
});

const { gitDiff, gitShow, gitShowBatch } = await import('./git.js');

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const repo = await mkdtemp(path.join(tmpdir(), 'farmslot-git-content-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  git('config', 'commit.gpgsign', 'false');
  git('checkout', '--quiet', '-b', 'main');
  const write = async (file: string, content: string | Buffer) => {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), content);
  };
  const commit = async (files: Record<string, string | Buffer>, message: string) => {
    for (const [file, content] of Object.entries(files)) await write(file, content);
    git('add', '--all');
    git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { repo, git, write, commit };
}

const slot = (repo: string, host = 'localhost') => ({
  resolveRepo: async () => repo,
  loadVars: async () => ({ host, machine: host, remoteRepo: repo }) as any,
});

const nonUtf8 = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0xe2, 0x82, 0x0a]);

test('git.show returns the object id of its content, and batched pages carry every status', async (t) => {
  const { repo, git, commit } = await fixture(t);
  const files: Record<string, string | Buffer> = {
    'a.txt': 'alpha\n',
    'held.txt': 'held\n',
    'dir/nested.txt': 'nested\n',
    'big.txt': 'x'.repeat(5000),
    'b.bin': nonUtf8,
    'c.txt': 'c'.repeat(600),
    'd.txt': 'd'.repeat(600),
    'e.txt': 'e'.repeat(800),
  };
  const head = await commit(files, 'fixture');
  const id = (file: string) => git('rev-parse', `${head}:${file}`);
  const deps = slot(repo);

  const single = await gitShow({ slotId: 's', ref: head, path: 'a.txt' }, deps);
  assert.deepEqual(single, { content: 'alpha\n', id: id('a.txt') });

  const paths = [
    'a.txt',
    'held.txt',
    'missing.txt',
    'dir',
    'big.txt',
    'b.bin',
    'c.txt',
    'd.txt',
    'e.txt',
  ];
  const request = {
    slotId: 's',
    ref: head,
    paths,
    have: [id('held.txt')],
    maxBytes: 1024,
    maxFileBytes: 700,
  };
  const pages = [await gitShowBatch(request, deps)];
  while (pages.at(-1)!.hasMore)
    pages.push(await gitShowBatch({ ...request, after: pages.at(-1)!.cursor }, deps));

  assert.equal(pages.length, 2);
  for (const page of pages) {
    assert.ok(page.entries.length > 0);
    assert.equal(page.cursor, page.entries.at(-1)!.path);
    const bytes = page.entries.reduce((sum, entry) => sum + (entry.content ? entry.size! : 0), 0);
    assert.ok(bytes <= request.maxBytes, `page carries ${bytes} raw bytes`);
  }
  assert.deepEqual(
    pages.map((page) => page.entries.map((entry) => entry.path)),
    [paths.slice(0, 7), paths.slice(7)],
  );
  const entries = new Map<string, GitShowBatchEntry>(
    pages.flatMap((page) => page.entries.map((entry) => [entry.path, entry] as const)),
  );
  assert.deepEqual(
    [...entries.values()].map((entry) => [entry.path, entry.status]),
    [
      ['a.txt', 'ok'],
      ['held.txt', 'held'],
      ['missing.txt', 'missing'],
      ['dir', 'not-blob'],
      ['big.txt', 'too-large'],
      ['b.bin', 'ok'],
      ['c.txt', 'ok'],
      ['d.txt', 'ok'],
      ['e.txt', 'too-large'],
    ],
  );
  for (const entry of entries.values()) {
    if (entry.status === 'missing') {
      assert.deepEqual(entry, { path: 'missing.txt', status: 'missing' });
      continue;
    }
    assert.equal(entry.id, id(entry.path));
    assert.equal(entry.content !== undefined, entry.status === 'ok');
    if (entry.status === 'ok')
      assert.deepEqual(
        Buffer.from(entry.content!, 'base64'),
        Buffer.from(files[entry.path]),
        entry.path,
      );
  }

  await assert.rejects(
    gitShowBatch({ ...request, after: 'not-requested.txt' }, deps),
    /Unknown git.show cursor/,
  );
  await assert.rejects(
    gitShowBatch({ slotId: 's', ref: 'no-such-branch', paths: ['a.txt'] }, deps),
    /Unknown commit no-such-branch/,
  );
});

test('batched git.show through a remote node returns non-UTF-8 bytes unchanged', async (t) => {
  const { repo, git, commit } = await fixture(t);
  const head = await commit({ 'b.bin': nonUtf8 }, 'binary');
  const deps = slot(repo, 'remote.example');
  remoteArgv.length = 0;

  const page = await gitShowBatch({ slotId: 's', ref: head, paths: ['b.bin'] }, deps);

  assert.ok(remoteArgv.length > 0 && remoteArgv.every((argv) => argv[0] === 'node'));
  assert.equal(page.entries[0].status, 'ok');
  assert.equal(page.entries[0].id, git('rev-parse', `${head}:b.bin`));
  assert.deepEqual(Buffer.from(page.entries[0].content!, 'base64'), nonUtf8);
  // The node's text decoding is what base64 protects against.
  const text = await gitShow({ slotId: 's', ref: head, path: 'b.bin' }, deps);
  assert.notDeepEqual(Buffer.from(text.content), nonUtf8);
});

test('git.diff includeUntracked adds untracked files and never ignored ones', async (t) => {
  const { repo, commit, git, write } = await fixture(t);
  await commit({ 'tracked.txt': 'base\n', '.gitignore': '.env\n' }, 'base');
  git('checkout', '--quiet', '-b', 'feature');
  await write('tracked.txt', 'base\nchanged\n');
  await write('new.txt', 'brand new\n');
  await write('.env', 'SECRET=fixture-secret\n');
  const deps = slot(repo);

  const result = await gitDiff(
    { slotId: 's', base: 'main', target: 'worktree', includeUntracked: true },
    deps,
  );
  assert.match(result.diff, /^\+changed$/m);
  assert.match(result.diff, /^diff --git a\/new\.txt b\/new\.txt$/m);
  assert.match(result.diff, /^\+brand new$/m);
  assert.doesNotMatch(result.diff, /\.env|fixture-secret/);

  const withoutUntracked = await gitDiff({ slotId: 's', base: 'main', target: 'worktree' }, deps);
  assert.doesNotMatch(withoutUntracked.diff, /new\.txt/);
  const limited = await gitDiff(
    { slotId: 's', base: 'main', target: 'worktree', includeUntracked: true, path: 'new.txt' },
    deps,
  );
  assert.doesNotMatch(limited.diff, /tracked\.txt/);
  assert.match(limited.diff, /^\+brand new$/m);
  await assert.rejects(
    gitDiff({ slotId: 's', base: 'main', includeUntracked: true }, deps),
    /includeUntracked requires a worktree diff/,
  );
});

test('git.diff names the merge-base and head it compared after the base branch moves', async (t) => {
  const { repo, commit, git } = await fixture(t);
  const branchPoint = await commit({ 'shared.txt': 'shared\n' }, 'branch point');
  git('checkout', '--quiet', '-b', 'feature');
  const head = await commit({ 'feature.txt': 'feature\n' }, 'feature');
  git('checkout', '--quiet', 'main');
  const movedBase = await commit({ 'main-only.txt': 'main\n' }, 'base moved');
  git('checkout', '--quiet', 'feature');
  const deps = slot(repo);

  const committed = await gitDiff({ slotId: 's', base: 'main' }, deps);
  assert.equal(committed.mergeBaseSha, branchPoint);
  assert.equal(committed.headSha, head);
  assert.match(committed.diff, /^\+feature$/m);
  assert.doesNotMatch(committed.diff, /main-only/);

  const worktree = await gitDiff({ slotId: 's', base: 'main', target: 'worktree' }, deps);
  assert.deepEqual([worktree.mergeBaseSha, worktree.headSha], [branchPoint, head]);
  const exact = await gitDiff({ slotId: 's', base: movedBase, head }, deps);
  assert.deepEqual([exact.mergeBaseSha, exact.headSha], [branchPoint, head]);
  assert.equal(exact.diff, committed.diff);

  const plain = await gitDiff({ slotId: 's' }, deps);
  assert.equal(plain.mergeBaseSha, undefined);
  assert.equal(plain.headSha, undefined);
});
