import assert from 'node:assert/strict';
import test from 'node:test';

import { parseUnifiedDiff, splitUnifiedDiff } from './unified-diff.js';

const gitDiff = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  ' keep',
  '-old',
  '+new',
  ' keep',
  'diff --git a/src/app.test.ts b/src/app.test.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/app.test.ts',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
].join('\n');

test('git diffs split per file with line counts', () => {
  const files = parseUnifiedDiff(gitDiff);
  assert.deepEqual(
    files.map(({ path, additions, deletions }) => ({ path, additions, deletions })),
    [
      { path: 'src/app.ts', additions: 1, deletions: 1 },
      { path: 'src/app.test.ts', additions: 2, deletions: 0 },
    ],
  );
  assert.ok(files[1].diff.startsWith('diff --git a/src/app.test.ts'));
  assert.equal(files.map((file) => file.diff).join('\n'), gitDiff, 'entries rejoin losslessly');
});

test('mnemonic c/ w/ prefixes resolve to the plain path', () => {
  const files = parseUnifiedDiff(
    [
      'diff --git c/src/a.ts w/src/a.ts',
      '--- c/src/a.ts',
      '+++ w/src/a.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n'),
  );
  assert.deepEqual(
    files.map((file) => file.path),
    ['src/a.ts'],
  );
});

test('non-git multi-file diffs start a file at every header pair outside a hunk', () => {
  const files = parseUnifiedDiff(
    [
      '--- a/src/one.ts\t2026-10-09 10:00:00',
      '+++ b/src/one.ts\t2026-10-09 10:01:00',
      '@@ -1,2 +1,2 @@',
      '--- a removed line that looks like a header',
      '+++ an added line that looks like a header',
      ' keep',
      '--- src/two.test.ts',
      '+++ src/two.test.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n'),
  );
  assert.deepEqual(
    files.map(({ path, additions, deletions }) => ({ path, additions, deletions })),
    [
      { path: 'src/one.ts', additions: 1, deletions: 1 },
      { path: 'src/two.test.ts', additions: 1, deletions: 1 },
    ],
  );
});

test('text before the first file is kept as the preamble', () => {
  const header = 'commit abc123\nAuthor: someone\n\n    subject\n';
  const split = splitUnifiedDiff(`${header}${gitDiff}`);
  assert.equal(split.preamble, header.slice(0, -1));
  assert.equal(split.files.length, 2);
  assert.deepEqual(splitUnifiedDiff('plain text, no diff').files, []);
});
