import assert from 'node:assert/strict';
import test from 'node:test';

import { applyUnifiedDiff, parseUnifiedDiff } from '../../src/client-cache/diff-apply.js';

function only(diff: string) {
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  return files[0];
}

test('a modified file applies across several hunks with full-index ids and modes', () => {
  const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', ''].join('\n');
  const file = only(
    [
      'diff --git a/src/x.ts b/src/x.ts',
      `index ${'1'.repeat(40)}..${'2'.repeat(40)} 100644`,
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,2 +1,2 @@',
      '-a',
      '+A',
      ' b',
      '@@ -9,2 +9,3 @@',
      ' i',
      ' j',
      '+k',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    { ...file, hunks: file.hunks.length },
    {
      oldPath: 'src/x.ts',
      newPath: 'src/x.ts',
      oldId: '1'.repeat(40),
      newId: '2'.repeat(40),
      oldMode: '100644',
      newMode: '100644',
      binary: false,
      malformed: false,
      hunks: 2,
    },
  );
  assert.equal(
    applyUnifiedDiff(base, file),
    ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', ''].join('\n'),
  );
});

test('added files apply to an empty base, deleted files to nothing', () => {
  const added = only(
    [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100755',
      'index 0000000..ce01362',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '',
    ].join('\n'),
  );
  assert.equal(added.oldPath, undefined);
  assert.equal(added.newPath, 'new.txt');
  assert.equal(added.newMode, '100755');
  assert.equal(applyUnifiedDiff('', added), 'hello\nworld\n');
  const deleted = only(
    [
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      'index ce01362..0000000',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-hello',
      '',
    ].join('\n'),
  );
  assert.equal(deleted.oldPath, 'old.txt');
  assert.equal(deleted.newPath, undefined);
  assert.equal(applyUnifiedDiff('hello\n', deleted), '');
});

test('missing final newlines are kept on each side', () => {
  const removeNewline = only(
    [
      'diff --git a/f b/f',
      'index 1..2 100644',
      '--- a/f',
      '+++ b/f',
      '@@ -1,2 +1,2 @@',
      ' one',
      '-two',
      '+two',
      '\\ No newline at end of file',
      '',
    ].join('\n'),
  );
  assert.equal(applyUnifiedDiff('one\ntwo\n', removeNewline), 'one\ntwo');
  const addNewline = only(
    [
      'diff --git a/f b/f',
      'index 1..2 100644',
      '--- a/f',
      '+++ b/f',
      '@@ -1 +1,2 @@',
      '-last',
      '\\ No newline at end of file',
      '+last',
      '+more',
      '',
    ].join('\n'),
  );
  assert.equal(applyUnifiedDiff('last', addNewline), 'last\nmore\n');
  assert.equal(applyUnifiedDiff('last\n', addNewline), undefined);
});

test('carriage returns and a byte order mark are content, not line structure', () => {
  const file = only(
    [
      'diff --git a/w.txt b/w.txt',
      'index 1..2 100644',
      '--- a/w.txt',
      '+++ b/w.txt',
      '@@ -1,2 +1,2 @@',
      ' ﻿keep\r',
      '-old\r',
      '+new\r',
      '',
    ].join('\n'),
  );
  assert.equal(applyUnifiedDiff('﻿keep\r\nold\r\n', file), '﻿keep\r\nnew\r\n');
});

test('a hunk that does not match its base, or runs backwards, does not apply', () => {
  const file = only(
    [
      'diff --git a/f b/f',
      'index 1..2 100644',
      '--- a/f',
      '+++ b/f',
      '@@ -2 +2 @@',
      '-b',
      '+B',
      '@@ -1 +1 @@',
      '-a',
      '+A',
      '',
    ].join('\n'),
  );
  assert.equal(applyUnifiedDiff('a\nb\n', file), undefined);
  assert.equal(applyUnifiedDiff('a\nc\n', { ...file, hunks: [file.hunks[0]] }), undefined);
  assert.equal(applyUnifiedDiff('a\nb\n', { ...file, hunks: [file.hunks[0]] }), 'a\nB\n');
});

test('renames, quoted paths, header-only sections and binary files', () => {
  const files = parseUnifiedDiff(
    [
      'diff --git a/from.ts b/to.ts',
      'similarity index 90%',
      'rename from from.ts',
      'rename to to.ts',
      'index 1111111..2222222 100644',
      '--- a/from.ts',
      '+++ b/to.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/same name.txt b/same name.txt',
      'old mode 100644',
      'new mode 100755',
      'diff --git "a/caf\\303\\251\\t.txt" "b/caf\\303\\251\\t.txt"',
      'new file mode 100644',
      'index 0000000..e69de29',
      'diff --git a/spaced name.txt b/spaced name.txt',
      'index 3333333..4444444 100644',
      '--- a/spaced name.txt\t',
      '+++ b/spaced name.txt\t',
      '@@ -1 +1 @@',
      '-p',
      '+q',
      'diff --git a/image.png b/image.png',
      'index 5555555..6666666 100644',
      'Binary files a/image.png and b/image.png differ',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    files.map(({ oldPath, newPath, binary, oldMode, newMode }) => ({
      oldPath,
      newPath,
      binary,
      oldMode,
      newMode,
    })),
    [
      { oldPath: 'from.ts', newPath: 'to.ts', binary: false, oldMode: '100644', newMode: '100644' },
      {
        oldPath: 'same name.txt',
        newPath: 'same name.txt',
        binary: false,
        oldMode: '100644',
        newMode: '100755',
      },
      {
        oldPath: undefined,
        newPath: 'café\t.txt',
        binary: false,
        oldMode: undefined,
        newMode: '100644',
      },
      {
        oldPath: 'spaced name.txt',
        newPath: 'spaced name.txt',
        binary: false,
        oldMode: '100644',
        newMode: '100644',
      },
      {
        oldPath: 'image.png',
        newPath: 'image.png',
        binary: true,
        oldMode: '100644',
        newMode: '100644',
      },
    ],
  );
  assert.equal(applyUnifiedDiff('', files[2]), '');
  assert.equal(applyUnifiedDiff('anything', files[4]), undefined);
});

test('a malformed hunk marks only its file, and parsing resumes at the next file', () => {
  const files = parseUnifiedDiff(
    [
      'diff --git a/bad b/bad',
      'index 1..2 100644',
      '--- a/bad',
      '+++ b/bad',
      '@@ -1,3 +1,3 @@',
      ' only one line',
      'diff --git a/good b/good',
      'index 3..4 100644',
      '--- a/good',
      '+++ b/good',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    files.map((file) => [file.newPath, file.malformed]),
    [
      ['bad', true],
      ['good', false],
    ],
  );
  assert.equal(applyUnifiedDiff(' only one line\n', files[0]), undefined);
  assert.equal(applyUnifiedDiff('a\n', files[1]), 'b\n');
});

test('rename and copy headers name repository paths, even inside a/ or b/ directories', () => {
  const files = parseUnifiedDiff(
    [
      'diff --git a/a/old.txt b/a/new.txt',
      'similarity index 100%',
      'rename from a/old.txt',
      'rename to a/new.txt',
      'diff --git "a/b/caf\\303\\251.txt" "b/b/copy.txt"',
      'similarity index 100%',
      'copy from "b/caf\\303\\251.txt"',
      'copy to b/copy.txt',
      'diff --git a/a/x.ts b/b/x.ts',
      'similarity index 80%',
      'rename from a/x.ts',
      'rename to b/x.ts',
      'index 1111111..2222222 100644',
      '--- a/a/x.ts',
      '+++ b/b/x.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    files.map(({ oldPath, newPath }) => [oldPath, newPath]),
    [
      ['a/old.txt', 'a/new.txt'],
      ['b/café.txt', 'b/copy.txt'],
      ['a/x.ts', 'b/x.ts'],
    ],
  );
  assert.equal(applyUnifiedDiff('same\n', files[0]), 'same\n');
});
