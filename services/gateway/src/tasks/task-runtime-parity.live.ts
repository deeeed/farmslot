import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { projectWorkerTemplateSource, selectExecutionTemplate } from '@farmslot/agent-runtime';
import { runTaskRuntime } from '@farmslot/slot-config/task-runtime';

import {
  CASE,
  checkout,
  cliRun,
  distribution,
  env,
  request,
  root,
  taskDir,
  wireRequest,
} from './task-runtime.test-support.js';

// CLI/thread parity: each case cold-loads the CLI module graph once per transport (~1 s on
// CI), so this suite runs by hand via `yarn test:task-runtime-parity-live`, not in `yarn test`.
function snapshot() {
  return fs
    .readdirSync(taskDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [
        path.relative(taskDir, file),
        fs.readFileSync(file).toString('base64'),
        fs.statSync(file).mode & 0o777,
      ];
    })
    .sort();
}

function normalizeOutput(text: string, result: string): string {
  const data = JSON.parse(result).data;
  return text
    .replaceAll(data.executionProvenance.pin, '<pin>')
    .replace(/"resolvedAt": "[^"]+"/g, '"resolvedAt": "<resolvedAt>"')
    .replaceAll(data.executionProvenance.recordedAt, '<recordedAt>');
}
function taskBytes() {
  return fs
    .readdirSync(taskDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [
        path.relative(taskDir, file),
        fs.readFileSync(file, 'utf8'),
        fs.statSync(file).mode & 0o777,
      ];
    })
    .sort();
}

function parityCase<Fixture>(
  name: string,
  baseline: () => Fixture | Promise<Fixture>,
  verify: (t: import('node:test').TestContext, fixture: Fixture) => Promise<void>,
) {
  let fixture: { value: Fixture } | undefined;
  test(`${name}: CLI baseline`, { timeout: CASE }, async () => {
    fixture = { value: await baseline() };
  });
  test(`${name}: thread parity`, { timeout: CASE }, async (t) => {
    assert(fixture, 'CLI baseline completed');
    await verify(t, fixture.value);
  });
}

parityCase(
  'fresh init preserves task bytes, modes and provenance',
  () => {
    const before = cliRun(['internal', 'task-init', wireRequest()]);
    assert.equal(before.exitCode, 0, before.stdout + before.stderr);
    return { before, files: taskBytes() };
  },
  async (t, { before, files }) => {
    fs.rmSync(taskDir, { recursive: true });
    const started = performance.now();
    const actual = await runTaskRuntime(
      { ...request, action: 'init', taskPath: wireRequest() },
      root,
      env,
    );
    t.diagnostic(
      `CLI fresh init ${before.ms.toFixed(1)} ms; thread fresh init ${(performance.now() - started).toFixed(1)} ms`,
    );
    assert.equal(actual.exitCode, 0, actual.stdout + actual.stderr);
    assert.deepEqual(
      JSON.parse(normalizeOutput(actual.stdout, actual.stdout)),
      JSON.parse(normalizeOutput(before.stdout, before.stdout)),
    );
    assert.deepEqual(
      taskBytes().map(([file, text, mode]) => [
        file,
        normalizeOutput(String(text), actual.stdout),
        mode,
      ]),
      files.map(([file, text, mode]) => [file, normalizeOutput(String(text), before.stdout), mode]),
    );
  },
);

parityCase(
  'retained init preserves every byte and exact result',
  () => {
    const files = snapshot();
    return { files, before: cliRun(['internal', 'task-init', wireRequest()]) };
  },
  async (_t, { files, before }) => {
    const actual = await runTaskRuntime(
      { ...request, action: 'init', taskPath: wireRequest() },
      root,
      env,
    );
    assert.equal(actual.exitCode, 0, actual.stdout + actual.stderr);
    assert.equal(actual.stdout, before.stdout);
    assert.deepEqual(snapshot(), files);
  },
);

parityCase(
  'receipt verification preserves stdout, code and task files',
  () => {
    const files = snapshot();
    const before = cliRun(['task', 'verify', taskDir]);
    assert.equal(before.exitCode, 0, before.stdout + before.stderr);
    return { files, before };
  },
  async (t, { files, before }) => {
    const started = performance.now();
    const actual = await runTaskRuntime(request, root, env);
    t.diagnostic(
      `CLI verify ${before.ms.toFixed(1)} ms; thread verify ${(performance.now() - started).toFixed(1)} ms`,
    );
    assert.equal(actual.exitCode, 0, actual.stdout + actual.stderr);
    assert.equal(actual.stdout, before.stdout);
    assert.deepEqual(snapshot(), files);
  },
);

for (const mutation of ['binding', 'receipt', 'tooling', 'partial'] as const) {
  parityCase(
    `${mutation} refusal preserves envelope and code`,
    () => {
      const file =
        mutation === 'tooling'
          ? JSON.parse(
              fs.readFileSync(path.join(taskDir, 'artifacts/harness-provenance.json'), 'utf8'),
            ).resolvedExecutable
          : path.join(
              taskDir,
              mutation === 'binding'
                ? 'inputs/recipe-binding.json'
                : 'artifacts/harness-provenance.json',
            );
      const original = fs.readFileSync(file);
      if (mutation === 'partial') fs.unlinkSync(file);
      else if (mutation === 'binding') fs.writeFileSync(file, '{"identity":17}');
      else if (mutation === 'receipt') fs.writeFileSync(file, '{}');
      else fs.appendFileSync(file, '\n// changed');
      try {
        const before = cliRun(
          mutation === 'partial'
            ? ['internal', 'task-init', wireRequest()]
            : ['task', 'verify', taskDir],
        );
        assert.notEqual(before.exitCode, 0);
        return { before, file, original };
      } catch (error) {
        fs.writeFileSync(file, original);
        throw error;
      }
    },
    async (_t, { before, file, original }) => {
      try {
        const actual = await runTaskRuntime(
          mutation === 'partial'
            ? { ...request, action: 'init', taskPath: wireRequest() }
            : request,
          root,
          env,
        );
        assert.notEqual(actual.exitCode, 0);
        assert.equal(actual.exitCode, before.exitCode, actual.stdout + actual.stderr);
        assert.equal(actual.stdout, before.stdout);
      } finally {
        fs.writeFileSync(file, original);
      }
    },
  );
}

let providerDirectory = '';
let providerReceipt: unknown;
test('project-bound init records its selected provider receipt', { timeout: CASE }, async () => {
  const pack = path.join(root, 'projects/provider');
  fs.mkdirSync(path.join(pack, 'templates/worker'), { recursive: true });
  fs.writeFileSync(
    path.join(pack, 'package.json'),
    '{"type":"module","files":["provider.mjs","project.json","templates"]}',
  );
  fs.writeFileSync(
    path.join(pack, 'project.json'),
    JSON.stringify({
      name: 'provider',
      task_dir: 'tasks',
      execution_templates: { sources: [] },
      paths: { runtime_dir: '.runtime', artifact_dir: 'artifacts' },
      recipe: { adapter: 'headless', provider: { module: 'provider.mjs' } },
    }),
  );
  fs.writeFileSync(
    path.join(pack, 'provider.mjs'),
    `
    export function createProvider() {
      return {
        runtime: { id: 'headless', sdkVersion: 1, headless: true,
          runtimeStatus: async () => ({decision:'ready', reasons:[]}), resolveSlotPorts() {},
          logSources: () => [], appLogSource: () => null, devServer: {}, hints: {}, runtimeContext: {},
          harness: { verify: async () => ({ok:true}) },
          launch: async () => { throw new Error('unexpected launch'); },
          actions: {manifestPath: () => '', semantic: [], cdpTarget: {transport:'none'}},
        }, commandOptions: {task: {stepGates: []}},
      };
    }
  `,
  );
  fs.writeFileSync(path.join(pack, 'templates/worker/dev.md'), '# Task\n\n- [ ] Observe\n');
  const selectedProvider = selectExecutionTemplate({
    sources: [projectWorkerTemplateSource('provider', path.join(pack, 'templates'))],
    flow: 'dev',
    platform: 'cli',
  });
  fs.writeFileSync(
    path.join(root, 'pool/provider.json'),
    JSON.stringify({
      machine: 'local',
      host: 'localhost',
      project: 'provider',
      platform: 'cli',
      slots: [{ id: 'provider-1', repo: checkout }],
    }),
  );
  const directory = path.join(checkout, 'tasks/dev/provider');
  fs.mkdirSync(directory, { recursive: true });
  const inputFile = path.join(directory, '.task-init-00000000-0000-4000-8000-000000000000.json');
  fs.writeFileSync(
    inputFile,
    JSON.stringify({
      version: 1,
      slotId: 'provider-1',
      binding: 'project',
      task: {
        taskDir: directory,
        flow: 'dev',
        platform: 'cli',
        task: { title: 'Provider parity', sourceKind: 'text' },
        handoff: { surface: 'farmslot', project: 'provider', attemptId: 'provider' },
      },
      template: {
        sourceId: selectedProvider.entry.sourceId,
        id: selectedProvider.entry.id,
        sha256: selectedProvider.entry.sha256,
        selectionReason: selectedProvider.reason,
      },
    }),
  );
  const initialized = await runTaskRuntime(
    { ...request, action: 'init', taskPath: inputFile },
    root,
    env,
  );
  assert.equal(initialized.exitCode, 0, initialized.stdout + initialized.stderr);
  const receipt = JSON.parse(initialized.stdout).data.executionProvenance;
  assert.equal(receipt.bindingIdentity.project, 'provider');
  assert.equal(receipt.bindingIdentity.adapter, 'headless');
  providerDirectory = directory;
  providerReceipt = receipt;
});

parityCase(
  'project-bound verification preserves its provider receipt',
  () => {
    assert(providerDirectory);
    return cliRun(['task', 'verify', providerDirectory]);
  },
  async (_t, before) => {
    const actual = await runTaskRuntime({ ...request, taskPath: providerDirectory }, root, env);
    assert.equal(actual.exitCode, 0, actual.stdout + actual.stderr);
    assert.equal(actual.stdout, before.stdout);
    assert.deepEqual(JSON.parse(actual.stdout), providerReceipt);
  },
);

for (const source of ['state', 'env-file'] as const) {
  parityCase(
    `CLI home bootstrap from ${source} selects the same pin store`,
    () => {
      const customHome = path.join(root, `custom-home-${source}`);
      const environment: NodeJS.ProcessEnv = { ...env };
      delete environment.FARMSLOT_HOME;
      if (source === 'state') {
        const workspace = path.join(root, 'custom-workspace');
        fs.mkdirSync(workspace);
        fs.writeFileSync(
          path.join(workspace, 'state.json'),
          JSON.stringify({ schema_version: 1, home_dir: customHome }),
        );
        environment.FARMSLOT_WORKSPACE = workspace;
      } else fs.writeFileSync(path.join(distribution, '.env'), `FARMSLOT_HOME=${customHome}\n`);
      const directory = path.join(checkout, `tasks/dev/home-${source}`);
      fs.mkdirSync(directory, { recursive: true });
      const input = JSON.parse(fs.readFileSync(wireRequest(), 'utf8'));
      fs.unlinkSync(path.join(taskDir, '.task-init-00000000-0000-4000-8000-000000000000.json'));
      input.task.taskDir = directory;
      const inputFile = path.join(
        directory,
        '.task-init-00000000-0000-4000-8000-000000000000.json',
      );
      fs.writeFileSync(inputFile, JSON.stringify(input));
      const initialized = cliRun(['internal', 'task-init', inputFile], environment);
      assert.equal(initialized.exitCode, 0, initialized.stdout + initialized.stderr);
      assert.equal(
        path.dirname(JSON.parse(initialized.stdout).data.executionProvenance.pin),
        path.join(customHome, 'task-pins'),
      );
      return { initialized, directory, environment };
    },
    async (_t, { initialized, directory, environment }) => {
      try {
        const verified = await runTaskRuntime(
          { ...request, taskPath: directory },
          root,
          environment,
        );
        assert.equal(verified.exitCode, 0, verified.stdout + verified.stderr);
        assert.deepEqual(
          JSON.parse(verified.stdout),
          JSON.parse(initialized.stdout).data.executionProvenance,
        );
      } finally {
        if (source === 'env-file') fs.unlinkSync(path.join(distribution, '.env'));
      }
    },
  );
}
