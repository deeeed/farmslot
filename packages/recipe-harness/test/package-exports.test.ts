import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

test('package exports expose stable public harness subpaths', async () => {
  const root = await dynamicImport('@farmslot/recipe-harness');
  const runner = await dynamicImport('@farmslot/recipe-harness/runner');
  const adapters = await dynamicImport('@farmslot/recipe-harness/adapters/core');
  const appLifecycle = await dynamicImport('@farmslot/recipe-harness/adapters/app-lifecycle');
  const cdp = await dynamicImport('@farmslot/recipe-harness/runtime/cdp');
  const cli = await dynamicImport('@farmslot/recipe-harness/cli');
  const cliSupport = await dynamicImport('@farmslot/recipe-harness/cli/support');

  assert.equal(typeof root.createRecipeRunner, 'function');
  assert.equal(typeof root.createAppLifecycleAdapters, 'function');
  assert.equal(typeof runner.createRecipeRunner, 'function');
  assert.equal(typeof adapters.createStandardCoreAdapters, 'function');
  assert.equal(typeof appLifecycle.createAppLifecycleAdapter, 'function');
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

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

// A node process without the test runner's loader is a real CommonJS consumer.
function plainNode(args: string[]) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, args, { cwd: packageRoot, env, encoding: 'utf8' });
}

test('every package export loads with require() from CommonJS', () => {
  const result = plainNode([
    '-e',
    `for (const subpath of Object.keys(require('./package.json').exports)) {
      require('@farmslot/recipe-harness' + subpath.slice(1));
    }`,
  ]);
  assert.equal(result.status, 0, result.stderr);
});

test('the cli entry still runs as a program when executed directly', () => {
  const version = plainNode(['dist/cli/index.js', '--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/u);
  const failed = plainNode(['dist/cli/index.js', 'validate', '/nonexistent/missing.recipe.json']);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Failed to read JSON/u);
});
