import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  completeInterruptedRepin,
  repinTaskExecution,
  retainTaskExecution,
  verifyTaskExecutionProvenance,
} from './execution-provenance.js';
import { taskInputDigest } from './pin.js';

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

test('retained tooling copies content, modes and links without timestamp work', (t) => {
  const { taskDir, input } = fixture(t);
  const oldTime = new Date('2001-01-01T00:00:00Z');
  fs.chmodSync(input.executable, 0o755);
  fs.utimesSync(input.executable, oldTime, oldTime);
  fs.symlinkSync('bin/farmslot.mjs', path.join(input.distributionRoot, 'entry-link'));
  const original = fs.statSync(input.executable);
  const receipt = retainTaskExecution(taskDir, input);
  const retained = fs.statSync(receipt.resolvedExecutable);
  assert.notEqual(retained.mtimeMs, original.mtimeMs);
  assert.equal(retained.mode & 0o111, original.mode & 0o111);
  assert.equal(receipt.retainedInputs[0]!.sha256, taskInputDigest(input.distributionRoot));
  assert.deepEqual(verifyTaskExecutionProvenance(taskDir, null), receipt);
  assert.equal(fs.statSync(input.executable).mtimeMs, original.mtimeMs);
  fs.chmodSync(receipt.resolvedExecutable, 0o644);
  assert.throws(() => verifyTaskExecutionProvenance(taskDir, null), {
    code: 'TASK_INPUT_CHANGED',
  });
});

test('a tilde FARMSLOT_HOME retains tooling under the home directory, not the checkout', (t) => {
  const { root, taskDir, input } = fixture(t);
  const home = path.join(root, 'home');
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(home);
  fs.mkdirSync(checkout);
  const previous = { home: process.env.HOME, cwd: process.cwd() };
  t.after(() => {
    process.chdir(previous.cwd);
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
  });
  // A gateway that loads FARMSLOT_HOME from a checkout .env passes it literally.
  process.env.HOME = home;
  process.env.FARMSLOT_HOME = '~/.farmslot-dev';
  process.chdir(checkout);
  const receipt = retainTaskExecution(taskDir, input);
  assert.equal(path.dirname(receipt.pin), path.join(home, '.farmslot-dev', 'task-pins'));
  assert.deepEqual(fs.readdirSync(checkout), []);
  assert.deepEqual(verifyTaskExecutionProvenance(taskDir, null), receipt);
});

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

test('a repin replaces the selection and receipt; the previous pin keeps the original', (t) => {
  const { root, taskDir, provider, input } = fixture(t);
  const previous = retainTaskExecution(taskDir, {
    ...input,
    selectedConfiguration: '{"identity":null}',
  });
  fs.writeFileSync(path.join(provider, 'action.mjs'), 'export default 2;\n');
  const changed = { ...input, selectedConfiguration: '{"identity":null,"repinned":true}' };
  assert.throws(() =>
    repinTaskExecution(
      taskDir,
      { ...changed, inputs: [...input.inputs, path.join(root, 'missing')] },
      previous,
    ),
  );
  assert.deepEqual(verifyTaskExecutionProvenance(taskDir, null), previous);
  assert.deepEqual(fs.readdirSync(path.join(taskDir, 'inputs')), ['recipe-binding.json']);
  assert.deepEqual(fs.readdirSync(path.join(taskDir, 'artifacts')), ['harness-provenance.json']);

  const receipt = repinTaskExecution(taskDir, changed, previous);
  assert.notEqual(receipt.pin, previous.pin);
  assert.deepEqual(verifyTaskExecutionProvenance(taskDir, null), receipt);
  assert.equal(
    fs.readFileSync(path.join(taskDir, 'inputs/recipe-binding.json'), 'utf8'),
    changed.selectedConfiguration,
  );
  const retained = receipt.retainedInputs.find(
    (entry) => entry.source === fs.realpathSync(provider),
  );
  assert.equal(
    fs.readFileSync(path.join(retained!.path, 'action.mjs'), 'utf8'),
    'export default 2;\n',
  );
  const authority = (pin: string): { receipt?: unknown; previousPin?: unknown } =>
    JSON.parse(fs.readFileSync(path.join(pin, 'provenance.json'), 'utf8'));
  assert.deepEqual(authority(previous.pin).receipt, previous);
  assert.equal(authority(receipt.pin).previousPin, previous.pin);
  assert.deepEqual(fs.readdirSync(path.join(taskDir, 'inputs')), ['recipe-binding.json']);
  assert.deepEqual(fs.readdirSync(path.join(taskDir, 'artifacts')), ['harness-provenance.json']);

  // A repin stopped after its receipt swap leaves the new selection staged.
  const selection = path.join(taskDir, 'inputs/recipe-binding.json');
  fs.renameSync(selection, `${selection}.${path.basename(receipt.pin)}`);
  fs.writeFileSync(selection, '{"identity":null}');
  assert.throws(() => verifyTaskExecutionProvenance(taskDir, null), { code: 'TASK_INPUT_CHANGED' });
  assert.deepEqual(completeInterruptedRepin(taskDir), { previous, receipt });
  assert.deepEqual(verifyTaskExecutionProvenance(taskDir, null), receipt);
  assert.equal(completeInterruptedRepin(taskDir), null);
  assert.deepEqual(fs.readdirSync(path.join(taskDir, 'inputs')), ['recipe-binding.json']);
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

for (const physicalPeer of [false, true]) {
  test(`hoisted dependency retains its ${physicalPeer ? 'physical' : 'workspace'} peer after source removal`, async (t) => {
    const { root, provider, taskDir, input } = fixture(t);
    const hoisted = path.join(root, 'node_modules', 'hoisted');
    const workspacePeer = path.join(provider, 'node_modules', 'peer');
    const installedPeer = path.join(root, 'node_modules', 'peer');
    const writePackage = (directory: string, manifest: object, code: string): void => {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, 'package.json'),
        JSON.stringify({ type: 'module', main: 'action.mjs', ...manifest }),
      );
      fs.writeFileSync(path.join(directory, 'action.mjs'), code);
    };
    writePackage(
      provider,
      { private: true, files: ['action.mjs'], dependencies: { hoisted: '1', peer: '2' } },
      'export { default } from "hoisted";',
    );
    writePackage(
      hoisted,
      { name: 'hoisted', peerDependencies: { peer: '*' } },
      'export { default } from "peer";',
    );
    writePackage(workspacePeer, { name: 'peer', version: '2' }, 'export default 2;');
    if (physicalPeer)
      writePackage(installedPeer, { name: 'peer', version: '1' }, 'export default 1;');
    const receipt = retainTaskExecution(taskDir, {
      ...input,
      inputs: [provider],
      dependencyRoots: [provider],
    });
    const retained = receipt.retainedInputs.find(
      (entry) => entry.source === fs.realpathSync(provider),
    );
    assert.ok(retained);
    const peer = path.join(retained.path, 'node_modules', 'hoisted', 'node_modules', 'peer');
    assert.ok(fs.realpathSync(peer).startsWith(`${fs.realpathSync(receipt.pin)}${path.sep}`));
    fs.rmSync(provider, { recursive: true });
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
    fs.rmSync(input.distributionRoot, { recursive: true });
    const { pathToFileURL } = await import('node:url');
    const module = await import(pathToFileURL(path.join(retained.path, 'action.mjs')).href);
    assert.equal(module.default, physicalPeer ? 1 : 2);
    assert.deepEqual(verifyTaskExecutionProvenance(taskDir, null), receipt);
  });
}

for (const optionalPeer of [false, true]) {
  test(`workspace peer lookup cannot repair a missing dependency${optionalPeer ? ' also declared as an optional peer' : ''}`, (t) => {
    const { root, provider, taskDir, input } = fixture(t);
    const hoisted = path.join(root, 'node_modules', 'hoisted');
    const ambient = path.join(provider, 'node_modules', 'ambient');
    fs.mkdirSync(hoisted, { recursive: true });
    fs.mkdirSync(ambient, { recursive: true });
    fs.writeFileSync(
      path.join(provider, 'package.json'),
      JSON.stringify({ private: true, dependencies: { hoisted: '1', ambient: '1' } }),
    );
    fs.writeFileSync(
      path.join(hoisted, 'package.json'),
      JSON.stringify({
        name: 'hoisted',
        dependencies: { ambient: '1' },
        ...(optionalPeer && {
          peerDependencies: { ambient: '1' },
          peerDependenciesMeta: { ambient: { optional: true } },
        }),
      }),
    );
    fs.writeFileSync(path.join(ambient, 'package.json'), JSON.stringify({ name: 'ambient' }));
    assert.throws(
      () =>
        retainTaskExecution(taskDir, { ...input, inputs: [provider], dependencyRoots: [provider] }),
      /Declared task dependency ambient is not installed/,
    );
    assert.equal(fs.existsSync(path.join(taskDir, 'artifacts', 'harness-provenance.json')), false);
  });
}

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
