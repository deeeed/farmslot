import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatTestShare,
  readHideTestsPref,
  splitDiffFilesByKind,
  subscribeHideTestsPref,
  writeHideTestsPref,
} from './diff-test-filter.js';

const files = [
  { path: 'src/app.ts', additions: 30, deletions: 10 },
  { path: 'src/app.test.ts', additions: 20, deletions: 0 },
  { path: 'src/other.ts', additions: 5, deletions: 5, kind: 'test' as const },
];

test('splitDiffFilesByKind keeps everything when tests are shown', () => {
  const split = splitDiffFilesByKind(files, false);
  assert.equal(split.visible.length, 3);
  assert.equal(split.hiddenCount, 0);
  assert.equal(split.visibleAdditions, 55);
  assert.equal(split.visibleDeletions, 15);
  assert.equal(split.summary.testFiles, 2);
});

test('splitDiffFilesByKind drops stamped and pattern-matched tests when hiding', () => {
  const split = splitDiffFilesByKind(files, true);
  assert.deepEqual(
    split.visible.map((file) => file.path),
    ['src/app.ts'],
  );
  assert.equal(split.hiddenCount, 2);
  assert.equal(split.visibleAdditions, 30);
  assert.equal(split.visibleDeletions, 10);
});

test('formatTestShare names test files and their line share', () => {
  assert.equal(
    formatTestShare(splitDiffFilesByKind(files, false).summary),
    '2 test files · 43% of lines',
  );
  assert.equal(formatTestShare(splitDiffFilesByKind([files[0]], false).summary), null);
  assert.equal(
    formatTestShare({ codeFiles: 0, testFiles: 1, codeLines: 0, testLines: 0, testShare: null }),
    '1 test file',
  );
});

test('splitDiffFilesByKind keeps the open file visible and honours a custom matcher', () => {
  const kept = splitDiffFilesByKind(files, true, { keepPath: 'src/app.test.ts' });
  assert.deepEqual(
    kept.visible.map((file) => file.path),
    ['src/app.ts', 'src/app.test.ts'],
  );
  const custom = splitDiffFilesByKind(files, true, { matcher: (path) => path.endsWith('app.ts') });
  assert.deepEqual(
    custom.visible.map((file) => file.path),
    ['src/app.test.ts'],
    'a stamped kind still wins; unstamped files use the matcher',
  );
});

test('hide-tests preference notifies subscribers once per change', () => {
  const seen: boolean[] = [];
  const unsubscribe = subscribeHideTestsPref((hide) => seen.push(hide));
  const initial = readHideTestsPref();
  writeHideTestsPref(!initial);
  writeHideTestsPref(!initial);
  writeHideTestsPref(initial);
  unsubscribe();
  writeHideTestsPref(!initial);
  writeHideTestsPref(initial);
  assert.deepEqual(seen, [!initial, initial]);
});
