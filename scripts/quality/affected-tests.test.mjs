import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSourceGraph, selectAffectedTests, sourceReferences } from './affected-tests.mjs';

const workspaces = [
  { name: '@farmslot/lib', dir: 'packages/lib', dependencies: [] },
  { name: '@farmslot/app', dir: 'apps/app', dependencies: ['@farmslot/lib'] },
];
const sources = {
  'packages/lib/src/index.ts': 'export const value = 1;',
  'apps/app/src/model.ts': "export { value } from '@farmslot/lib';",
  'apps/app/src/model.test.ts': "import './model.js';",
  'apps/app/src/other.test.ts': 'export {};',
};
function select(changed, additions = {}) {
  const input = { ...sources, ...additions };
  const files = Object.keys(input);
  return selectAffectedTests({
    files,
    changed,
    workspaces,
    graph: buildSourceGraph(files, workspaces, (file) => input[file]),
  });
}
test('follows reverse imports across workspace consumers and .js source imports', () => {
  assert.deepEqual(select(['packages/lib/src/index.ts']), ['apps/app/src/model.test.ts']);
});
test('runs a changed test even without imports', () => {
  assert.deepEqual(select(['apps/app/src/other.test.ts']), ['apps/app/src/other.test.ts']);
});
test('config and deleted files widen to every consumer test', () => {
  for (const file of ['packages/lib/tsconfig.json', 'packages/lib/src/deleted.ts']) {
    assert.deepEqual(select([file]), ['apps/app/src/model.test.ts', 'apps/app/src/other.test.ts']);
  }
});
test('dynamic imports widen owner suites', () => {
  assert.deepEqual(
    select(['packages/lib/src/index.ts'], { 'apps/app/src/dynamic.ts': 'import(moduleName);' }),
    ['apps/app/src/model.test.ts', 'apps/app/src/other.test.ts'],
  );
});
test('literal fixture references connect assets', () => {
  assert.deepEqual(
    select(['apps/app/src/fixture.json'], {
      'apps/app/src/fixture.json': '{}',
      'apps/app/src/fixture.test.ts': "readFileSync(new URL('./fixture.json', import.meta.url));",
    }),
    ['apps/app/src/model.test.ts', 'apps/app/src/other.test.ts', 'apps/app/src/fixture.test.ts'],
  );
});
test('full selection ignores filters; parser does not treat commented imports as syntax', () => {
  assert.deepEqual(select(null), ['apps/app/src/model.test.ts', 'apps/app/src/other.test.ts']);
  assert.deepEqual(
    sourceReferences("// import './never.ts'\nimport './actual.ts';", 'source.ts').references,
    ['./actual.ts'],
  );
});

test('source-reading guards remain selected for basename and computed paths', () => {
  const additions = {
    'apps/app/src/panel.ts': 'export const panel = 1;',
    'apps/app/src/panel.test.ts': "readFileSync(path.resolve(import.meta.dirname, 'panel.ts'));",
    'apps/app/src/computed.test.ts': 'readFileSync(path.resolve(directory, `${name}.ts`));',
  };
  assert.deepEqual(select(['apps/app/src/panel.ts'], additions), [
    'apps/app/src/panel.test.ts',
    'apps/app/src/computed.test.ts',
  ]);
});

test('release notes do not expand a narrow source change to the full consumer suite', () => {
  assert.deepEqual(select(['packages/lib/src/index.ts', 'packages/lib/.changes/fix.md']), [
    'apps/app/src/model.test.ts',
  ]);
  assert.deepEqual(select(['packages/lib/.changes/fix.md']), []);
});
