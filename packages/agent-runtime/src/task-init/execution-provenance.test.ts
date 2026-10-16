import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { retainTaskExecution, verifyTaskExecutionProvenance } from './execution-provenance.js';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-tooling-'));
  const previousFarmHome = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = path.join(root, 'pins');
  t.after(() => {
    if (previousFarmHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousFarmHome;
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const distributionRoot = path.join(root, 'installed');
  const executable = path.join(distributionRoot, 'bin', 'farmslot.mjs');
  const provider = path.join(root, 'provider');
  const library = path.join(root, 'library');
  const taskDir = path.join(root, 'task');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '#!/usr/bin/env node\nconsole.log("1.0.0");\n');
  fs.writeFileSync(
    path.join(distributionRoot, 'package.json'),
    JSON.stringify({ name: '@farmslot/cli', version: '1.0.0' }),
  );
  for (const directory of [provider, library]) {
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'action.mjs'), 'export default 1;\n');
  }
  return {
    root,
    taskDir,
    provider,
    library,
    input: {
      executable,
      packageRoot: distributionRoot,
      distributionRoot,
      bindingIdentity: null,
      inputs: [provider, library],
    },
  };
}

test('task tooling survives install pruning and provider/library updates', (t) => {
  const { root, taskDir, provider, library, input } = fixture(t);
  fs.symlinkSync(input.executable, path.join(input.distributionRoot, 'entry-link'));
  const receipt = retainTaskExecution(taskDir, input);
  fs.rmSync(input.distributionRoot, { recursive: true });
  fs.writeFileSync(path.join(provider, 'action.mjs'), 'export default 2;\n');
  fs.writeFileSync(path.join(library, 'action.mjs'), 'export default 3;\n');
  fs.writeFileSync(path.join(root, 'product.ts'), 'ordinary editable product source');
  assert.deepEqual(verifyTaskExecutionProvenance(taskDir, null), receipt);
  assert.equal(
    fs.readFileSync(path.join(receipt.retainedInputs[1]!.path, 'action.mjs'), 'utf8'),
    'export default 1;\n',
  );
});

test('changed retained dependency refuses without changing the receipt', (t) => {
  const { taskDir, input } = fixture(t);
  const receipt = retainTaskExecution(taskDir, input);
  const file = path.join(taskDir, 'artifacts/harness-provenance.json');
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(path.join(receipt.retainedInputs[1]!.path, 'action.mjs'), 'changed');
  assert.throws(() => verifyTaskExecutionProvenance(taskDir, null), { code: 'TASK_INPUT_CHANGED' });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('legacy receipt refuses without rewriting its marker or evidence', (t) => {
  const { taskDir, input } = fixture(t);
  retainTaskExecution(taskDir, input);
  const file = path.join(taskDir, 'artifacts/harness-provenance.json');
  const legacy = '{"schemaVersion":1,"resolvedExecutable":"original"}\n';
  fs.writeFileSync(file, legacy);
  assert.throws(() => verifyTaskExecutionProvenance(taskDir, null), {
    code: 'TASK_PROVENANCE_LEGACY',
  });
  assert.equal(fs.readFileSync(file, 'utf8'), legacy);
});

test('an external dependency cannot remain linked to a mutable install', (t) => {
  const { root, taskDir, input } = fixture(t);
  const outside = path.join(root, 'mutable-dependency');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(input.distributionRoot, 'external'));
  assert.throws(() => retainTaskExecution(taskDir, input), /outside its installation/);
  assert.equal(fs.existsSync(path.join(taskDir, 'artifacts/harness-provenance.json')), false);
});

test('rewriting task-owned hashes cannot authorize a different executable', (t) => {
  const { taskDir, input } = fixture(t);
  const receipt = retainTaskExecution(taskDir, input);
  const file = path.join(taskDir, 'artifacts/harness-provenance.json');
  fs.writeFileSync(file, JSON.stringify({ ...receipt, entrySha256: '0'.repeat(64) }));
  assert.throws(() => verifyTaskExecutionProvenance(taskDir, null), {
    code: 'TASK_PROVENANCE_INVALID',
  });
});

test('owning workspace keeps sibling imports and declared local dependencies after originals disappear', async (t) => {
  const { root, taskDir, input } = fixture(t);
  const workspace = path.join(root, 'tooling');
  const dependency = path.join(root, 'local-package');
  const leaf = path.join(root, 'node_modules', 'leaf');
  for (const directory of [
    path.join(workspace, 'recipe'),
    path.join(workspace, 'lib'),
    path.join(workspace, 'node_modules'),
    dependency,
    leaf,
  ])
    fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      files: ['recipe', 'lib'],
      dependencies: { local: 'workspace:*' },
    }),
  );
  fs.writeFileSync(path.join(workspace, 'product.js'), 'ordinary product source');
  fs.writeFileSync(path.join(workspace, 'lib', 'state.mjs'), 'export const state = 3;');
  fs.writeFileSync(
    path.join(workspace, 'recipe', 'provider.mjs'),
    'import { state } from "../lib/state.mjs"; import value from "local"; export default state + value;',
  );
  fs.writeFileSync(
    path.join(dependency, 'package.json'),
    JSON.stringify({
      name: 'local',
      type: 'module',
      main: 'index.mjs',
      peerDependencies: { leaf: '1.0.0' },
    }),
  );
  fs.writeFileSync(
    path.join(dependency, 'index.mjs'),
    'import value from "leaf"; export default value + 2;',
  );
  fs.writeFileSync(
    path.join(leaf, 'package.json'),
    JSON.stringify({ name: 'leaf', type: 'module', main: 'index.mjs' }),
  );
  fs.writeFileSync(path.join(leaf, 'index.mjs'), 'export default 5;');
  fs.symlinkSync(dependency, path.join(workspace, 'node_modules', 'local'));
  fs.mkdirSync(path.join(workspace, 'node_modules', 'ambient'));
  fs.writeFileSync(path.join(workspace, 'node_modules', 'ambient', 'unused'), 'not declared');
  const receipt = retainTaskExecution(taskDir, {
    ...input,
    inputs: [workspace],
    dependencyRoots: [workspace],
  });
  const retained = receipt.retainedInputs.find(
    (entry) => entry.source === fs.realpathSync(workspace),
  );
  assert.ok(retained);
  assert.equal(fs.existsSync(path.join(retained.path, 'node_modules', 'ambient')), false);
  assert.equal(fs.existsSync(path.join(retained.path, 'product.js')), false);
  assert.ok(receipt.retainedInputs.some((entry) => entry.source === fs.realpathSync(dependency)));
  fs.rmSync(workspace, { recursive: true });
  fs.rmSync(dependency, { recursive: true });
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
  const { pathToFileURL } = await import('node:url');
  const module = await import(
    pathToFileURL(path.join(retained.path, 'recipe', 'provider.mjs')).href
  );
  assert.equal(module.default, 10);
  assert.deepEqual(verifyTaskExecutionProvenance(taskDir, null), receipt);
});

test('missing declared dependency refuses before a receipt can authorize a marker', (t) => {
  const { taskDir, provider, input } = fixture(t);
  fs.writeFileSync(
    path.join(provider, 'package.json'),
    JSON.stringify({ private: true, dependencies: { absent: '1.0.0' } }),
  );
  assert.throws(
    () =>
      retainTaskExecution(taskDir, { ...input, inputs: [provider], dependencyRoots: [provider] }),
    /Declared task dependency absent is not installed/,
  );
  assert.equal(fs.existsSync(path.join(taskDir, 'artifacts', 'harness-provenance.json')), false);
});

test('a relocated receipt refuses with the original bytes preserved', (t) => {
  const { root, taskDir, input } = fixture(t);
  retainTaskExecution(taskDir, input);
  const relocated = path.join(root, 'relocated');
  fs.cpSync(taskDir, relocated, { recursive: true });
  const before = fs.readFileSync(path.join(relocated, 'artifacts/harness-provenance.json'), 'utf8');
  assert.throws(() => verifyTaskExecutionProvenance(relocated, null), {
    code: 'TASK_PROVENANCE_RELOCATED',
  });
  assert.equal(
    fs.readFileSync(path.join(relocated, 'artifacts/harness-provenance.json'), 'utf8'),
    before,
  );
});
