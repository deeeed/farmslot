import assert from 'node:assert/strict';
import test from 'node:test';

import { assertWorkspaceTestScripts, selectWorkspaceTests } from './workspace-test-targets.mjs';

const workspace = (name, dir, dependencies = [], quality = 'yarn test') => ({
  name,
  dir,
  dependencies,
  test: 'node --test',
  quality,
});
const catalog = [
  workspace('@farmslot/protocol', 'packages/protocol'),
  workspace('@farmslot/run-bundle', 'packages/run-bundle', ['@farmslot/protocol']),
  workspace('@farmslot/gateway', 'services/gateway', ['@farmslot/run-bundle']),
  workspace('@farmslot/unrelated', 'packages/unrelated'),
];
const filters = { repo: 'true', protocol: 'false', gateway: 'false' };
const jobs = new Set(['repo', 'protocol', 'gateway']);

test('a tracked test in a workspace without a suite fails the coverage inventory', () => {
  const missing = { ...workspace('@farmslot/new-suite', 'packages/new-suite'), test: undefined };
  assert.throws(
    () => assertWorkspaceTestScripts([missing], ['packages/new-suite/src/a.test.ts']),
    /contains .* but defines no test script/,
  );
  assert.doesNotThrow(() =>
    assertWorkspaceTestScripts(catalog, ['packages/run-bundle/src/a.test.ts']),
  );
  assert.doesNotThrow(() =>
    assertWorkspaceTestScripts(
      [{ ...missing, name: '@farmslot/command-center-ui', dir: 'apps/command-center/ui' }],
      ['apps/command-center/ui/src/a.test.ts'],
    ),
  );
});

test('run-bundle and its transitive consumers run without unrelated suites', () => {
  const result = selectWorkspaceTests(
    catalog,
    ['packages/run-bundle/src/retained.ts'],
    filters,
    jobs,
  );
  assert.deepEqual(result.targets, ['gateway', 'repo']);
  assert.deepEqual(result.matrix, [{ workspace: '@farmslot/run-bundle', script: 'quality' }]);
});

test('protocol changes include downstream suites through multiple dependency edges', () => {
  const result = selectWorkspaceTests(catalog, ['packages/protocol/src/index.ts'], filters, jobs);
  assert.deepEqual(result.targets, ['gateway', 'protocol', 'repo']);
  assert.deepEqual(result.matrix, [{ workspace: '@farmslot/run-bundle', script: 'quality' }]);
});

test('new workspaces automatically get a CI test owner', () => {
  const fresh = workspace('@farmslot/new-suite', 'packages/new-suite', [], undefined);
  delete fresh.quality;
  const result = selectWorkspaceTests(
    [...catalog, fresh],
    ['packages/new-suite/test/a.test.ts'],
    filters,
    jobs,
  );
  assert.deepEqual(result.matrix, [{ workspace: '@farmslot/new-suite', script: 'test' }]);
  assert.equal(
    result.coverage.find((entry) => entry.workspace === fresh.name).owner,
    'workspace-tests',
  );
});

test('existing filters are preserved and shared runner or manual changes cover every suite', () => {
  for (const changed of [null, ['yarn.lock'], ['scripts/quality/run-tsx-tests.mjs']]) {
    const result = selectWorkspaceTests(catalog, changed, filters, jobs);
    assert.deepEqual(result.targets, ['gateway', 'protocol', 'repo']);
    assert.equal(result.matrix.length, 2);
  }
  assert.deepEqual(
    selectWorkspaceTests(catalog, [], { ...filters, gateway: 'true' }, jobs).targets,
    ['gateway', 'repo'],
  );
});

test('a quality job that does not call its test cannot hide that suite', () => {
  const result = selectWorkspaceTests(
    [workspace('@farmslot/protocol', 'packages/protocol', [], 'tsc --noEmit')],
    ['packages/protocol/src/a.ts'],
    filters,
    jobs,
  );
  assert.deepEqual(result.matrix, [{ workspace: '@farmslot/protocol', script: 'test' }]);
});

test('nested UI workspace changes and app dependency changes select the parent quality job', () => {
  const ui = {
    ...workspace('@farmslot/command-center-ui', 'apps/command-center/ui', ['@farmslot/run-bundle']),
    test: undefined,
  };
  const result = selectWorkspaceTests(
    [...catalog, ui],
    ['packages/run-bundle/src/retained.ts'],
    { ...filters, command_center: 'false' },
    new Set([...jobs, 'command-center']),
  );
  assert.ok(result.targets.includes('command_center'));
});
