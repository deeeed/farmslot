import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { retainTaskExecution } from '../../agent-runtime/src/task-init/execution-provenance.js';
import { handleChecklist } from '../src/harness/commands/checklist.js';
import { handleRecipeQuality } from '../src/harness/commands/recipe-quality.js';
import { handleReview } from '../src/harness/commands/review.js';
import { harnessHost } from '../src/harness/host.js';
import {
  projectTaskExecution,
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
