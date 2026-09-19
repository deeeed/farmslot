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
    'src/a_spec.rb',
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
    'packages/handoff/src/spec/schemas.ts',
    'src/specification.ts',
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

test('pattern shapes follow the documented segment, directory, and anchored rules', () => {
  const match = (pattern: string, path: string) =>
    compileTestFileMatcher(
      resolveTestFilePatterns({ testPatterns: [pattern], useDefaultTestPatterns: false }),
    )(path);
  // bare name: a segment anywhere, file or directory
  assert.equal(match('fixtures', 'src/fixtures/a.json'), true);
  assert.equal(match('fixtures', 'fixtures'), true);
  assert.equal(match('fixtures', 'src/fixtures.ts'), false);
  // trailing slash: directory anywhere
  assert.equal(match('tests/', 'src/a/tests/x.ts'), true);
  assert.equal(match('tests/', 'tests/x.ts'), true);
  assert.equal(match('tests/', 'src/tests'), false, 'a file named tests is not the directory');
  // inner slash: anchored at the root unless it starts with **/
  assert.equal(match('src/mocks/*.ts', 'src/mocks/a.ts'), true);
  assert.equal(match('src/mocks/*.ts', 'pkg/src/mocks/a.ts'), false);
  assert.equal(match('**/mocks/*.ts', 'pkg/src/mocks/a.ts'), true);
  // ? and backslash paths
  assert.equal(match('a?.ts', 'src/ab.ts'), true);
  assert.equal(match('a?.ts', 'src/abc.ts'), false);
  assert.equal(match('*.test.*', 'src\\a.test.ts'), true);
  // case-sensitive
  assert.equal(match('*Test.java', 'src/latest.java'), false);
});

test('project patterns are capped and double-star runs cannot hang the matcher', () => {
  const resolved = resolveTestFilePatterns({
    testPatterns: [...Array.from({ length: 300 }, (_, i) => `p${i}.x`), 'x'.repeat(300)],
    useDefaultTestPatterns: false,
  });
  assert.equal(resolved.length, 256, 'entries capped');
  assert.equal(
    resolved.some((pattern) => pattern.length > 256),
    false,
    'long entries dropped',
  );

  const adjacent = compileTestFileMatcher(['**/**/**/**/**/**/**/**/a']);
  assert.equal(adjacent('p/q/a'), true, 'adjacent runs collapse to one');

  const interleaved = '**/*/**/*/**/*/**/*/**/*/**/*/**/*/**/*.spec.ts';
  assert.deepEqual(
    resolveTestFilePatterns({ testPatterns: [interleaved], useDefaultTestPatterns: false }),
    [],
    'a pattern with more than four double-star runs is dropped',
  );
  const monorepo = compileTestFileMatcher(
    resolveTestFilePatterns({
      testPatterns: ['**/packages/**/src/**/*.spec.ts'],
      useDefaultTestPatterns: false,
    }),
  );
  assert.equal(monorepo('packages/x/src/y/a.spec.ts'), true, 'three runs is an ordinary glob');
  assert.equal(monorepo('apps/x/src/a.spec.ts'), false);
  const started = Date.now();
  assert.equal(compileTestFileMatcher([interleaved])(`${'x/'.repeat(60)}${'y'.repeat(60)}`), false);
  assert.ok(Date.now() - started < 100, 'the compiler drops it too');

  const twoRuns = compileTestFileMatcher(['**/pkg/**/*.spec.ts']);
  const startedTwo = Date.now();
  assert.equal(twoRuns(`${'x/'.repeat(60)}${'y'.repeat(60)}`), false);
  assert.ok(Date.now() - startedTwo < 100, 'two runs stay fast');
  assert.equal(twoRuns('a/pkg/b/c.spec.ts'), true);
});
