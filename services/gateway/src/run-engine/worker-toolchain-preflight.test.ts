import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import {
  checkToolchainObservation,
  parseToolchainObservation,
  readLaunchPackPins,
  type ToolchainObservation,
  toolchainProbeCommand,
} from './worker-toolchain-preflight.js';

function observation(): ToolchainObservation {
  return {
    packageManager: 'yarn',
    requirements: [
      { tool: 'node', range: 'v24.22.1', source: '.nvmrc' },
      { tool: 'node', range: '>=24.13.0', source: 'engines.node' },
      { tool: 'yarn', range: '^4.14.1', source: 'engines.yarn' },
    ],
    tools: {
      node: { version: 'v24.22.1' },
      packageManager: { version: '4.14.1' },
      packageManagerNode: { version: 'v24.22.1' },
      ruby: {},
    },
  };
}

const managerScripts = {
  npm: `test "$*" = 'version --json' || exit 64\nprintf '%s' '${JSON.stringify({ npm: '10.9.3', node: process.versions.node })}'\n`,
  yarn: `case "$*" in '--version') echo 4.14.1;; 'node -p process.version') echo ${process.version};; *) exit 64;; esac\n`,
  pnpm: `case "$*" in '--version') echo 10.0.0;; 'exec node -p process.version') echo ${process.version};; *) exit 64;; esac\n`,
};

async function probeProject(
  t: TestContext,
  files: Record<string, string>,
  binaries: Record<string, string>,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'launch-package-manager-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'bin');
  await mkdir(binary);
  await writeFile(path.join(directory, '.nvmrc'), process.version);
  for (const [file, contents] of Object.entries(files))
    await writeFile(path.join(directory, file), contents);
  for (const manager of ['npm', 'yarn', 'pnpm'])
    await writeFile(
      path.join(binary, manager),
      `#!/bin/sh\nprintf '%s\\n' '${manager}' >> "$F189_TOOL_LOG"\n${binaries[manager] ?? 'exit 126\n'}`,
      { mode: 0o755 },
    );
  const log = path.join(directory, 'commands.log');
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', toolchainProbeCommand('')], {
    cwd: directory,
    env: { ...process.env, PATH: `${binary}:${process.env.PATH}`, F189_TOOL_LOG: log },
  });
  const actual = parseToolchainObservation(stdout);
  assert.ok(actual);
  const calls = await readFile(log, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  });
  return { actual, calls: calls.trim().split('\n').filter(Boolean) };
}

test('an npm lockfile repo is admitted with broken irrelevant Yarn and pnpm shims', async (t) => {
  const { actual, calls } = await probeProject(
    t,
    {
      'package.json': JSON.stringify({ engines: { node: '>=22', npm: '>=10' } }),
      'package-lock.json': '{}',
    },
    { npm: managerScripts.npm },
  );
  assert.equal(checkToolchainObservation(actual, 'terminal-slot').status, 'verified');
  assert.equal(actual.packageManager, 'npm');
  assert.deepEqual(calls, ['npm']);
  assert.equal(actual.tools.packageManagerNode.version, process.versions.node);
});

for (const [manager, version] of [
  ['npm', '10.9.3'],
  ['yarn', '4.14.1'],
  ['pnpm', '10.0.0'],
]) {
  test(`packageManager selects ${manager} ahead of conflicting lockfiles`, async (t) => {
    const { actual, calls } = await probeProject(
      t,
      {
        'package.json': JSON.stringify({ packageManager: `${manager}@${version}` }),
        'package-lock.json': '{}',
        'yarn.lock': '',
        'pnpm-lock.yaml': '',
      },
      managerScripts,
    );
    assert.equal(checkToolchainObservation(actual, 'slot').status, 'verified');
    assert.equal(actual.packageManager, manager);
    assert.ok(calls.length > 0 && calls.every((call) => call === manager));
  });
}

for (const [lock, manager] of [
  ['yarn.lock', 'yarn'],
  ['pnpm-lock.yaml', 'pnpm'],
]) {
  test(`${lock} selects ${manager} without a packageManager field`, async (t) => {
    const { actual, calls } = await probeProject(
      t,
      { 'package.json': '{}', [lock]: '' },
      managerScripts,
    );
    assert.equal(checkToolchainObservation(actual, 'slot').status, 'verified');
    assert.equal(actual.packageManager, manager);
    assert.ok(calls.every((call) => call === manager));
  });
}

test('Node-only repos do not invent a package-manager requirement', async (t) => {
  const { actual, calls } = await probeProject(t, {}, {});
  assert.equal(checkToolchainObservation(actual, 'slot').status, 'verified');
  assert.equal(actual.packageManager, null);
  assert.deepEqual(calls, []);
});

test('a failed selected npm command still refuses launch', async (t) => {
  const { actual } = await probeProject(t, { 'package-lock.json': '{}' }, {});
  const result = checkToolchainObservation(actual, 'slot');
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /npmNode exited 126/);
});

test('valid override Node with an older Yarn child is refused and names the exact cause', () => {
  const value = observation();
  value.tools.packageManagerNode = { version: 'v24.13.0' };
  const result = checkToolchainObservation(value, 'fixture-slot');
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /yarnNode resolved v24.13.0; expected v24.22.1 from .nvmrc/);
});

test('declared Ruby mismatch refuses; an undeclared Ruby is never required', () => {
  const value = observation();
  assert.equal(checkToolchainObservation(value, 'slot').status, 'verified');
  value.requirements.push({ tool: 'ruby', range: '3.3.1', source: 'selected pack toolchain pins' });
  value.tools.ruby = { version: '3.2.2' };
  assert.equal(checkToolchainObservation(value, 'slot').status, 'mismatch');
});

test('a conflicting pack pin is observed even when product engines permit the runtime', () => {
  const value = observation();
  value.requirements.push({
    tool: 'node',
    range: '24.13.0',
    source: 'selected pack toolchain pins',
  });
  assert.match(
    checkToolchainObservation(value, 'slot').detail,
    /expected 24.13.0 from selected pack/,
  );
});

test('missing tools are observed mismatches, failed observations remain unverified', () => {
  const value = observation();
  value.tools.packageManagerNode = { unavailable: 'transport timed out' };
  assert.equal(checkToolchainObservation(value, 'slot').status, 'unverified');
  value.tools.packageManagerNode = { missing: true };
  assert.equal(checkToolchainObservation(value, 'slot').status, 'mismatch');
});

test('an executable Yarn shim exiting 126 blocks launch under the pinned Node', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'launch-broken-yarn-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'bin');
  await mkdir(binary);
  await writeFile(path.join(directory, '.nvmrc'), process.version);
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ packageManager: 'yarn@4.14.1' }),
  );
  await writeFile(path.join(binary, 'yarn'), '#!/bin/sh\nexit 126\n', { mode: 0o755 });
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', toolchainProbeCommand('')], {
    cwd: directory,
    env: { ...process.env, PATH: `${binary}:${process.env.PATH}` },
  });
  const actual = parseToolchainObservation(stdout);
  assert.ok(actual);
  assert.equal(actual.tools.packageManager.exitCode, 126);
  assert.equal(actual.tools.packageManagerNode.exitCode, 126);
  const result = checkToolchainObservation(actual, 'core-slot');
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /core-slot yarnNode exited 126.*\.nvmrc.*selected pack setup/);
});

test('a successful Yarn version does not admit a failed Yarn child Node', () => {
  const value = observation();
  value.tools.packageManagerNode = { unavailable: 'probe exited 126', exitCode: 126 };
  const parsed = parseToolchainObservation(JSON.stringify(value));
  assert.ok(parsed);
  assert.equal(checkToolchainObservation(parsed, 'core-slot').status, 'mismatch');
});

test('no Yarn version is invented when only Node is declared', () => {
  const value = observation();
  value.requirements = value.requirements.filter((entry) => entry.tool !== 'yarn');
  value.tools.packageManager = { version: 'unversioned' };
  assert.equal(checkToolchainObservation(value, 'slot').status, 'verified');
});

test('unknown aliases and noisy observations stay unverified', () => {
  const value = observation();
  value.requirements[0].range = 'lts/latest';
  assert.equal(checkToolchainObservation(value, 'slot').status, 'unverified');
  value.tools.node = { version: 'tool not ready' };
  assert.equal(checkToolchainObservation(value, 'slot').status, 'unverified');
});

test('malformed probe responses are not accepted as typed observations', () => {
  assert.equal(parseToolchainObservation('{"requirements":[{}],"tools":{}}'), undefined);
  const value = observation();
  assert.deepEqual(parseToolchainObservation(JSON.stringify(value)), value);
});

test('an unbound current pack never overrides a retained checkout declaration', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'launch-pack-declaration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, '.tool-versions'), 'nodejs 24.22.1\n');
  assert.equal(await readLaunchPackPins({ fixturesDir: directory, bound: false }), null);
  assert.equal(
    await readLaunchPackPins({ fixturesDir: directory, bound: true }),
    'nodejs 24.22.1\n',
  );
  const retained: ToolchainObservation = {
    packageManager: null,
    requirements: [{ tool: 'node', range: '24.13.0', source: '.nvmrc' }],
    tools: {
      node: { version: 'v24.13.0' },
      packageManager: {},
      packageManagerNode: { version: 'v24.13.0' },
      ruby: {},
    },
  };
  const result = checkToolchainObservation(retained, 'retained-slot', false);
  assert.equal(result.status, 'unverified');
  assert.match(result.detail, /Product toolchains match.*no bound pack/);
});

test('a product Ruby file does not invent a pack Ruby requirement', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'launch-node-only-pack-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, '.ruby-version'), '9.9.9\n');
  const result = await promisify(execFile)('/bin/sh', ['-c', toolchainProbeCommand('')], {
    cwd: directory,
  });
  const actual = parseToolchainObservation(result.stdout);
  assert.ok(actual);
  assert.equal(
    actual.requirements.some((entry) => entry.tool === 'ruby'),
    false,
  );
  assert.deepEqual(actual.tools.ruby, {});
});
