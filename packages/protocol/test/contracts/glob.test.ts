import assert from 'node:assert/strict';
import test from 'node:test';

import { compileGlob, globDoubleStarRuns, normalizeGlobPattern } from '../../src/contracts/glob.js';

const anchored = { anchoring: 'anchored' as const, caseSensitive: false };
const segment = { anchoring: 'segment' as const, caseSensitive: true };

test('anchored globs mirror git pathspecs: root-anchored, case-insensitive', () => {
  const star = compileGlob('*.ts', anchored);
  assert.equal(star.regex.test('foo.ts'), true);
  assert.equal(star.regex.test('dir/foo.ts'), false, 'a bare glob names root files only');
  assert.equal(star.regex.test('FOO.TS'), true, 'case-insensitive');
  const deep = compileGlob('**/*.ts', anchored);
  assert.equal(deep.regex.test('foo.ts'), true, 'a leading double-star includes the root');
  assert.equal(deep.regex.test('a/b/foo.ts'), true);
  assert.equal(compileGlob('src/**', anchored).regex.test('src/a/b.ts'), true);
  assert.equal(
    compileGlob('tests/', anchored).regex.test('tests/x.ts'),
    false,
    'no directory rule',
  );
});

test('segment globs follow the gitignore-like rules', () => {
  assert.equal(compileGlob('fixtures', segment).regex.test('src/fixtures/a.json'), true);
  assert.equal(compileGlob('fixtures', segment).regex.test('src/fixtures.ts'), false);
  assert.equal(compileGlob('tests/', segment).regex.test('src/a/tests/x.ts'), true);
  assert.equal(compileGlob('tests/', segment).regex.test('src/tests'), false);
  assert.equal(compileGlob('src/mocks/*.ts', segment).regex.test('pkg/src/mocks/a.ts'), false);
  assert.equal(compileGlob('**/mocks/*.ts', segment).regex.test('pkg/src/mocks/a.ts'), true);
  assert.equal(
    compileGlob('*Test.java', segment).regex.test('src/latest.java'),
    false,
    'case-sensitive',
  );
  assert.equal(
    compileGlob('/root.ts', segment).regex.test('root.ts'),
    true,
    'leading slash stripped',
  );
});

test('normalization collapses double-star runs and rejects character classes in both modes', () => {
  assert.equal(normalizeGlobPattern('.\\a\\**/**/**/b'), 'a/**/b');
  assert.equal(normalizeGlobPattern('x**/**/y'), 'x**/y', 'git reads both the same');
  assert.equal(globDoubleStarRuns('**/**/a/**/b'), 2);
  for (const options of [anchored, segment]) {
    const bad = compileGlob('src/[ab].ts', options);
    assert.equal(bad.invalid, true);
    assert.match(bad.reason ?? '', /character-class/);
    assert.equal(bad.regex.test('src/[ab].ts'), false, 'an invalid pattern matches nothing');
    assert.equal(compileGlob('a?.ts', options).regex.test('ab.ts'), true);
    assert.equal(compileGlob('a?.ts', options).regex.test('abc.ts'), false);
    assert.equal(compileGlob('a.ts', options).regex.test('aXts'), false, 'dots are literal');
    assert.equal(compileGlob('src/**', options).regex.test('src/a/b.ts'), true);
  }
});

// Measured with `git ls-files -- ':(glob)P'` on git 2.54.0 over these paths; the
// compiler must agree with git on every row so the JS matcher and the emitted
// pathspec never disagree about a file.
test('double-star rules match real git :(glob) pathspecs', () => {
  const paths = [
    'ab',
    'a/b',
    'ax/b',
    'ax/y/b',
    'axb',
    'b',
    'xy',
    'x/y',
    'xa/y',
    'xa/b/y',
    'srcfoo.ts',
    'srcx/y/foo.ts',
    'src/foo.ts',
  ];
  const gitTruth: Record<string, string[]> = {
    'a**/b': ['a/b', 'ab', 'ax/b', 'ax/y/b'],
    'a**b': ['ab', 'axb'],
    '**b': ['ab', 'axb', 'b'],
    'a**': ['a/b', 'ab', 'ax/b', 'ax/y/b', 'axb'],
    'x**/**/y': ['x/y', 'xa/b/y', 'xa/y', 'xy'],
    'x**/y': ['x/y', 'xa/b/y', 'xa/y', 'xy'],
    'src**/foo.ts': ['src/foo.ts', 'srcfoo.ts', 'srcx/y/foo.ts'],
    '**/b': ['a/b', 'ax/b', 'ax/y/b', 'b'],
  };
  for (const [pattern, expected] of Object.entries(gitTruth)) {
    const { regex } = compileGlob(pattern, anchored);
    assert.deepEqual(paths.filter((path) => regex.test(path)).sort(), expected, pattern);
  }
});
