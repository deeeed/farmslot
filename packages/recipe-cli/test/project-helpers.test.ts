import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { retainTaskExecution } from '../../agent-runtime/src/task-init/execution-provenance.js';
import { handleChecklist } from '../src/harness/commands/checklist.js';
import {
  projectTaskExecution,
  verifySelectedTask,
  withTaskProjectHost,
} from '../src/harness/project-helpers.js';
import {
  type ProjectRecipeHostOptions,
  withProjectRecipeHost,
} from '../src/harness/project-host.js';

function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-provider-')));
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
  const before = fs.readFileSync(path.join(f.taskDir, 'CHECKLIST.md'), 'utf8');
  const refused = await withTaskProjectHost(f.options, f.taskDir, async ({ provider }) =>
    handleChecklist(['mark', f.taskDir, '1'], provider.commandOptions?.task),
  );
  assert.notEqual(refused, 0);
  assert.equal(fs.readFileSync(path.join(f.taskDir, 'CHECKLIST.md'), 'utf8'), before);
  fs.writeFileSync(path.join(f.taskDir, 'allowed'), 'yes');
  const passed = await withTaskProjectHost(f.options, f.taskDir, async ({ provider }) =>
    handleChecklist(['mark', f.taskDir, '1'], provider.commandOptions?.task),
  );
  assert.equal(passed, 0);
  assert.match(
    fs.readFileSync(path.join(f.taskDir, 'CHECKLIST.md'), 'utf8'),
    /\[x\] Required validation/,
  );
  assert.equal(verifySelectedTask(f.taskDir).bindingIdentity?.project, 'example');
});

test('a missing or changed original provider authorization refuses retained loading', async (t) => {
  const f = fixture(t);
  await withProjectRecipeHost(f.options, async (host) => {
    retainTaskExecution(
      f.taskDir,
      await projectTaskExecution(host, {
        executable: path.join(f.installed, 'farmslot'),
        packageRoot: f.installed,
        distributionRoot: f.installed,
      }),
    );
  });
  const changed = {
    ...f.options,
    projects: f.options.projects?.map((entry) => ({
      ...entry,
      config: {
        ...entry.config,
        recipe: { ...entry.config.recipe!, provider: { module: 'other.mjs' } },
      },
    })),
  };
  fs.writeFileSync(path.join(f.pack, 'other.mjs'), 'throw new Error("must not import");');
  await assert.rejects(
    withTaskProjectHost(changed, f.taskDir, async () => assert.fail('must not invoke')),
    { code: 'PROVIDER_UNAUTHORIZED' },
  );
});
