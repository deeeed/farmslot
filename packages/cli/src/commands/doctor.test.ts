import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { fileFingerprint, recipeOutputRoots, sourceSnapshot } from '@farmslot/recipe-cli/harness';

import { OutputContext } from '../output.js';

import { registerDoctorCommand } from './doctor.js';

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

function environment(root: string, overrides: Record<string, string>) {
  const env = { ...process.env };
  for (const name of [
    'FARMSLOT_ROOT',
    'FARMSLOT_POOL_DIR',
    'FARMSLOT_WORKSPACE',
    'RECIPE_RUNTIME_CONTEXT',
    'RECIPE_RUNTIME_DIR',
    'RECIPE_LIBRARY_PATH',
  ])
    delete env[name];
  return {
    ...env,
    FARMSLOT_HOME: path.join(root, 'operator-home'),
    ...overrides,
    TSX_TSCONFIG_PATH: cliConfig,
  };
}

function runProcess(root: string, flags: string[], overrides: Record<string, string> = {}) {
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
      env: environment(root, overrides),
      cwd: path.dirname(cliConfig),
      encoding: 'utf8',
      timeout: 4900,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Doctor child timed out or was interrupted: ${result.signal}`);
  return { status: result.status, envelope: JSON.parse(result.stdout) };
}

/** Exercise the public command parser/handler; one subprocess smoke retains process-level coverage. */
async function run(
  t: TestContext,
  root: string,
  flags: string[],
  overrides: Record<string, string> = {},
  argv?: string[],
) {
  const previousEnv = process.env;
  const previousExitCode = process.exitCode;
  let output = '';
  const render = t.mock.method(OutputContext.prototype, 'writeJson', (data: unknown) => {
    output = JSON.stringify(data);
  });
  process.env = environment(root, overrides);
  process.exitCode = 0;
  try {
    const program = new Command().name('farmslot').option('--json');
    registerDoctorCommand(program);
    await program.parseAsync(argv ?? ['--json', 'doctor', root, '--conformance', ...flags], {
      from: 'user',
    });
    return { status: Number(process.exitCode ?? 0), envelope: JSON.parse(output) };
  } finally {
    render.mock.restore();
    process.env = previousEnv;
    process.exitCode = previousExitCode;
  }
}

test('public doctor refuses discovered code before import', async (t) => {
  const { root } = fixture(t);
  const result = runProcess(root, []);
  assert.equal(result.status, 1);
  assert.equal(result.envelope.error.code, 'PROVIDER_UNAUTHORIZED');
  assert.equal(fs.existsSync(`${root}.imported`), false);
});

test('conformance options without the switch refuse instead of running installation checks', async (t) => {
  const { root } = fixture(t);
  const result = await run(t, root, [], {}, [
    '--json',
    'doctor',
    '--project',
    'example',
    '--recipe',
    'smoke',
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.envelope.error.code, 'CONFORMANCE_REQUIRED');
  assert.equal(fs.existsSync(`${root}.imported`), false);
});

test('public doctor preflights a headless catalog without executing and writes bound evidence', async (t) => {
  const { root } = fixture(t);
  const result = await run(t, root, ['--authorize-provider', path.join(root, 'provider.mjs')]);
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
  for (const name of [
    '@farmslot/recipe-cli',
    '@farmslot/recipe-runner',
    '@farmslot/adapter-sdk',
    '@farmslot/agent-runtime',
    '@farmslot/protocol',
  ]) {
    assert.ok(
      report.identity.implementation.some((entry: { name: string }) => entry.name === name),
    );
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), report);
});

test('public doctor fails for a missing declared handler', async (t) => {
  const { root } = fixture(t, true);
  const result = await run(t, root, [
    '--authorize-provider',
    path.join(root, 'provider.mjs'),
    '--recipe',
    'smoke',
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.envelope.data.report.status, 'fail');
  assert.match(result.envelope.data.report.checks[0].message, /no registered adapter/);
});

test('public doctor does not hide an invalid catalog recipe', async (t) => {
  const { root, write } = fixture(t);
  write('recipes/headless/invalid.recipe.json', {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    workflow: {
      entry: 'bad',
      nodes: { bad: { action: 'missing.action', intent: 'Refuse missing declaration.' } },
    },
  });
  const result = await run(t, root, ['--authorize-provider', path.join(root, 'provider.mjs')]);
  assert.equal(result.status, 1);
  assert.equal(result.envelope.status, 'error');
  assert.match(result.envelope.error.message, /invalid|missing|workflow/i);
});

test('public doctor retains recipe authorization after authorizing a provider', async (t) => {
  const { root } = fixture(t);
  const result = await run(t, root, [
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

test('public doctor records ordered library winners and shadowed sources', async (t) => {
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
  const result = await run(t, root, [
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

test('public doctor exposes ambiguous project candidates without importing a provider', async (t) => {
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
  const result = await run(t, root, ['--projects-dir', registry]);
  assert.equal(result.status, 1);
  assert.equal(result.envelope.error.code, 'PROJECT_AMBIGUOUS');
  assert.deepEqual(result.envelope.error.details.candidates, ['one', 'two']);
  assert.equal(fs.existsSync(`${root}.imported`), false);
});

test('public doctor carries the configured manifest into complete preflight', async (t) => {
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
  const result = await run(t, root, ['--authorize-provider', path.join(root, 'provider.mjs')]);
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  assert.equal(
    result.envelope.data.report.identity.selection.manifest,
    path.join(root, 'alternate.action-manifest.json'),
  );
});

test('monorepo report includes shared checkout sources beyond the selected app', async (t) => {
  const { root, write } = fixture(t);
  const external = fixture(t);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
  config.apps = ['apps/ui'];
  config.recipe.provider.module = path.join(external.root, 'provider.mjs');
  write('project.json', config);
  write('apps/ui/package.json', {});
  const appRuntime = 'apps/ui/temp/recipe/runtime/agentic-runtime.json';
  write(appRuntime, {
    repoRoot: path.join(root, 'apps/ui'),
    project: 'example',
    slotId: 'app-runtime',
    watcherPort: 7331,
  });
  write('packages/shared/value.txt', 'before');
  const result = await run(t, root, [
    '--authorize-provider',
    config.recipe.provider.module,
    '--app',
    'apps/ui',
  ]);
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  const data = result.envelope.data;
  assert.equal(data.context.runtimeConfigPath, path.join(root, appRuntime));
  assert.equal(data.report.identity.selection.slot, 'app-runtime');
  assert.ok(
    data.report.identity.configuration.some(
      (source: { path: string }) => source.path === path.join(root, appRuntime),
    ),
  );
  write('packages/shared/value.txt', 'after');
  const current = sourceSnapshot(
    root,
    undefined,
    recipeOutputRoots(data.context.target.value, data.context.project),
  );
  assert.equal(data.report.identity.target, path.join(root, 'apps/ui'));
  assert.equal(data.reportPath, path.join(root, 'artifacts/conformance/conformance-report.json'));
  assert.notEqual(current.sourceFingerprint, data.report.identity.checkout.sourceFingerprint);
});

test('public doctor binds the actual runtime configuration selected through the environment', async (t) => {
  const { root, write } = fixture(t);
  const runtimeDir = 'scratch-runtime';
  const runtimePath = path.join(root, runtimeDir, 'agentic-runtime.json');
  write(`${runtimeDir}/agentic-runtime.json`, {
    repoRoot: root,
    slotId: 'scratch-1',
    watcherPort: 8081,
  });
  write('.gitignore', 'scratch-runtime/\n');
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  assert.equal(spawnSync('git', ['-C', root, 'add', '.']).status, 0);
  assert.equal(
    spawnSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'baseline',
    ]).status,
    0,
  );
  const result = await run(t, root, ['--authorize-provider', path.join(root, 'provider.mjs')], {
    RECIPE_RUNTIME_DIR: runtimeDir,
  });
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  const { context, report } = result.envelope.data;
  assert.equal(context.runtimeConfigPath, runtimePath);
  assert.ok(
    report.identity.configuration.some((entry: { path: string }) => entry.path === runtimePath),
  );
  const excluded = recipeOutputRoots(root, context.project);
  const before = sourceSnapshot(root, undefined, excluded);
  write(`${runtimeDir}/agentic-runtime.json`, {
    repoRoot: root,
    slotId: 'scratch-1',
    watcherPort: 8082,
  });
  assert.equal(
    sourceSnapshot(root, undefined, excluded).sourceFingerprint,
    before.sourceFingerprint,
  );
  const configuration = report.identity.configuration.find(
    (entry: { path: string }) => entry.path === runtimePath,
  );
  assert.notEqual(fileFingerprint(runtimePath), configuration.sourceFingerprint);
});

function workspaceFixture(t: TestContext) {
  const { root, write } = fixture(t);
  const external = fixture(t);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
  config.recipe.provider = { module: 'provider.mjs', root: { env: 'EXAMPLE_PROVIDER_ROOT' } };
  write('workspace/farmslot/projects/example/project.json', config);
  write('workspace/farmslot/pool/local.json', {
    host: 'localhost',
    project: 'example',
    env: { EXAMPLE_PROVIDER_ROOT: external.root },
    slots: [{ id: 'selected', repo: root }],
  });
  fs.rmSync(path.join(root, 'project.json'));
  return { root, write, external, workspace: path.join(root, 'workspace') };
}

test('public doctor uses the installed workspace pool', async (t) => {
  const { root, external, workspace } = workspaceFixture(t);
  const result = await run(t, root, ['--project', 'example', '--slot', 'selected'], {
    FARMSLOT_WORKSPACE: workspace,
  });
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  assert.equal(result.envelope.data.context.slot.value, 'selected');
  assert.equal(result.envelope.data.context.project.provider.root, external.root);
});

test('scratch runtime keeps its pool configuration and pool selection in the report', async (t) => {
  const { root, write, external, workspace } = workspaceFixture(t);
  write('scratch/agentic-runtime.json', {
    repoRoot: root,
    slotId: 'scratch-slot',
    watcherPort: 8123,
  });
  const result = await run(
    t,
    root,
    ['--project', 'example', '--slot', 'selected', '--runtime-dir', 'scratch'],
    { FARMSLOT_WORKSPACE: workspace },
  );
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  const { context, report } = result.envelope.data;
  assert.equal(context.slot.value, 'scratch-slot');
  assert.equal(context.slot.poolSlot, 'selected');
  assert.equal(context.project.provider.root, external.root);
  assert.equal(report.identity.selection.poolSlot, 'selected');
  assert.ok(
    report.identity.configuration.some(
      (source: { path: string }) => source.path === context.slot.poolFile,
    ),
  );
});

test('public doctor refuses parameter broadcast before importing a provider', async (t) => {
  const { root } = fixture(t);
  const result = await run(t, root, ['--param', 'count=2']);
  assert.match(result.envelope.error.message, /--param requires --recipe/u);
  assert.equal(fs.existsSync(`${root}.imported`), false);
});

test('public doctor binds provider dependencies exposing only SDK subpaths', async (t) => {
  const { root, write } = fixture(t);
  const sdk = path.join(root, 'node_modules/@farmslot/example-sdk');
  write('package.json', {
    name: 'example-provider',
    dependencies: { '@farmslot/example-sdk': '1.0.0' },
  });
  write('node_modules/@farmslot/example-sdk/package.json', {
    name: '@farmslot/example-sdk',
    version: '1.0.0',
    exports: { './package.json': './package.json', './action': './action.cjs' },
  });
  write('node_modules/@farmslot/example-sdk/action.cjs', 'exports.policy = "original";');
  const result = await run(t, root, ['--authorize-provider', path.join(root, 'provider.mjs')]);
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  const source = result.envelope.data.report.identity.implementation.find(
    (entry: { name: string }) => entry.name === 'provider:@farmslot/example-sdk',
  );
  assert.ok(source);
  assert.equal(source.sourceFingerprint, sourceSnapshot(sdk).sourceFingerprint);
  write('node_modules/@farmslot/example-sdk/action.cjs', 'exports.policy = "changed";');
  assert.notEqual(source.sourceFingerprint, sourceSnapshot(sdk).sourceFingerprint);
});

test('explicit pool selection overrides the installed workspace pool', async (t) => {
  const { root, write, external, workspace } = workspaceFixture(t);
  const pool = {
    host: 'localhost',
    project: 'example',
    env: { EXAMPLE_PROVIDER_ROOT: external.root },
    slots: [{ id: 'selected', repo: root }],
  };
  write('workspace/farmslot/pool/local.json', {
    ...pool,
    env: { EXAMPLE_PROVIDER_ROOT: path.join(root, 'missing') },
  });
  write('override/local.json', pool);
  const result = await run(t, root, ['--project', 'example', '--slot', 'selected'], {
    FARMSLOT_WORKSPACE: workspace,
    FARMSLOT_POOL_DIR: path.join(root, 'override'),
  });
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  assert.equal(result.envelope.data.context.slot.poolFile, path.join(root, 'override/local.json'));
  assert.equal(result.envelope.data.context.project.provider.root, external.root);
});

test('public doctor applies scratch runtime targeting before provider preflight', async (t) => {
  const { root, write } = fixture(t);
  write('scratch-runtime/agentic-runtime.json', {
    repoRoot: root,
    slotId: 'scratch',
    watcherPort: 8081,
    cdpPort: 9181,
  });
  const provider = fs
    .readFileSync(path.join(root, 'provider.mjs'), 'utf8')
    .replace(
      'export function createProvider() {',
      `export function createProvider() {
      if (process.env.RECIPE_RUNTIME_DIR !== 'scratch-runtime') throw new Error('factory used default runtime');`,
    )
    .replace(
      'adapters: async () => ',
      `adapters: async () => {
      if (process.env.RECIPE_WATCHER_PORT !== '8081' || process.env.RECIPE_CDP_PORT !== '9181')
        throw new Error('preflight used default targeting');
      return `,
    )
    .replace("'doctor executed an action');}}]", "'doctor executed an action');}}]; }");
  write('provider.mjs', provider);
  const result = await run(t, root, [
    '--authorize-provider',
    path.join(root, 'provider.mjs'),
    '--runtime-dir',
    'scratch-runtime',
  ]);
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  assert.equal(
    result.envelope.data.context.runtimeConfigPath,
    path.join(root, 'scratch-runtime/agentic-runtime.json'),
  );
  assert.equal(result.envelope.data.report.identity.selection.ports.cdp, 9181);
});
