import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import {
  NATIVE_CHECKPOINT_UNTRACKED_LIMIT,
  NativeCheckpoints,
  nativeTurnDiff,
  parseTurnFiles,
} from './checkpoint.js';
import { gitEnvironment } from './workspace.js';

// Each session's index, apart from the repository it checkpoints.
const indexes = mkdtempSync(join(tmpdir(), 'native-checkpoint-indexes-'));
after(() => rmSync(indexes, { recursive: true, force: true }));
let opened = 0;
const indexDir = () => join(indexes, String(++opened));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], {
    cwd,
    env: gitEnvironment(),
    encoding: 'utf8',
  });

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), 'native-checkpoint-'));
  git(cwd, 'init', '-q', '-b', 'main');
  writeFileSync(join(cwd, 'README.md'), 'one\ntwo\n');
  writeFileSync(join(cwd, '.gitignore'), 'build/\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', 'base');
  return cwd;
}

test('a checkpoint commits the working tree and leaves its index, HEAD and branches alone', async () => {
  const cwd = repository();
  try {
    writeFileSync(join(cwd, 'README.md'), 'one\nthree\n');
    const checkpoints = (await NativeCheckpoints.open(cwd, 'session', { indexDir: indexDir() }))!;
    const index = statSync(join(cwd, '.git/index')).mtimeMs;
    const head = git(cwd, 'rev-parse', 'HEAD');
    const before = await checkpoints.take();
    // Nothing changed since: the same checkpoint, no new commit or ref.
    assert.equal(await checkpoints.take(), before);
    writeFileSync(join(cwd, 'notes.txt'), 'new\n');
    rmSync(join(cwd, 'README.md'));
    writeFileSync(join(cwd, 'GUIDE.md'), 'one\nthree\nfour\n');
    const after = await checkpoints.take();
    const changes = await checkpoints.changes(before, after);
    assert.deepEqual(
      changes.files.sort((a, b) => (a.path < b.path ? -1 : 1)),
      [
        { path: 'GUIDE.md', status: 'added', additions: 3, deletions: 0 },
        { path: 'README.md', status: 'deleted', additions: 0, deletions: 2 },
        { path: 'notes.txt', status: 'added', additions: 1, deletions: 0 },
      ],
    );
    assert.match((await nativeTurnDiff(cwd, 'session', before, after, 'notes.txt'))!, /\+new/);
    // The reader's own index, HEAD and branches are exactly as they were.
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(git(cwd, 'branch', '--format=%(refname)').trim().split('\n'), [
      'refs/heads/main',
    ]);
    assert.equal(statSync(join(cwd, '.git/index')).mtimeMs, index);
    assert.equal(git(cwd, 'diff', '--cached', '--name-only'), '');
    const refs = git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/farmslot/native/session/');
    assert.equal(refs.trim().split('\n').length, 2);
    // The checkpoint descends from HEAD.
    assert.equal(git(cwd, 'rev-parse', `${after}^`), head);
    await checkpoints.remove();
    assert.equal(
      git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/farmslot/native/').trim(),
      '',
    );
    // Its objects may outlive the refs until Git collects them; the diff is no longer retained.
    assert.equal(await nativeTurnDiff(cwd, 'session', before, after, 'notes.txt'), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('ignored and oversized untracked files stay out of checkpoints', async () => {
  const cwd = repository();
  try {
    const checkpoints = (await NativeCheckpoints.open(cwd, 'session', { indexDir: indexDir() }))!;
    const before = await checkpoints.take();
    execFileSync('mkdir', ['-p', join(cwd, 'build')]);
    writeFileSync(join(cwd, 'build/out.js'), 'ignored');
    writeFileSync(join(cwd, 'big.bin'), Buffer.alloc(NATIVE_CHECKPOINT_UNTRACKED_LIMIT + 1));
    writeFileSync(join(cwd, 'small.txt'), 'kept\n');
    const changes = await checkpoints.changes(before, await checkpoints.take());
    assert.deepEqual(
      changes.files.map((file) => file.path),
      ['small.txt'],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a session keeps its latest checkpoints, and a reopened one finds its refs', async () => {
  const cwd = repository();
  try {
    const checkpoints = (await NativeCheckpoints.open(cwd, 'session', {
      kept: 2,
      indexDir: indexDir(),
    }))!;
    const taken: string[] = [];
    for (const text of ['a', 'b', 'c']) {
      writeFileSync(join(cwd, 'file.txt'), text);
      taken.push(await checkpoints.take());
    }
    const refs = () =>
      git(cwd, 'for-each-ref', '--format=%(objectname)', 'refs/farmslot/native/session/')
        .trim()
        .split('\n');
    assert.deepEqual(refs(), taken.slice(1));
    // A host restart reopens the same session's refs and keeps counting them.
    const reopened = (await NativeCheckpoints.open(cwd, 'session', {
      kept: 2,
      indexDir: indexDir(),
    }))!;
    writeFileSync(join(cwd, 'file.txt'), 'd');
    const latest = await reopened.take();
    assert.deepEqual(refs(), [taken[2], latest]);
    // Overlapping steps run in turn: the removal follows the take it was queued after.
    writeFileSync(join(cwd, 'file.txt'), 'e');
    await Promise.all([reopened.take(), reopened.remove()]);
    assert.deepEqual(refs(), ['']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the session's index keeps what it hashed, and follows the worktree index when it changes", async () => {
  const cwd = repository();
  const indexDir = mkdtempSync(join(tmpdir(), 'native-checkpoint-index-'));
  try {
    const checkpoints = (await NativeCheckpoints.open(cwd, 'session', { indexDir }))!;
    const listed = () =>
      execFileSync('git', ['ls-files'], {
        cwd,
        env: gitEnvironment({ GIT_INDEX_FILE: join(indexDir, 'index') }),
        encoding: 'utf8',
      })
        .trim()
        .split('\n');
    writeFileSync(join(cwd, 'draft.txt'), 'draft\n');
    const first = await checkpoints.take();
    // The untracked file is in the session's index, so the next checkpoint only stats it.
    assert.ok(listed().includes('draft.txt'));
    assert.equal(git(cwd, 'ls-files', 'draft.txt'), '');
    assert.equal(await checkpoints.take(), first);
    // The worktree index changes (a commit): the session's index is reseeded from it.
    writeFileSync(join(cwd, 'kept.txt'), 'kept\n');
    git(cwd, 'add', 'kept.txt');
    git(cwd, 'commit', '-q', '-m', 'kept');
    rmSync(join(cwd, 'draft.txt'));
    const changes = await checkpoints.changes(first, await checkpoints.take());
    assert.deepEqual(changes.files.map((file) => [file.path, file.status]).sort(), [
      ['draft.txt', 'deleted'],
      ['kept.txt', 'added'],
    ]);
    await checkpoints.remove();
    assert.equal(existsSync(indexDir), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test('a directory outside Git has no checkpoints', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'native-checkpoint-plain-'));
  try {
    assert.equal(await NativeCheckpoints.open(cwd, 'session', { indexDir: indexDir() }), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('diff-tree raw and numstat records become one entry per file', () => {
  const sha = (n: number) => String(n).repeat(40);
  const output = [
    `:100644 100644 ${sha(1)} ${sha(2)} M`,
    'src/a.ts',
    `:000000 100644 ${sha(0)} ${sha(3)} A`,
    'img.png',
    `:100644 000000 ${sha(4)} ${sha(0)} D`,
    'old.ts',
    '3\t1\tsrc/a.ts',
    '-\t-\timg.png',
    '0\t7\told.ts',
    `:000000 100644 ${sha(0)} ${sha(5)} A`,
    'a\tb.txt',
    '2\t0\ta\tb.txt',
    '',
  ].join('\0');
  assert.deepEqual(parseTurnFiles(output), [
    { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
    { path: 'img.png', status: 'added' },
    { path: 'old.ts', status: 'deleted', additions: 0, deletions: 7 },
    { path: 'a\tb.txt', status: 'added', additions: 2, deletions: 0 },
  ]);
});
