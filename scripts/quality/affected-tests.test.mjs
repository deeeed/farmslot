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
    ['apps/app/src/fixture.test.ts'],
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

test('descriptive paths in protocol metadata do not make UI files gateway dependencies', () => {
  const input = {
    'apps/app/src/panel.ts': 'export const panel = 1;',
    'apps/app/src/panel.test.ts': "import './panel.js';",
    'packages/lib/src/index.ts': "export const location = 'apps/app/src/panel.ts';",
    'packages/lib/src/metadata.test.ts': "import './index.js';",
  };
  const files = Object.keys(input);
  const graph = buildSourceGraph(files, workspaces, (file) => input[file]);
  assert.deepEqual(
    selectAffectedTests({ files, changed: ['apps/app/src/panel.ts'], workspaces, graph }),
    ['apps/app/src/panel.test.ts'],
  );
});

test('an unresolved temporary import in a selected test does not widen its whole workspace', () => {
  assert.deepEqual(
    select(['apps/app/src/model.test.ts'], {
      'apps/app/src/model.test.ts': "import './model.js'; require('./temporary-fixture.js');",
    }),
    ['apps/app/src/model.test.ts'],
  );
});

test('script execution by a literal source path selects its test consumer', () => {
  const input = {
    'scripts/tool.mts': 'export const value = 1;',
    'scripts/tool.test.mjs':
      "execFile(process.execPath, [path.resolve(root, 'scripts/tool.mts')]);",
    'scripts/other.test.mjs': 'export {};',
  };
  const files = Object.keys(input);
  const graph = buildSourceGraph(files, [], (file) => input[file]);
  assert.deepEqual(
    selectAffectedTests({ files, changed: ['scripts/tool.mts'], workspaces: [], graph }),
    ['scripts/tool.test.mjs'],
  );
});

test('review template changes select their golden consumer without widening gateway tests', () => {
  const golden = 'services/gateway/src/review/templates-golden.test.ts';
  const files = [
    'projects/farmslot-farm/templates/worker/review.md',
    golden,
    'services/gateway/src/review/unrelated.test.ts',
  ];
  const workspaces = [{ name: '@farmslot/gateway', dir: 'services/gateway', dependencies: [] }];
  const graph = buildSourceGraph(files, workspaces, () => 'export {};');
  for (const name of ['review.md', 'review.static-code.md', 'review.full-live.md']) {
    assert.deepEqual(
      selectAffectedTests({
        files,
        changed: [`projects/farmslot-farm/templates/worker/${name}`],
        workspaces,
        graph,
      }),
      [golden],
      name,
    );
  }
  assert.deepEqual(
    selectAffectedTests({
      files,
      changed: ['projects/another/templates/worker/review.md'],
      workspaces,
      graph,
    }),
    [],
  );
});

test('exported CJS and MJS scripts select consumers without making package tests production inputs', () => {
  for (const extension of ['cjs', 'mjs']) {
    const script = `packages/lib/scripts/entry.${extension}`;
    const input = {
      [script]: 'export const value = 1;',
      'packages/lib/src/unrelated.test.ts': 'export {};',
      'apps/app/src/model.ts': `import '@farmslot/lib/scripts/entry.${extension}';`,
    };
    assert.deepEqual(select([script], input), ['apps/app/src/model.test.ts']);
    assert.deepEqual(select(['packages/lib/src/unrelated.test.ts'], input), [
      'packages/lib/src/unrelated.test.ts',
    ]);
  }
});

test('conditional and wildcard package exports resolve actual scripts and types before guessed paths', () => {
  const input = {
    ...sources,
    'packages/lib/scripts/actual.cjs': 'module.exports = 1;',
    'packages/lib/scripts/actual.d.cts': 'export declare const value: number;',
    'packages/lib/src/tool.ts': 'export const decoy = 1;',
    'packages/lib/src/other.test.ts': 'export {};',
    'apps/app/src/model.ts': "import '@farmslot/lib/tool/actual';",
  };
  const catalog = workspaces.map((workspace) =>
    workspace.name === '@farmslot/lib'
      ? {
          ...workspace,
          exports: { './tool/*': { import: './scripts/*.cjs', types: './scripts/*.d.cts' } },
        }
      : workspace,
  );
  const files = Object.keys(input);
  const graph = buildSourceGraph(files, catalog, (file) => input[file]);
  for (const file of ['packages/lib/scripts/actual.cjs', 'packages/lib/scripts/actual.d.cts'])
    assert.deepEqual(selectAffectedTests({ files, changed: [file], workspaces: catalog, graph }), [
      'apps/app/src/model.test.ts',
    ]);
  assert.deepEqual(
    selectAffectedTests({
      files,
      changed: ['packages/lib/src/other.test.ts'],
      workspaces: catalog,
      graph,
    }),
    ['packages/lib/src/other.test.ts'],
  );
});

test('repository path joins select their asset and golden readers, not unrelated readers', () => {
  const input = {
    'apps/app/src/fixture.json': '{}',
    'apps/app/src/view.golden.md': 'golden',
    'apps/app/src/asset.test.ts': `
      import { readFileSync } from 'node:fs';
      import { join as pathJoin } from 'node:path';
      const fixture = pathJoin(import.meta.dirname, 'fixture.json');
      readFileSync(fixture);
    `,
    'apps/app/src/golden.test.ts': `
      import fs from 'node:fs';
      import { fileURLToPath } from 'node:url';
      const golden = fileURLToPath(new URL('./view.golden.md', import.meta.url));
      fs.readFileSync(golden);
    `,
  };
  assert.deepEqual(select(['apps/app/src/fixture.json'], input), ['apps/app/src/asset.test.ts']);
  assert.deepEqual(select(['apps/app/src/view.golden.md'], input), ['apps/app/src/golden.test.ts']);
  assert.deepEqual(select(['apps/app/src/model.ts'], input), ['apps/app/src/model.test.ts']);
});

test('private fixture output does not widen unrelated changes and still follows its imports', () => {
  const input = {
    'apps/app/src/output.test.ts': `
      import { mkdtempSync, readFileSync } from 'node:fs';
      import os from 'node:os';
      import path from 'node:path';
      import './model.js';
      const root = mkdtempSync(path.join(os.tmpdir(), 'output-'));
      const output = path.join(root, 'result.json');
      readFileSync(output);
    `,
  };
  assert.deepEqual(select(['apps/app/src/other.test.ts'], input), ['apps/app/src/other.test.ts']);
  assert.deepEqual(select(['apps/app/src/model.ts'], input), [
    'apps/app/src/model.test.ts',
    'apps/app/src/output.test.ts',
  ]);
});

test('mutable, shadowed, linked and script-produced paths retain the unknown-read fallback', () => {
  for (const body of [
    "let root = mkdtempSync(join(tmpdir(), 'x-')); readFileSync(join(root, 'result'));",
    "const root = mkdtempSync(join(tmpdir(), 'x-')); function check(root) { readFileSync(join(root, 'result')); }",
    "const root = mkdtempSync(join(tmpdir(), 'x-')); function check({root}) { readFileSync(join(root, 'result')); }",
    "const root = mkdtempSync(join(tmpdir(), 'x-')); function check() { const [root] = inputs; readFileSync(join(root, 'result')); }",
    "const root = mkdtempSync(join(tmpdir(), 'x-')); symlinkSync(target, root); readFileSync(join(root, 'result'));",
    "const root = mkdtempSync(join(tmpdir(), 'x-')); execFileSync(tool); readFileSync(join(root, 'result'));",
    "const root = new URL('../../../../outside/', import.meta.url); readdirSync(root);",
    "sdk.readFile(new URL('./known.json', import.meta.url));",
  ]) {
    const input = {
      'apps/app/src/known.json': '{}',
      'apps/app/src/unknown.test.ts': `
        import { mkdtempSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
        import { join } from 'node:path';
        import { tmpdir } from 'node:os';
        ${body}
      `,
    };
    assert.deepEqual(
      select(['apps/app/src/other.test.ts'], input),
      ['apps/app/src/other.test.ts', 'apps/app/src/unknown.test.ts'],
      body,
    );
  }
});

test('directory readers follow additions and deletions outside workspace ownership', () => {
  const input = {
    'apps/app/src/catalog.test.ts': `
      import { readdirSync as list } from 'node:fs';
      list(new URL('../../../projects/pack/', import.meta.url));
    `,
    'projects/pack/current.json': '{}',
  };
  for (const file of ['projects/pack/current.json', 'projects/pack/removed.json'])
    assert.deepEqual(select([file], input), ['apps/app/src/catalog.test.ts']);
});

test('Python source inputs reach runtime consumers while compiler and package configs stay broad', () => {
  const input = {
    'packages/lib/scripts/tool.py': 'pass',
    'packages/lib/src/index.ts': `
      import { readFileSync } from 'node:fs';
      readFileSync(new URL('../scripts/tool.py', import.meta.url));
    `,
    'packages/lib/package.json': '{}',
    'packages/lib/build.config.mjs': 'export {};',
  };
  assert.deepEqual(select(['packages/lib/scripts/tool.py'], input), ['apps/app/src/model.test.ts']);
  for (const file of ['packages/lib/package.json', 'packages/lib/build.config.mjs'])
    assert.deepEqual(select([file], input), [
      'apps/app/src/model.test.ts',
      'apps/app/src/other.test.ts',
    ]);
});

test('a known asset reader cannot hide another production reader with a computed input', () => {
  const input = {
    'packages/lib/assets/value.json': '{}',
    'packages/lib/src/index.ts': "export * from './dynamic.js';",
    'packages/lib/src/dynamic.ts':
      "import { readFileSync } from 'node:fs'; readFileSync(runtimeFile);",
    'packages/lib/src/asset.test.ts':
      "import { readFileSync } from 'node:fs'; readFileSync(new URL('../assets/value.json', import.meta.url));",
  };
  assert.deepEqual(select(['packages/lib/assets/value.json'], input), [
    'apps/app/src/model.test.ts',
    'apps/app/src/other.test.ts',
    'packages/lib/src/asset.test.ts',
  ]);
});
