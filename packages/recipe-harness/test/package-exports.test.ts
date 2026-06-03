import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

test('package exports expose stable public harness subpaths', async () => {
  const root = await dynamicImport('@farmslot/recipe-harness');
  const runner = await dynamicImport('@farmslot/recipe-harness/runner');
  const adapters = await dynamicImport('@farmslot/recipe-harness/adapters/core');
  const cdp = await dynamicImport('@farmslot/recipe-harness/runtime/cdp');
  const cli = await dynamicImport('@farmslot/recipe-harness/cli');
  const cliSupport = await dynamicImport('@farmslot/recipe-harness/cli/support');

  assert.equal(typeof root.createRecipeRunner, 'function');
  assert.equal(typeof runner.createRecipeRunner, 'function');
  assert.equal(typeof adapters.createStandardCoreAdapters, 'function');
  assert.equal(typeof cdp.createCdpWebUiTransport, 'function');
  assert.equal(typeof cli.runRecipeHarnessCli, 'function');
  assert.equal(typeof cliSupport.validateRecipeCliInput, 'function');
  assert.equal(root.runRecipeHarnessCli, undefined);
  assert.equal(root.createCdpWebUiTransport, undefined);
});

test('package exports are explicit and extensionless', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { exports: Record<string, unknown> };
  const exportSubpaths = Object.keys(packageJson.exports);
  assert.equal(
    exportSubpaths.some((subpath) => subpath.endsWith('.js')),
    false,
  );
  assert.equal(
    exportSubpaths.some((subpath) => subpath.includes('*')),
    false,
  );
});

test('package exports block internal harness modules', async () => {
  for (const blocked of [
    '@farmslot/recipe-harness/core/json.js',
    '@farmslot/recipe-harness/core/flows.js',
    '@farmslot/recipe-harness/node/writers.js',
    '@farmslot/recipe-harness/cli-support',
    '@farmslot/recipe-harness/runner.js',
    '@farmslot/recipe-harness/adapters/core.js',
    '@farmslot/recipe-harness/tests/recipe-harness.test.js',
  ]) {
    await assert.rejects(
      dynamicImport(blocked),
      /Package subpath|Cannot find module|ERR_PACKAGE_PATH_NOT_EXPORTED/,
      `${blocked} should remain internal`,
    );
  }
});
