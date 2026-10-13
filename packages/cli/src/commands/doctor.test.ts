import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { Command } from 'commander';

import { fileFingerprint, recipeOutputRoots, sourceSnapshot } from '@farmslot/recipe-cli/harness';

import { environment, fixture, run, runProcess } from '../../test/helpers/project-doctor.js';
import { OutputContext } from '../output.js';

import { registerDoctorCommand } from './doctor.js';

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
  assert.equal(report.checks.filter((check: { required: boolean }) => check.required).length, 1);
  assert.deepEqual(
    report.checks.filter((check: { required: boolean }) => !check.required),
    [
      { id: 'capture.support', required: false, status: 'unsupported', message: 'headless' },
      { id: 'hud.support', required: false, status: 'unsupported', message: 'headless' },
    ],
  );
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

test('doctor binds an explicit domain and refuses a report for another domain', async (t) => {
  const { root } = fixture(t);
  const flags = ['--authorize-provider', path.join(root, 'provider.mjs')];
  const checked = await run(t, root, [...flags, '--domain', 'payments']);
  assert.equal(checked.status, 0, JSON.stringify(checked.envelope));
  assert.equal(checked.envelope.data.report.identity.domain, 'payments');
  const changed = await run(t, root, [
    ...flags,
    '--domain',
    'other',
    '--check-report',
    checked.envelope.data.reportPath,
  ]);
  assert.equal(changed.status, 1, 'A report cannot authorize a different domain.');
});

test('conformance reads opaque HUD policy in the selected runtime environment and restores it', async (t) => {
  const { root, write } = fixture(t);
  const provider = fs.readFileSync(path.join(root, 'provider.mjs'), 'utf8');
  write(
    'provider.mjs',
    provider.replace(
      'headless: true,',
      `headless: false,
    run: {
      envKeys: ['PROOF_OPAQUE'],
      activateEnv() { process.env.PROOF_OPAQUE = '1'; },
      autoHud() { return process.env.PROOF_OPAQUE !== '1'; },
    },`,
    ),
  );
  const previous = process.env.PROOF_OPAQUE;
  const result = await run(t, root, ['--authorize-provider', path.join(root, 'provider.mjs')]);
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  assert.deepEqual(
    result.envelope.data.report.checks.filter((check: { required: boolean }) => !check.required),
    [
      { id: 'capture.support', required: false, status: 'pass', message: 'supported' },
      { id: 'hud.support', required: false, status: 'unsupported', message: 'opaque' },
    ],
  );
  assert.equal(process.env.PROOF_OPAQUE, previous);
});

test('a named dispatch check preserves the retained live report', async (t) => {
  const { root, write } = fixture(t);
  const retained = '{"retained":"live proof"}\n';
  write('artifacts/conformance/conformance-report.json', retained);
  const result = await run(t, root, [
    '--authorize-provider',
    path.join(root, 'provider.mjs'),
    '--report-name',
    'dispatch-check.json',
  ]);
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  assert.equal(
    fs.readFileSync(path.join(root, 'artifacts/conformance/conformance-report.json'), 'utf8'),
    retained,
  );
  assert.equal(
    result.envelope.data.reportPath,
    path.join(root, 'artifacts/conformance/dispatch-check.json'),
  );
  assert.equal(JSON.parse(fs.readFileSync(result.envelope.data.reportPath, 'utf8')).status, 'pass');
});

test('report filename escapes refuse before provider import', async (t) => {
  const { root } = fixture(t);
  const result = await run(t, root, [
    '--authorize-provider',
    path.join(root, 'provider.mjs'),
    '--report-name',
    '../report.json',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.envelope.error.message, /filename without a directory/);
  assert.equal(fs.existsSync(`${root}.imported`), false);
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

test('live doctor refuses missing authority and missing proof declarations before effects', async (t) => {
  const { root } = fixture(t);
  const authorization = [
    '--authorize-provider',
    path.join(root, 'provider.mjs'),
    '--live',
    '--recipe',
    'smoke',
    '--smoke-target',
    'smoke',
    '--teardown-target',
    'cleanup',
  ];
  const noConsent = await run(t, root, authorization);
  assert.equal(noConsent.status, 1);
  assert.equal(fs.existsSync(`${root}.imported`), false);
  const noProof = await run(t, root, [...authorization, '--disposable']);
  assert.equal(noProof.status, 1);
  assert.equal(noProof.envelope.data.report.mode, 'live');
  assert.ok(
    noProof.envelope.data.report.checks.some(
      (entry: { status: string }) => entry.status === 'fail',
    ),
  );
});

test('ordinary project doctor probes readiness without preflighting every recipe', async (t) => {
  const { root, write } = fixture(t);
  const parameterized = JSON.parse(
    fs.readFileSync(path.join(root, 'recipes/headless/smoke.recipe.json'), 'utf8'),
  );
  parameterized.paramsSchema = {
    type: 'object',
    properties: { subject: { type: 'string' } },
    required: ['subject'],
  };
  write('recipes/headless/parameterized.recipe.json', parameterized);
  const result = await run(t, root, [], {}, [
    '--json',
    'doctor',
    root,
    '--authorize-provider',
    path.join(root, 'provider.mjs'),
  ]);
  assert.equal(result.status, 0, JSON.stringify(result.envelope));
  assert.equal(result.envelope.ready, true);
  assert.equal(result.envelope.adapter, 'headless');
  assert.deepEqual(result.envelope.provider, {
    ...result.envelope.context.project.provider,
    version: null,
  });
  assert.equal(result.envelope.requiredChecks.status, 'pass');
  assert.equal(
    fs.existsSync(path.join(root, 'artifacts/conformance/conformance-report.json')),
    false,
  );
});

test('project doctor shows resolved provider package version and Git identity', async (t) => {
  const { root, write } = fixture(t);
  write('package.json', {
    name: 'example-provider',
    version: '1.2.3',
    type: 'module',
    exports: { './provider': './provider.mjs' },
  });
  const config = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
  config.recipe.provider = { package: 'example-provider', module: 'example-provider/provider' };
  write('project.json', config);
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  assert.equal(
    spawnSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ]).status,
    0,
  );
  const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  const flags = ['--authorize-provider', path.join(root, 'provider.mjs')];
  const previousEnv = process.env;
  const previousExitCode = process.exitCode;
  const previousTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const output: string[] = [];
  t.mock.method(OutputContext.prototype, 'write', (text: string) => output.push(text));
  t.mock.method(console, 'log', (...values: unknown[]) => output.push(values.join(' ')));
  process.env = environment(root, {});
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    process.exitCode = 0;
    const program = new Command().name('farmslot').option('--json');
    registerDoctorCommand(program);
    await program.parseAsync(['doctor', root, ...flags], { from: 'user' });
    assert.equal(process.exitCode, 0, output.join('\n'));
    assert.ok(
      output.join('\n').includes(`Provider: example-provider version=1.2.3 git=${head}`),
      output.join('\n'),
    );
  } finally {
    process.env = previousEnv;
    process.exitCode = previousExitCode;
    if (previousTty) Object.defineProperty(process.stdout, 'isTTY', previousTty);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  }
});

test('readiness and conformance mutation modes cannot be mixed before provider import', async (t) => {
  const { root } = fixture(t);
  const result = await run(t, root, [
    '--fix',
    '--authorize-provider',
    path.join(root, 'provider.mjs'),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.envelope.error.message, /cannot be combined/u);
  assert.equal(fs.existsSync(`${root}.imported`), false);
});

test('default checks bind declared parameters and explicit selection replaces them', async (t) => {
  const { root, write } = fixture(t);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
  config.recipe.checks = [{ recipe: 'smoke', params: { mode: 'declared' } }];
  write('project.json', config);
  const recipePath = 'recipes/headless/smoke.recipe.json';
  const recipe = JSON.parse(fs.readFileSync(path.join(root, recipePath), 'utf8'));
  recipe.paramsSchema = {
    type: 'object',
    required: ['mode'],
    properties: { mode: { type: 'string' } },
    additionalProperties: false,
  };
  write(recipePath, recipe);
  const flags = ['--authorize-provider', path.join(root, 'provider.mjs')];
  const defaults = await run(t, root, flags);
  assert.equal(defaults.status, 0, JSON.stringify(defaults.envelope));
  assert.equal(defaults.envelope.data.context.project.checks[0].params.mode, 'declared');
  const selected = await run(t, root, [...flags, '--recipe', 'smoke', '--param', 'mode=explicit']);
  assert.equal(selected.status, 0, JSON.stringify(selected.envelope));
  assert.notEqual(
    defaults.envelope.data.report.identity.invocations[0].paramsDigest,
    selected.envelope.data.report.identity.invocations[0].paramsDigest,
  );
  const missing = await run(t, root, [...flags, '--recipe', 'smoke']);
  assert.equal(missing.status, 1);
});

test('missing defaults teach declaration or explicit selection', async (t) => {
  const { root, write } = fixture(t);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
  delete config.recipe.checks;
  write('project.json', config);
  const result = await run(t, root, ['--authorize-provider', path.join(root, 'provider.mjs')]);
  assert.equal(result.status, 1);
  assert.match(result.envelope.error.message, /recipe.checks.*--recipe/);
});

test('invalid default metadata refuses before provider import even with explicit selection', async (t) => {
  const { root, write } = fixture(t);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
  config.recipe.checks = [];
  write('project.json', config);
  const result = await run(t, root, [
    '--authorize-provider',
    path.join(root, 'provider.mjs'),
    '--recipe',
    'smoke',
  ]);
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(`${root}.imported`), false);
});

test('default smoke still refuses a missing handler for an unused declared action', async (t) => {
  const { root, write } = fixture(t);
  const file = 'manifests/headless.action-manifest.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  manifest.actions['example.unused'] = {
    ...manifest.actions['example.read'],
    examples: [{ action: 'example.unused', intent: 'Inspect unused capability.', next: 'done' }],
  };
  write(file, manifest);
  const result = await run(t, root, ['--authorize-provider', path.join(root, 'provider.mjs')]);
  assert.equal(result.status, 1);
  assert.match(
    result.envelope.data.report.checks[0].message,
    /example.unused.*no registered adapter/,
  );
});

test('default library refs cannot be shadowed by a same-name working-directory file', async (t) => {
  const { root, write } = fixture(t);
  write('smoke', 'not a recipe');
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const result = await run(t, root, ['--authorize-provider', path.join(root, 'provider.mjs')]);
    assert.equal(result.status, 0, JSON.stringify(result.envelope));
    assert.equal(result.envelope.data.report.identity.invocations[0].recipe, 'smoke');
  } finally {
    process.chdir(cwd);
  }
});
