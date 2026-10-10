import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { recipeConformanceIdentity } from '@farmslot/recipe-cli/harness';

const cliConfig = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
const commandUrl = new URL('./doctor.ts', import.meta.url).href;
const driver = `
  import {Command} from 'commander';
  import {registerDoctorCommand} from '${commandUrl}';
  const program = new Command().name('farmslot').option('--json');
  registerDoctorCommand(program);
  await program.parseAsync(process.argv.slice(1), {from:'user'});
`;
const manifest = JSON.parse(
  fs.readFileSync(
    new URL('../../../recipe-cli/test/fixtures/proof.action-manifest.json', import.meta.url),
    'utf8',
  ),
);

function fixture(t: TestContext, missing = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-doctor-')));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${root}.imported`, { force: true });
  });
  const write = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(
      path.join(root, file),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  write('recipe-library.json', { schema_version: 1, name: 'example', platforms: ['headless'] });
  write('project.json', {
    name: 'example',
    paths: { runtime_dir: '.runtime', artifact_dir: 'artifacts' },
    recipe: { adapter: 'headless', provider: { module: 'provider.mjs' } },
  });
  const example = {
    description: 'Read the checkout.',
    execution_capabilities: ['host-read-export'],
    examples: [{ action: 'example.read', intent: 'Read the checkout.', next: 'done' }],
    schema: { type: 'object', properties: {}, additionalProperties: false },
  };
  write('manifests/headless.action-manifest.json', {
    $schema: manifest.$schema,
    actions: { 'example.read': example },
  });
  write('recipes/headless/smoke.recipe.json', {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Read-only preflight',
    workflow: {
      entry: 'read',
      nodes: {
        read: { action: 'example.read', intent: 'Inspect the checkout.', next: 'done' },
        done: { action: 'end', status: 'pass' },
      },
    },
  });
  write(
    'provider.mjs',
    `
    import fs from 'node:fs';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    const root = path.dirname(fileURLToPath(import.meta.url));
    fs.writeFileSync(root + '.imported', 'yes');
    export function createProvider() {
      return { runtime: {
        id: 'headless', sdkVersion: 1, headless: true,
        runtimeStatus: async () => ({decision:'ready', reasons:[]}),
        resolveSlotPorts() {}, logSources: () => [], appLogSource: () => null,
        launch: async () => { throw new Error('doctor launched the app'); },
        devServer: {}, hints: {}, harness: {}, runtimeContext: {},
        actions: {
          manifestPath: () => path.join(root, 'manifests/headless.action-manifest.json'),
          semantic: [], cdpTarget: {transport:'none'},
          adapters: async () => ${missing ? '[]' : `[{action:'example.read', execute:async () => {throw new Error('doctor executed an action');}}]`}
        }
      }};
    }
  `,
  );
  return { root, write };
}

function run(root: string, flags: string[]) {
  const env = { ...process.env };
  for (const name of [
    'FARMSLOT_ROOT',
    'FARMSLOT_POOL_DIR',
    'RECIPE_RUNTIME_CONTEXT',
    'RECIPE_LIBRARY_PATH',
  ])
    delete env[name];
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      driver,
      '--',
      '--json',
      'doctor',
      root,
      '--conformance',
      ...flags,
    ],
    {
      env: { ...env, TSX_TSCONFIG_PATH: cliConfig },
      cwd: path.dirname(cliConfig),
      encoding: 'utf8',
      timeout: 4900,
    },
  );
  assert.ifError(result.error);
  return { status: result.status, envelope: JSON.parse(result.stdout) };
}

test('public doctor refuses discovered code before import', (t) => {
  const { root } = fixture(t);
  const result = run(root, []);
  assert.equal(result.status, 1);
  assert.equal(result.envelope.error.code, 'PROVIDER_UNAUTHORIZED');
  assert.equal(fs.existsSync(`${root}.imported`), false);
});

test('public doctor preflights a headless catalog without executing and writes bound evidence', (t) => {
  const { root } = fixture(t);
  const result = run(root, ['--authorize-provider', path.join(root, 'provider.mjs')]);
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  const { report, reportPath, context } = result.envelope.data;
  assert.equal(report.status, 'pass');
  assert.equal(report.mode, 'static');
  assert.equal(report.checks.length, 1);
  assert.ok(report.checks[0].evidence.plan);
  assert.equal(
    report.identity.provider.sourceFingerprint,
    context.project.provider.identity.sourceFingerprint,
  );
  assert.equal(report.identity.implementation.length, 4);
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), report);
});

test('public doctor fails for a missing declared handler', (t) => {
  const { root } = fixture(t, true);
  const result = run(root, [
    '--authorize-provider',
    path.join(root, 'provider.mjs'),
    '--recipe',
    'smoke',
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.envelope.data.report.status, 'fail');
  assert.match(result.envelope.data.report.checks[0].message, /no registered adapter/);
});

test('public doctor does not hide an invalid catalog recipe', (t) => {
  const { root, write } = fixture(t);
  write('recipes/headless/invalid.recipe.json', {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    workflow: {
      entry: 'bad',
      nodes: { bad: { action: 'missing.action', intent: 'Refuse missing declaration.' } },
    },
  });
  const result = run(root, ['--authorize-provider', path.join(root, 'provider.mjs')]);
  assert.equal(result.status, 1);
  assert.equal(result.envelope.status, 'error');
  assert.match(result.envelope.error.message, /invalid|missing|workflow/i);
});

test('public doctor retains recipe authorization after authorizing a provider', (t) => {
  const { root } = fixture(t);
  const result = run(root, [
    '--authorize-provider',
    path.join(root, 'provider.mjs'),
    '--source-trust',
    'untrusted',
    '--source-kind',
    'task',
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.envelope.data.report.status, 'fail');
  assert.match(result.envelope.data.report.checks[0].message, /[Uu]ntrusted|authoriz/);
});

test('public doctor records ordered library winners and shadowed sources', (t) => {
  const { root, write } = fixture(t);
  const smoke = fs.readFileSync(path.join(root, 'recipes/headless/smoke.recipe.json'), 'utf8');
  const actionManifest = fs.readFileSync(
    path.join(root, 'manifests/headless.action-manifest.json'),
    'utf8',
  );
  for (const name of ['earlier', 'later']) {
    write(`${name}/recipes/headless/smoke.recipe.json`, smoke);
    write(`${name}/manifests/headless.action-manifest.json`, actionManifest);
  }
  const result = run(root, [
    '--authorize-provider',
    path.join(root, 'provider.mjs'),
    '--library',
    `earlier=${path.join(root, 'earlier')}`,
    '--library',
    `later=${path.join(root, 'later')}`,
  ]);
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  const selected = result.envelope.data.report.resolution.recipes.find(
    (entry: { ref: string }) => entry.ref === 'smoke',
  );
  assert.equal(selected.source, 'earlier');
  assert.deepEqual(selected.shadows, ['later', 'example']);
  const action = result.envelope.data.report.resolution.actions.find(
    (entry: { action: string }) => entry.action === 'example.read',
  );
  assert.equal(action.source, 'earlier');
  assert.ok(action.shadows.includes('later'));
});

test('public doctor exposes ambiguous project candidates without importing a provider', (t) => {
  const { root, write } = fixture(t);
  const registry = path.join(root, 'registry');
  const provider = path.join(root, 'provider.mjs');
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  assert.equal(
    spawnSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://example.invalid/project.git'])
      .status,
    0,
  );
  fs.rmSync(path.join(root, 'project.json'));
  for (const name of ['one', 'two'])
    write(`registry/${name}/project.json`, {
      name,
      repo_url: 'https://example.invalid/project.git',
      paths: { runtime_dir: '.runtime', artifact_dir: 'artifacts' },
      recipe: { provider: { module: provider }, adapter: 'headless' },
    });
  const result = run(root, ['--projects-dir', registry]);
  assert.equal(result.status, 1);
  assert.equal(result.envelope.error.code, 'PROJECT_AMBIGUOUS');
  assert.deepEqual(result.envelope.error.details.candidates, ['one', 'two']);
  assert.equal(fs.existsSync(`${root}.imported`), false);
});

test('public doctor carries the configured manifest into complete preflight', (t) => {
  const { root, write } = fixture(t);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
  config.recipe.manifest = 'alternate.action-manifest.json';
  write('project.json', config);
  const alternate = JSON.parse(
    fs.readFileSync(path.join(root, 'manifests/headless.action-manifest.json'), 'utf8'),
  );
  alternate.actions['example.read'].schema.properties = { value: { type: 'string' } };
  write('alternate.action-manifest.json', alternate);
  const recipe = JSON.parse(
    fs.readFileSync(path.join(root, 'recipes/headless/smoke.recipe.json'), 'utf8'),
  );
  recipe.workflow.nodes.read.value = 'accepted by selected manifest';
  write('recipes/headless/smoke.recipe.json', recipe);
  const result = run(root, ['--authorize-provider', path.join(root, 'provider.mjs')]);
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  assert.equal(
    result.envelope.data.report.identity.selection.manifest,
    path.join(root, 'alternate.action-manifest.json'),
  );
});

test('monorepo report includes shared checkout sources beyond the selected app', (t) => {
  const { root, write } = fixture(t);
  const external = fixture(t);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
  config.apps = ['apps/ui'];
  config.recipe.provider.module = path.join(external.root, 'provider.mjs');
  write('project.json', config);
  write('apps/ui/package.json', {});
  write('packages/shared/value.txt', 'before');
  const result = run(root, [
    '--authorize-provider',
    config.recipe.provider.module,
    '--app',
    'apps/ui',
  ]);
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  const data = result.envelope.data;
  write('packages/shared/value.txt', 'after');
  const current = recipeConformanceIdentity({
    project: 'example',
    context: data.context,
    providerRoot: external.root,
    configurationPaths: [path.join(root, 'project.json')],
    librarySources: [{ name: 'example', root: external.root }],
    artifactsDir: path.dirname(data.reportPath),
    recipes: [],
  });
  assert.equal(data.report.identity.target, path.join(root, 'apps/ui'));
  assert.notEqual(
    current.checkout.sourceFingerprint,
    data.report.identity.checkout.sourceFingerprint,
  );
  assert.equal(current.provider.sourceFingerprint, data.report.identity.provider.sourceFingerprint);
});
