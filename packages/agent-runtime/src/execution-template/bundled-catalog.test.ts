import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type {
  ConfiguredExecutionTemplateSource,
  ProjectExecutionTemplatesConfig,
} from '@farmslot/protocol';

import {
  EXECUTION_TEMPLATE_CATALOG_DIR,
  EXECUTION_TEMPLATE_CATALOG_FILE,
  type ExecutionTemplateCatalogSnapshot,
} from './bundled-catalog.js';
import {
  resolveConfiguredExecutionTemplateSources,
  resolveConfiguredExecutionTemplateSourcesAsync,
} from './source-config.js';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'bundled-catalog-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const declaration: ConfiguredExecutionTemplateSource = {
    id: 'package:cook',
    kind: 'package',
    root: { env: 'COOK_ROOT' },
    subpath: 'references/templates',
    domains: ['perps'],
  };
  const config: ProjectExecutionTemplatesConfig = { sources: [declaration] };
  const relativeRoot = `${EXECUTION_TEMPLATE_CATALOG_DIR}/cook`;
  mkdirSync(path.join(root, relativeRoot, 'dev'), { recursive: true });
  writeFileSync(path.join(root, relativeRoot, 'dev/core.md'), '# Core\n- [ ] Frozen\n');
  const snapshot: ExecutionTemplateCatalogSnapshot = {
    version: 1,
    sources: [{ declaration, relativeRoot, sourceRevision: 'a'.repeat(40), sourceDirty: false }],
  };
  const write = (value: unknown) =>
    writeFileSync(path.join(root, EXECUTION_TEMPLATE_CATALOG_FILE), JSON.stringify(value));
  write(snapshot);
  return { root, declaration, config, snapshot, write, relativeRoot };
}

test('bundled catalogs preserve declared scope and observed provenance without Git or node env roots', async (t) => {
  const f = fixture(t);
  let git = 0;
  const selected = await resolveConfiguredExecutionTemplateSourcesAsync(
    f.config,
    { projectPackRoot: f.root, env: { COOK_ROOT: '/unrelated/node/checkout' } },
    async () => {
      git++;
      throw new Error('A frozen catalog must not query Git');
    },
  );
  assert.equal(git, 0);
  assert.deepEqual(selected.unavailable, []);
  assert.deepEqual(selected.sources, [
    {
      id: f.declaration.id,
      kind: 'package',
      root: path.join(f.root, f.relativeRoot),
      layout: 'flow-tree',
      domains: ['perps'],
      sourceRevision: 'a'.repeat(40),
      sourceDirty: false,
    },
  ]);
});

test('unavailable or omitted optional catalogs never fall back to an installed environment root', (t) => {
  const f = fixture(t);
  for (const sources of [
    [],
    [{ declaration: f.declaration, unavailableReason: 'missing-environment' }],
  ]) {
    f.write({ version: 1, sources });
    const selected = resolveConfiguredExecutionTemplateSources(f.config, {
      projectPackRoot: f.root,
      env: { COOK_ROOT: f.root },
    });
    assert.deepEqual(selected.sources, []);
    assert.equal(selected.unavailable[0].id, f.declaration.id);
  }
});

test('node configuration retains declaration authority over the shipped catalog', (t) => {
  const f = fixture(t);
  const changed: ConfiguredExecutionTemplateSource[] = [
    { ...f.declaration, kind: 'workspace' },
    { ...f.declaration, domains: ['money-movement'] },
    { ...f.declaration, root: { env: 'OTHER_ROOT' } },
    { ...f.declaration, subpath: 'other' },
  ];
  for (const declaration of changed)
    assert.throws(
      () =>
        resolveConfiguredExecutionTemplateSources(
          { sources: [declaration] },
          { projectPackRoot: f.root },
        ),
      { code: 'TASK_TEMPLATE_CATALOG_INVALID' },
    );
});

test('malformed descriptors, escaping roots and promised missing roots fail closed', (t) => {
  const f = fixture(t);
  for (const value of [
    { version: 2, sources: [] },
    { version: 1, sources: [{ declaration: f.declaration, relativeRoot: '../escape' }] },
    {
      version: 1,
      sources: [
        { declaration: f.declaration, relativeRoot: `${EXECUTION_TEMPLATE_CATALOG_DIR}/missing` },
      ],
    },
  ]) {
    f.write(value);
    assert.throws(
      () => resolveConfiguredExecutionTemplateSources(f.config, { projectPackRoot: f.root }),
      { code: 'TASK_TEMPLATE_CATALOG_INVALID' },
    );
  }
});

test('source-lock bindings cannot be replaced by a bundled legacy env catalog', (t) => {
  const f = fixture(t);
  const selected = resolveConfiguredExecutionTemplateSources(f.config, {
    projectPackRoot: f.root,
    resolveSourceBinding: () => ({
      root: f.root,
      commit: 'b'.repeat(40),
      lockDigest: 'c'.repeat(64),
    }),
  });
  assert.deepEqual(selected.sources, []);
  assert.deepEqual(selected.unavailable, [{ id: f.declaration.id, reason: 'invalid-root' }]);
});

test('a runtime bundle root is independent of the installed pack root', (t) => {
  const f = fixture(t);
  const installed = path.join(f.root, 'installed-pack');
  mkdirSync(installed);
  const selected = resolveConfiguredExecutionTemplateSources(f.config, {
    projectPackRoot: installed,
    catalogRoot: f.root,
  });
  assert.equal(selected.sources[0].root, path.join(f.root, f.relativeRoot));
});
