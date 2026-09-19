import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyDiffFile,
  compileTestFileMatcher,
  DEFAULT_TEST_FILE_PATTERNS,
  resolveTestFilePatterns,
  summarizeDiffKinds,
} from '../../src/contracts/diff-view.js';

test('default test patterns cover common JS, Go, Python, JVM, Swift and snapshot layouts', () => {
  const isTest = compileTestFileMatcher();
  for (const path of [
    'src/a.test.ts',
    'src/a.spec.tsx',
    'pkg/handler_test.go',
    'app/test_models.py',
    'app/models_test.py',
    'src/main/java/FooTest.java',
    'ios/AppTests/LoginTests.swift',
    'src/__tests__/a.ts',
    'src/__mocks__/fs.ts',
    'src/__snapshots__/a.snap',
    'test/helpers.ts',
    'e2e/specs/login.ts',
    'packages/x/tests/unit/a.rb',
  ]) {
    assert.equal(isTest(path), true, path);
  }
  for (const path of [
    'src/a.ts',
    'src/testing-library.ts',
    'src/contest/a.ts',
    'src/latest/index.ts',
    'docs/test-plan.md',
    'src/spectrum.ts',
  ]) {
    assert.equal(isTest(path), false, path);
  }
});

test('project patterns extend or replace the defaults', () => {
  const extended = compileTestFileMatcher(
    resolveTestFilePatterns({ testPatterns: ['**/fixtures/**', '*.stories.*'] }),
  );
  assert.equal(extended('src/fixtures/a.json'), true);
  assert.equal(extended('src/a.stories.tsx'), true);
  assert.equal(extended('src/a.test.ts'), true, 'defaults stay on');

  const replaced = compileTestFileMatcher(
    resolveTestFilePatterns({ testPatterns: ['*.check.ts'], useDefaultTestPatterns: false }),
  );
  assert.equal(replaced('src/a.check.ts'), true);
  assert.equal(replaced('src/a.test.ts'), false, 'defaults dropped');
  assert.deepEqual(resolveTestFilePatterns(null), DEFAULT_TEST_FILE_PATTERNS);
});

test('summarizeDiffKinds prefers a stamped kind and reports the test share of changed lines', () => {
  const summary = summarizeDiffKinds([
    { path: 'src/a.ts', additions: 30, deletions: 10 },
    { path: 'src/a.test.ts', additions: 20, deletions: 0 },
    { path: 'src/b.ts', additions: 5, deletions: 5, kind: 'test' },
  ]);
  assert.deepEqual(summary, {
    codeFiles: 1,
    testFiles: 2,
    codeLines: 40,
    testLines: 30,
    testShare: 30 / 70,
  });
  assert.equal(summarizeDiffKinds([]).testShare, null);
  assert.equal(classifyDiffFile('src/a.test.ts'), 'test');
  assert.equal(classifyDiffFile('src/a.ts'), 'code');
});
