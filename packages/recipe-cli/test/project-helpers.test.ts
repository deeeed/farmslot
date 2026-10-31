import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { retainTaskExecution } from '../../agent-runtime/src/task-init/execution-provenance.js';
import { quoteTaskPath } from '../../agent-runtime/src/task-init/runtime-command.js';
import { buildMarkShim } from '../../agent-runtime/src/task-init/write.js';
import { handleChecklist } from '../src/harness/commands/checklist.js';
import { handleRecipeQuality } from '../src/harness/commands/recipe-quality.js';
import { handleReview } from '../src/harness/commands/review.js';
import { harnessHost } from '../src/harness/host.js';
import {
  projectTaskExecution,
  repinSelectedTask,
  verifySelectedTask,
  withTaskProjectHost,
} from '../src/harness/project-helpers.js';
import {
  type ProjectRecipeHostOptions,
  withProjectRecipeHost,
} from '../src/harness/project-host.js';

function captureStdout(t: TestContext) {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (...args: Parameters<typeof process.stdout.write>) => {
    if (typeof args[0] === 'string') chunks.push(args[0]);
    return write(...args);
  });
  return () => {
    const output = chunks.find((chunk) => chunk.startsWith('{\n  "command": "review",\n'));
    assert.ok(output, 'review must emit its JSON envelope');
    return output;
  };
}

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-provider-')));
  const previousFarmHome = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = path.join(root, 'pins');
  t.after(() => {
    if (previousFarmHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousFarmHome;
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pack = path.join(root, 'pack');
  const checkout = path.join(root, 'checkout');
  const installed = path.join(root, 'installed');
  const taskDir = path.join(checkout, 'task');
  for (const directory of [pack, checkout, installed, taskDir])
    fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(installed, 'package.json'),
    '{"name":"@farmslot/cli","version":"1.0.0"}',
  );
  fs.writeFileSync(path.join(installed, 'farmslot'), '#!/usr/bin/env node\n');
  fs.writeFileSync(
    path.join(pack, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      files: ['provider.mjs', 'project.json', 'actions.json'],
    }),
  );
  fs.writeFileSync(
    path.join(pack, 'provider.mjs'),
    `
    import fs from 'node:fs';
    import path from 'node:path';
    export function createProvider() {
      return {
        runtime: { id: 'headless', sdkVersion: 1, headless: true,
          runtimeStatus: async () => ({decision:'ready', reasons:[]}), resolveSlotPorts() {},
          logSources: () => [], appLogSource: () => null, devServer: {}, hints: {}, runtimeContext: {},
          harness: { verify: async () => ({ok:true}) },
          launch: async () => { throw new Error('unexpected launch'); },
          actions: {manifestPath: () => '', semantic: [], cdpTarget: {transport:'none'}},
        },
        commandOptions: {task: {stepGates: [{label:/Required validation/, ready: (task) => fs.existsSync(path.join(task, 'allowed'))}]}},
      };
    }
  `,
  );
  const config = {
    name: 'example',
    repoUrl: '',
    paths: { runtimeDir: 'runtime', artifactDir: 'artifacts' },
    recipe: { adapter: 'headless', provider: { module: 'provider.mjs' } },
  };
  fs.writeFileSync(path.join(pack, 'project.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(taskDir, 'CHECKLIST.md'), '# Checklist\n- [ ] Required validation\n');
  const options: ProjectRecipeHostOptions = {
    cwd: checkout,
    tokens: ['--project', 'example'],
    projects: [{ root: pack, config }],
    command: 'task',
  };
  return { root, pack, checkout, installed, taskDir, options };
}

test('a task recorded with harness 0.94.1 resumes on pool 0.94.6 with a warning', async (t) => {
  const f = fixture(t);
  const providerSource = fs.readFileSync(path.join(f.pack, 'provider.mjs'), 'utf8');
  const providers = ['0.94.1', '0.94.6'].map((version) => {
    const root = path.join(f.root, version);
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture-harness',
        version,
        type: 'module',
        exports: { './provider': './provider.mjs' },
        files: ['provider.mjs'],
      }),
    );
    fs.writeFileSync(
      path.join(root, 'provider.mjs'),
      providerSource.replace('reasons:[]', `reasons:['${version}']`),
    );
    return root;
  });
  const pool = path.join(f.root, 'pool');
  fs.mkdirSync(pool);
  const writePool = (provider: string) =>
    fs.writeFileSync(
      path.join(pool, 'local.json'),
      JSON.stringify({
        host: 'localhost',
        project: 'example',
        env: { FIXTURE_HARNESS_ROOT: provider },
        slots: [{ id: 'one', repo: f.checkout }],
      }),
    );
  const config = {
    ...f.options.projects![0]!.config,
    recipe: {
      adapter: 'headless',
      provider: {
        module: 'fixture-harness/provider',
        package: 'fixture-harness',
        root: { env: 'FIXTURE_HARNESS_ROOT' },
      },
    },
  };
  fs.writeFileSync(path.join(f.pack, 'project.json'), JSON.stringify(config));
  const options: ProjectRecipeHostOptions = {
    ...f.options,
    projects: [{ root: f.pack, config }],
    slotPoolDir: pool,
    load: { env: { FIXTURE_HARNESS_ROOT: providers[0]! } },
  };
  writePool(providers[0]!);
  await withProjectRecipeHost(options, async (host) => {
    assert.equal(host.context.project?.provider.version, '0.94.1');
    retainTaskExecution(
      f.taskDir,
      await projectTaskExecution(host, {
        executable: path.join(f.installed, 'farmslot'),
        packageRoot: f.installed,
        distributionRoot: f.installed,
      }),
    );
  });
  const originalReceipt = fs.readFileSync(
    path.join(f.taskDir, 'artifacts/harness-provenance.json'),
  );
  writePool(providers[1]!);
  const warning = t.mock.method(console, 'warn', () => {});
  await withTaskProjectHost(options, f.taskDir, async (host) => {
    assert.equal(host.context.project?.provider.version, '0.94.6');
    assert.deepEqual((await host.provider.runtime.runtimeStatus(f.checkout)).reasons, ['0.94.6']);
  });
  assert.match(
    String(warning.mock.calls[0]?.arguments[0]),
    /recorded harness 0\.94\.1; using pool-selected 0\.94\.6/,
  );
  const actual = JSON.parse(
    fs.readFileSync(path.join(f.taskDir, 'artifacts/provider-execution.json'), 'utf8'),
  );
  assert.equal(actual.provider.version, '0.94.6');
  assert.equal(actual.provider.root, providers[1]);
  assert.ok(actual.provider.identity.sourceFingerprint);
  assert.deepEqual(
    fs.readFileSync(path.join(f.taskDir, 'artifacts/harness-provenance.json')),
    originalReceipt,
  );
});

test('retained provider gates survive a provider update and ordinary source edits', async (t) => {
  const f = fixture(t);
  await withProjectRecipeHost(f.options, async (host) => {
    const execution = await projectTaskExecution(host, {
      executable: path.join(f.installed, 'farmslot'),
      packageRoot: f.installed,
      distributionRoot: f.installed,
    });
    retainTaskExecution(f.taskDir, execution);
  });
  fs.writeFileSync(path.join(f.checkout, 'product.ts'), 'ordinary product edit');
  fs.writeFileSync(
    path.join(f.pack, 'provider.mjs'),
    'export function createProvider() { throw new Error("new provider must not be loaded"); }',
  );
  const updatedDefaults = {
    ...f.options,
    projects: f.options.projects?.map((entry) => ({
      ...entry,
      config: {
        ...entry.config,
        recipe: {
          ...entry.config.recipe!,
          libraries: [
            {
              name: 'future-library',
              owner: 'example',
              source: path.join(f.root, 'not-installed-yet'),
            },
          ],
        },
      },
    })),
  };
  const before = fs.readFileSync(path.join(f.taskDir, 'CHECKLIST.md'), 'utf8');
  const refused = await withTaskProjectHost(updatedDefaults, f.taskDir, async ({ provider }) =>
    handleChecklist(['mark', f.taskDir, '1'], provider.commandOptions?.task),
  );
  assert.notEqual(refused, 0);
  assert.equal(fs.readFileSync(path.join(f.taskDir, 'CHECKLIST.md'), 'utf8'), before);
  fs.writeFileSync(path.join(f.taskDir, 'allowed'), 'yes');
  const passed = await withTaskProjectHost(updatedDefaults, f.taskDir, async ({ provider }) =>
    handleChecklist(['mark', f.taskDir, '1'], provider.commandOptions?.task),
  );
  assert.equal(passed, 0);
  assert.match(
    fs.readFileSync(path.join(f.taskDir, 'CHECKLIST.md'), 'utf8'),
    /\[x\] Required validation/,
  );
  assert.equal(verifySelectedTask(f.taskDir).bindingIdentity?.project, 'example');
  await withTaskProjectHost(
    {
      ...f.options,
      tokens: ['--device', 'owned-device', '--watcher-port', '3333'],
      options: { device: 'owned-device', watcherPort: '3333' },
    },
    f.taskDir,
    async (host) => {
      assert.equal(host.cli.device, 'owned-device');
      assert.equal(host.context.ports?.watcher?.value, 3333);
      assert.equal(host.context.ports?.watcher?.source, 'flag');
    },
  );
  await assert.rejects(
    withTaskProjectHost(
      { ...f.options, tokens: ['--library', 'foreign=/unused'] },
      f.taskDir,
      async () => assert.fail('must not invoke'),
    ),
    { code: 'TASK_BINDING_CHANGED' },
  );

  const previousTask = process.env.RECIPE_TASK_DIR;
  process.env.RECIPE_TASK_DIR = f.taskDir;
  t.after(() => {
    if (previousTask === undefined) delete process.env.RECIPE_TASK_DIR;
    else process.env.RECIPE_TASK_DIR = previousTask;
  });
  await withProjectRecipeHost({ ...updatedDefaults, command: 'doctor' }, async ({ provider }) => {
    assert.equal(provider.commandOptions?.task?.stepGates.length, 1);
  });
});

test('retained installed providers keep hoisted dependencies after installation removal', async (t) => {
  for (const packageName of ['@fixture/provider', 'fixture-provider']) {
    await t.test(packageName, async (t) => {
      const f = fixture(t);
      const installation = path.join(f.root, 'provider-installation');
      const providerRoot = path.join(installation, 'node_modules', packageName);
      const dependencyRoot = path.join(installation, 'node_modules/provider-dependency');
      fs.mkdirSync(providerRoot, { recursive: true });
      fs.mkdirSync(dependencyRoot, { recursive: true });
      fs.writeFileSync(
        path.join(installation, 'package.json'),
        JSON.stringify({ private: true, dependencies: { [packageName]: '1.0.0' } }),
      );
      fs.writeFileSync(path.join(installation, 'private-note.txt'), 'Unrelated product input.');
      fs.writeFileSync(
        path.join(providerRoot, 'package.json'),
        JSON.stringify({
          name: packageName,
          version: '1.0.0',
          type: 'module',
          exports: './provider.mjs',
          dependencies: { 'provider-dependency': '1.0.0' },
        }),
      );
      fs.writeFileSync(
        path.join(dependencyRoot, 'package.json'),
        JSON.stringify({
          name: 'provider-dependency',
          version: '1.0.0',
          type: 'module',
          exports: './index.mjs',
        }),
      );
      fs.writeFileSync(
        path.join(dependencyRoot, 'index.mjs'),
        "import fs from 'node:fs'; import path from 'node:path'; export const ready = task => fs.existsSync(path.join(task, 'allowed'));",
      );
      fs.writeFileSync(
        path.join(providerRoot, 'provider.mjs'),
        "import {ready} from 'provider-dependency';\n" +
          fs
            .readFileSync(path.join(f.pack, 'provider.mjs'), 'utf8')
            .replace("ready: (task) => fs.existsSync(path.join(task, 'allowed'))", 'ready'),
      );
      const entry = f.options.projects?.[0];
      assert.ok(entry?.config.recipe);
      const config = {
        ...entry.config,
        recipe: {
          ...entry.config.recipe,
          provider: {
            package: packageName,
            module: packageName,
            root: { projectPath: path.relative(f.checkout, providerRoot) },
          },
        },
      };
      fs.writeFileSync(path.join(f.pack, 'project.json'), JSON.stringify(config));
      const options = { ...f.options, projects: [{ root: f.pack, config }] };
      await withProjectRecipeHost(options, async (host) => {
        const execution = await projectTaskExecution(host, {
          executable: path.join(f.installed, 'farmslot'),
          packageRoot: f.installed,
          distributionRoot: f.installed,
        });
        const receipt = retainTaskExecution(f.taskDir, execution);
        const dependencies = receipt.retainedInputs.find(
          (entry) => entry.source === dependencyRoot,
        );
        assert.ok(dependencies);
        assert.equal(
          receipt.retainedInputs.some(
            (entry) =>
              entry.source === installation ||
              entry.source === path.join(installation, 'node_modules'),
          ),
          false,
        );
        assert.equal(fs.existsSync(path.join(dependencies.path, 'private-note.txt')), false);
      });
      fs.rmSync(installation, { recursive: true });
      let loaded = false;
      const refused = await withTaskProjectHost(options, f.taskDir, async ({ provider }) => {
        loaded = true;
        return handleChecklist(['mark', f.taskDir, '1'], provider.commandOptions?.task);
      });
      assert.equal(loaded, true);
      assert.notEqual(refused, 0);
      assert.doesNotMatch(fs.readFileSync(path.join(f.taskDir, 'CHECKLIST.md'), 'utf8'), /\[x\]/);
      fs.writeFileSync(path.join(f.taskDir, 'allowed'), 'yes');
      assert.equal(
        await withTaskProjectHost(options, f.taskDir, async ({ provider }) =>
          handleChecklist(['mark', f.taskDir, '1'], provider.commandOptions?.task),
        ),
        0,
      );
    });
  }
});

test('an unconfigured discovered provider refuses before pin creation', async (t) => {
  const f = fixture(t);
  const config = f.options.projects?.[0]?.config;
  assert.ok(config);
  fs.writeFileSync(
    path.join(f.checkout, 'project.json'),
    JSON.stringify({
      ...config,
      recipe: {
        ...config.recipe,
        provider: { module: 'provider.mjs', root: { projectPath: f.pack } },
      },
    }),
  );
  await assert.rejects(
    withProjectRecipeHost({ ...f.options, projects: [], tokens: [] }, async () =>
      assert.fail('must not import'),
    ),
    { code: 'SOURCE_UNAUTHORIZED' },
  );
  assert.equal(fs.existsSync(path.join(f.taskDir, 'artifacts/harness-provenance.json')), false);
});

test('review retains incremental scope and project rules in its authored output', async (t) => {
  const f = fixture(t);
  const file = path.join(f.taskDir, 'review.md');
  await withProjectRecipeHost(f.options, async () =>
    handleReview(['checklist', '--base', 'main', '--since', 'approved', '--out', file], {
      runtimeIds: ['headless'],
      baseRules: 'Trace the changed behavior.',
      parityRuntimeIds: { headless: 'browser' },
    }),
  );
  const checklist = fs.readFileSync(file, 'utf8');
  assert.match(checklist, /approved\.\.HEAD/);
  assert.match(checklist, /Trace the changed behavior/);
  assert.match(checklist, /Parity with browser: not checked/);
  const refused = path.join(f.taskDir, 'invalid-review.md');
  await assert.rejects(
    withProjectRecipeHost(f.options, async () =>
      handleReview(['checklist', '--out', refused], { runtimeIds: ['browser'] }),
    ),
    /Review runtime must be one of/,
  );
  assert.equal(fs.existsSync(refused), false);
});

test('review preserves project parity references, rules and incremental scope', async (t) => {
  const f = fixture(t);
  const reference = { adapter: 'browser', root: path.join(f.root, 'reference'), source: 'config' };
  const output = captureStdout(t);
  await withProjectRecipeHost(f.options, async () =>
    handleReview(['checklist', '--base', 'main', '--since', 'approved', '--json'], {
      runtimeIds: ['headless'],
      parityRuntimeIds: { headless: 'browser' },
      parity: (input) => {
        assert.deepEqual(input, { runtime: 'headless', target: f.checkout, hasParityGuide: false });
        return {
          reference,
          steps: [
            'Compare with the configured reference; never change the reference to match.',
            'Confirm both consumers still compile.',
          ],
        };
      },
    }),
  );
  const report = JSON.parse(output());
  assert.deepEqual(report.reference, reference);
  assert.equal(report.referenceMissing, null);
  assert.equal(report.base, 'main');
  assert.equal(report.since, 'approved');
  assert.match(report.checklist, /approved\.\.HEAD/);
  assert.match(report.checklist, /never change the reference/);
  assert.match(report.checklist, /both consumers still compile/);
  assert.doesNotMatch(report.checklist, /Parity with browser: not checked/);
});

test('a missing project parity reference retains its diagnostic and rules', async (t) => {
  const f = fixture(t);
  const output = captureStdout(t);
  const key = `${harnessHost().envPrefix}_REF_BROWSER`;
  const previous = process.env[key];
  process.env[key] = path.join(f.root, 'environment-reference');
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
  await withProjectRecipeHost(f.options, async () =>
    handleReview(['checklist', '--base', 'main', '--json'], {
      parityRuntimeIds: { headless: 'browser' },
      parity: () => ({
        referenceMissing: 'no configured or discovered browser checkout',
        steps: ['Record missing parity in the verdict.'],
      }),
    }),
  );
  const report = JSON.parse(output());
  assert.equal(report.reference, null);
  assert.equal(report.referenceMissing, 'no configured or discovered browser checkout');
  assert.match(report.checklist, /Record missing parity in the verdict/);
});

test('a project binding ignores host review hooks', async (t) => {
  const f = fixture(t);
  const output = captureStdout(t);
  const host = () => assert.fail('a project binding owns review resolution and wording');
  const hooks = {
    libraries: host,
    resolveLibrary: host,
    runtime: host,
    header: host,
    defaultDomain: { read: host, label: 'HOST_DOMAIN' },
    domainCommand: 'host review domain',
    usage: 'Use host review.',
    verdictRule: 'Host verdict.',
  };
  await withProjectRecipeHost(f.options, async () =>
    handleReview(['checklist', '--base', 'main', '--json'], hooks),
  );
  const report = JSON.parse(output());
  assert.equal(report.adapter, 'headless');
  assert.equal(report.domain, null);
  assert.match(report.checklist, /Run `farmslot review domain`/u);
  assert.match(report.checklist, /Post APPROVE or REQUEST CHANGES/u);
  await assert.rejects(
    withProjectRecipeHost(f.options, async () => handleReview(['help'], hooks)),
    /Use farmslot review checklist\|domain\./u,
  );
});

test('advice receives the resolved runtime and preserves an explicit opt-out', async (t) => {
  const f = fixture(t);
  let calls = 0;
  await withProjectRecipeHost(f.options, async () =>
    handleRecipeQuality(['advisor-status', '--advisor', 'off'], {
      subcommands: {
        'advisor-status': async (options) => {
          calls += 1;
          assert.equal(options.adapter, 'headless');
          assert.equal(options.advisor, 'off');
          return 0;
        },
      },
    }),
  );
  assert.equal(calls, 1);
});

test('the selected action manifest is retained with its configuration', async (t) => {
  const f = fixture(t);
  const config = f.options.projects?.[0]?.config;
  assert.ok(config?.recipe);
  const manifest = path.join(f.pack, 'actions.json');
  fs.writeFileSync(manifest, '{"actions":[]}');
  const selected = { ...config, recipe: { ...config.recipe, manifest: 'actions.json' } };
  fs.writeFileSync(path.join(f.pack, 'project.json'), JSON.stringify(selected));
  const options = { ...f.options, projects: [{ root: f.pack, config: selected }] };
  await withProjectRecipeHost(options, async (host) => {
    retainTaskExecution(
      f.taskDir,
      await projectTaskExecution(host, {
        executable: path.join(f.installed, 'farmslot'),
        packageRoot: f.installed,
        distributionRoot: f.installed,
      }),
    );
  });
  fs.writeFileSync(manifest, 'changed original');
  await withTaskProjectHost(options, f.taskDir, async ({ cli }) => {
    assert.equal(typeof cli.actionManifest, 'string');
    if (typeof cli.actionManifest !== 'string') assert.fail('Missing retained manifest');
    assert.notEqual(cli.actionManifest, manifest);
    assert.equal(fs.readFileSync(cli.actionManifest, 'utf8'), '{"actions":[]}');
  });
});

test('retained hosts preserve recipe runtime, farm runtime and declared conformance checks', async (t) => {
  const f = fixture(t);
  const config = f.options.projects?.[0]?.config;
  assert.ok(config?.recipe);
  const checks = [{ recipe: 'example/smoke', params: { bounded: true } }];
  const selected = {
    ...config,
    paths: { ...config.paths, runtimeDir: 'farm-runtime' },
    recipe: { ...config.recipe, checks },
  };
  fs.writeFileSync(path.join(f.pack, 'project.json'), JSON.stringify(selected));
  const options = {
    ...f.options,
    projects: [{ root: f.pack, config: selected }],
    tokens: ['--project', 'example', '--runtime-dir', 'recipe-runtime'],
    options: { runtimeDir: 'recipe-runtime' },
  };
  let freshRecipe: string | undefined;
  let freshFarm: string | undefined;
  await withProjectRecipeHost(options, async (host) => {
    freshRecipe = host.context.project?.runtimeDir;
    freshFarm = host.context.project?.farmRuntimeDir;
    assert.notEqual(freshRecipe, freshFarm);
    retainTaskExecution(
      f.taskDir,
      await projectTaskExecution(host, {
        executable: path.join(f.installed, 'farmslot'),
        packageRoot: f.installed,
        distributionRoot: f.installed,
      }),
    );
  });
  await withTaskProjectHost({ ...f.options, tokens: [] }, f.taskDir, async (host) => {
    assert.equal(host.context.project?.runtimeDir, freshRecipe);
    assert.equal(host.context.project?.farmRuntimeDir, freshFarm);
    assert.deepEqual(host.context.project?.checks, checks);
  });
});

test('external providers retain the owning workspace without widening their recipe root', async (t) => {
  const f = fixture(t);
  const recipe = path.join(f.pack, 'recipe');
  const library = path.join(f.pack, 'lib');
  fs.mkdirSync(recipe);
  fs.mkdirSync(library);
  fs.writeFileSync(path.join(library, 'policy.mjs'), 'export const ready = true;\n');
  const provider = fs.readFileSync(path.join(f.pack, 'provider.mjs'), 'utf8');
  fs.writeFileSync(
    path.join(recipe, 'provider.mjs'),
    `if (!(await import('../lib/policy.mjs')).ready) throw new Error('Missing policy');\n${provider}`,
  );
  fs.rmSync(path.join(f.pack, 'provider.mjs'));
  fs.writeFileSync(
    path.join(f.pack, 'package.json'),
    JSON.stringify({ private: true, type: 'module', files: ['recipe', 'lib', 'project.json'] }),
  );
  const config = f.options.projects?.[0]?.config;
  assert.ok(config?.recipe);
  config.recipe.provider = { module: 'provider.mjs', root: { projectPath: recipe } };
  fs.writeFileSync(path.join(f.pack, 'project.json'), JSON.stringify(config));
  await withProjectRecipeHost(f.options, async (host) => {
    assert.equal(host.context.project?.provider.root, recipe);
    const execution = await projectTaskExecution(host, {
      executable: path.join(f.installed, 'farmslot'),
      packageRoot: f.installed,
      distributionRoot: f.installed,
    });
    retainTaskExecution(f.taskDir, execution);
  });
  fs.rmSync(f.pack, { recursive: true, force: true });
  await withTaskProjectHost(f.options, f.taskDir, async (host) => {
    assert.equal(path.basename(host.context.project!.provider.root), 'recipe');
    assert.equal(host.provider.runtime.id, 'headless');
  });
});

test('project retention excludes task history while preserving tooling source', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.pack, 'package.json'), '{"private":true,"type":"module"}');
  fs.mkdirSync(path.join(f.pack, 'tasks', 'previous'), { recursive: true });
  fs.writeFileSync(path.join(f.pack, 'tasks', 'previous', 'TASK.md'), 'old task and evidence');
  await withProjectRecipeHost(f.options, async (host) => {
    const execution = await projectTaskExecution(host, {
      executable: path.join(f.installed, 'farmslot'),
      packageRoot: f.installed,
      distributionRoot: f.installed,
    });
    const receipt = retainTaskExecution(f.taskDir, execution);
    const pack = receipt.retainedInputs.find((input) => input.source === f.pack);
    assert.ok(pack);
    assert.equal(fs.existsSync(path.join(pack.path, 'provider.mjs')), true);
    assert.equal(fs.existsSync(path.join(pack.path, 'tasks')), false);
  });
});

test('nested app retention excludes app-relative recipe runtime output', async (t) => {
  const f = fixture(t);
  const app = path.join(f.checkout, 'apps/web');
  const recipe = path.join(app, 'recipe');
  fs.mkdirSync(path.join(recipe, 'runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(app, 'package.json'),
    JSON.stringify({ private: true, type: 'module', files: ['recipe'] }),
  );
  fs.copyFileSync(path.join(f.pack, 'provider.mjs'), path.join(recipe, 'provider.mjs'));
  fs.writeFileSync(path.join(recipe, 'runtime/state.json'), '{"state":"runtime output"}');
  const config = f.options.projects?.[0]?.config;
  assert.ok(config?.recipe);
  const selected = {
    ...config,
    apps: ['apps/web'],
    recipe: {
      ...config.recipe,
      provider: { module: 'provider.mjs', root: { projectPath: 'apps/web/recipe' } },
    },
  };
  fs.writeFileSync(path.join(f.pack, 'project.json'), JSON.stringify(selected));
  await withProjectRecipeHost(
    {
      ...f.options,
      projects: [{ root: f.pack, config: selected }],
      tokens: ['--project', 'example', '--app', 'apps/web', '--runtime-dir', 'recipe/runtime'],
    },
    async (host) => {
      assert.equal(host.context.target.value, app);
      const execution = await projectTaskExecution(host, {
        executable: path.join(f.installed, 'farmslot'),
        packageRoot: f.installed,
        distributionRoot: f.installed,
      });
      const receipt = retainTaskExecution(f.taskDir, execution);
      const retainedApp = receipt.retainedInputs.find((input) => input.source === app);
      assert.ok(retainedApp);
      assert.equal(fs.existsSync(path.join(retainedApp.path, 'recipe/provider.mjs')), true);
      assert.equal(fs.existsSync(path.join(retainedApp.path, 'recipe/runtime/state.json')), false);
    },
  );
});

/** A task retained from a provider and recipe library inside its checkout, as EchoBridge declares them. */
async function checkoutProviderTask(t: TestContext) {
  const f = fixture(t);
  const app = path.join(f.checkout, 'apps/web');
  const recipe = path.join(app, 'recipe');
  const library = path.join(f.checkout, 'recipes');
  fs.mkdirSync(recipe, { recursive: true });
  fs.mkdirSync(library);
  fs.writeFileSync(path.join(library, 'smoke.recipe.json'), '{}');
  fs.writeFileSync(
    path.join(app, 'package.json'),
    JSON.stringify({ private: true, type: 'module', files: ['recipe'] }),
  );
  fs.copyFileSync(path.join(f.pack, 'provider.mjs'), path.join(recipe, 'provider.mjs'));
  const config = f.options.projects?.[0]?.config;
  assert.ok(config?.recipe);
  const selected = {
    ...config,
    apps: ['apps/web'],
    recipe: {
      ...config.recipe,
      provider: { module: 'provider.mjs', root: { projectPath: 'apps/web/recipe' } },
      libraries: [{ name: 'checkout-recipes', owner: 'example', source: library }],
    },
  };
  fs.writeFileSync(path.join(f.pack, 'project.json'), JSON.stringify(selected));
  const options = { ...f.options, projects: [{ root: f.pack, config: selected }] };
  const install = {
    executable: path.join(f.installed, 'farmslot'),
    packageRoot: f.installed,
    distributionRoot: f.installed,
  };
  const shim = (executable: string) =>
    buildMarkShim(`${quoteTaskPath(executable)} task mark`, true);
  await withProjectRecipeHost(
    { ...options, tokens: ['--project', 'example', '--app', 'apps/web'] },
    async (host) => {
      const receipt = retainTaskExecution(f.taskDir, await projectTaskExecution(host, install));
      fs.writeFileSync(path.join(f.taskDir, 'mark'), shim(receipt.resolvedExecutable));
    },
  );
  return { ...f, recipe, library, selected, options, install, shim };
}

test('a repin refuses an unchanged checkout or a changed pack without touching the task', async (t) => {
  const f = await checkoutProviderTask(t);
  const receiptFile = path.join(f.taskDir, 'artifacts/harness-provenance.json');
  const original = fs.readFileSync(receiptFile);
  await assert.rejects(repinSelectedTask(f.options, f.taskDir, f.install), {
    code: 'TASK_REPIN_UNCHANGED',
  });
  const otherPack = path.join(f.root, 'other-pack');
  fs.cpSync(f.pack, otherPack, { recursive: true });
  fs.writeFileSync(path.join(f.library, 'main-flows.recipe.json'), '{}');
  await assert.rejects(
    repinSelectedTask(
      { ...f.options, projects: [{ root: otherPack, config: f.selected }] },
      f.taskDir,
      f.install,
    ),
    { code: 'TASK_BINDING_CHANGED' },
  );
  assert.deepEqual(fs.readFileSync(receiptFile), original);
});

test('a repin follows changed checkout recipes and keeps task documents', async (t) => {
  const f = await checkoutProviderTask(t);
  fs.writeFileSync(path.join(f.library, 'main-flows.recipe.json'), '{}');
  const checklist = fs.readFileSync(path.join(f.taskDir, 'CHECKLIST.md'), 'utf8');
  const { previous, receipt } = await repinSelectedTask(f.options, f.taskDir, f.install);
  assert.notEqual(receipt.pin, previous.pin);
  assert.deepEqual(verifySelectedTask(f.taskDir), receipt);
  assert.equal(
    fs.readFileSync(path.join(f.taskDir, 'mark'), 'utf8'),
    f.shim(receipt.resolvedExecutable),
  );
  assert.equal(fs.readFileSync(path.join(f.taskDir, 'CHECKLIST.md'), 'utf8'), checklist);
  await withTaskProjectHost(f.options, f.taskDir, async (host) => {
    const library = host.librarySources.find((entry) => entry.name === 'checkout-recipes');
    assert.ok(library);
    assert.ok(library.root.startsWith(`${receipt.pin}${path.sep}`));
    assert.equal(fs.existsSync(path.join(library.root, 'main-flows.recipe.json')), true);
  });
});
