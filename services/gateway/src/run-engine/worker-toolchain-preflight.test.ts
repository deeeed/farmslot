import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
    requirements: [
      { tool: 'node', range: 'v24.22.1', source: '.nvmrc' },
      { tool: 'node', range: '>=24.13.0', source: 'engines.node' },
      { tool: 'yarn', range: '^4.14.1', source: 'engines.yarn' },
    ],
    tools: {
      node: { version: 'v24.22.1' },
      yarn: { version: '4.14.1' },
      yarnNode: { version: 'v24.22.1' },
      ruby: {},
    },
  };
}

test('valid override Node with an older Yarn child is refused and names the exact cause', () => {
  const value = observation();
  value.tools.yarnNode = { version: 'v24.13.0' };
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
  value.tools.yarnNode = { unavailable: 'transport timed out' };
  assert.equal(checkToolchainObservation(value, 'slot').status, 'unverified');
  value.tools.yarnNode = { missing: true };
  assert.equal(checkToolchainObservation(value, 'slot').status, 'mismatch');
});

test('an executable Yarn shim exiting 126 blocks launch under the pinned Node', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'launch-broken-yarn-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'bin');
  await mkdir(binary);
  await writeFile(path.join(directory, '.nvmrc'), process.version);
  await writeFile(path.join(binary, 'yarn'), '#!/bin/sh\nexit 126\n', { mode: 0o755 });
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', toolchainProbeCommand('')], {
    cwd: directory,
    env: { ...process.env, PATH: `${binary}:${process.env.PATH}` },
  });
  const actual = parseToolchainObservation(stdout);
  assert.ok(actual);
  assert.equal(actual.tools.yarn.exitCode, 126);
  assert.equal(actual.tools.yarnNode.exitCode, 126);
  const result = checkToolchainObservation(actual, 'core-slot');
  assert.equal(result.status, 'mismatch');
  assert.match(result.detail, /core-slot yarnNode exited 126.*\.nvmrc.*selected pack setup/);
});

test('a successful Yarn version does not admit a failed Yarn child Node', () => {
  const value = observation();
  value.tools.yarnNode = { unavailable: 'probe exited 126', exitCode: 126 };
  const parsed = parseToolchainObservation(JSON.stringify(value));
  assert.ok(parsed);
  assert.equal(checkToolchainObservation(parsed, 'core-slot').status, 'mismatch');
});

test('no Yarn version is invented when only Node is declared', () => {
  const value = observation();
  value.requirements = value.requirements.filter((entry) => entry.tool !== 'yarn');
  value.tools.yarn = { version: 'unversioned' };
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
    requirements: [{ tool: 'node', range: '24.13.0', source: '.nvmrc' }],
    tools: { node: { version: 'v24.13.0' }, yarn: {}, yarnNode: { version: 'v24.13.0' }, ruby: {} },
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
