import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  supportHash,
  supportVerificationProgram,
} from '../../../../scripts/lib/runner-observability-bundle.mjs';
import { runnerRuntimeDir } from '../../../../scripts/lib/runner-runtime.cjs';

import { buildPiLaunch } from './launch-command.js';
import {
  buildRunnerObservabilityInstallCommand,
  withRequiredRunnerInstall,
  withRunnerObservabilityInstall,
} from './runner-observability.js';
import { makeVars } from './test-fixtures.js';

for (const partialSelection of [false, true]) {
  test(`Pi refuses a global installer with ${partialSelection ? 'an incomplete' : 'no'} selected bundle`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pi-bundle-refusal-'));
    try {
      const home = path.join(root, 'home');
      const repo = path.join(root, 'repo');
      const marker = path.join(root, 'legacy-started');
      const installer = path.join(home, 'farmslot-node/scripts/install-runner-observability.mjs');
      mkdirSync(path.dirname(installer), { recursive: true });
      writeFileSync(
        installer,
        `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'used');`,
      );
      if (partialSelection) {
        const hash = 'a'.repeat(64);
        const selected = path.join(home, 'farmslot-node/support', hash, 'scripts');
        mkdirSync(selected, { recursive: true });
        writeFileSync(path.join(selected, 'install-runner-observability.mjs'), '');
        const obs = path.join(runnerRuntimeDir(repo, '.agent'), '.observability');
        mkdirSync(obs, { recursive: true });
        writeFileSync(path.join(obs, 'node-support-hash'), hash + '\n');
      }
      const vars = makeVars({
        remoteRepo: repo,
        repo,
        host: 'remote-fixture-host.local',
        machine: 'remote-fixture-host',
      });
      const command = buildRunnerObservabilityInstallCommand(vars, 'pi', repo);
      const result = spawnSync('/bin/bash', ['-c', command], {
        env: { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
        encoding: 'utf8',
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(marker), false);
      assert.match(result.stderr, /RUNNER_OBSERVABILITY_BUNDLE_(MISSING|MISMATCH)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('Pi keeps failed installation fatal before starting a runner', () => {
  const result = spawnSync(
    '/bin/sh',
    ['-c', withRequiredRunnerInstall('printf started', 'false')],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

test('the shared hash preserves the existing support manifest byte format', () => {
  assert.equal(
    supportHash([
      {
        relativePath: 'scripts/a',
        mode: 0o644,
        contentBase64: Buffer.from('alpha').toString('base64'),
      },
      {
        relativePath: 'scripts/b',
        mode: 0o755,
        contentBase64: Buffer.from('beta').toString('base64'),
      },
    ]),
    '5cdaf88dbba28fd34cd4a3a8476ac5b2f821808730efc0f43cccf3438da0a4fd',
  );
});

test('matching Pi copies start, while stale bytes, modes and identity stop before the runner', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pi-bundle-copy-'));
  try {
    const repo = path.join(root, 'repo'),
      home = path.join(root, 'home');
    mkdirSync(repo);
    mkdirSync(home);
    const source = fileURLToPath(new URL('../../../../', import.meta.url));
    const marker = path.join(root, 'runner-started');
    const fakePi = path.join(root, 'pi');
    writeFileSync(fakePi, `#!/bin/sh\nprintf started > '${marker}'\n`, { mode: 0o755 });
    const env = { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
    const install = buildRunnerObservabilityInstallCommand(
      makeVars({
        remoteRepo: repo,
        repo,
        host: 'remote-fixture-host.local',
        machine: 'remote-fixture-host',
      }),
      'pi',
      repo,
      '.agent',
      {
        supportDir: source,
      },
    );
    execFileSync('/bin/bash', ['-c', install], { env, stdio: 'pipe' });
    const obs = path.join(runnerRuntimeDir(repo, '.agent'), '.observability');
    const manifestPath = path.join(obs, 'install.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.match(manifest.bundleHash, /^[a-f0-9]{64}$/);
    const launch = buildPiLaunch({ repo, binary: fakePi, model: 'fixture/model' });
    const run = () => spawnSync('/bin/bash', ['-c', launch], { env, encoding: 'utf8' });
    const accepted = run();
    assert.ifError(accepted.error);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(readFileSync(marker, 'utf8'), 'started');
    rmSync(marker);
    const provider = path.join(obs, 'bin/pi-farmslot-providers.mjs');
    const bytes = readFileSync(provider);
    for (const mutation of ['bytes', 'mode', 'identity'] as const) {
      if (mutation === 'bytes')
        writeFileSync(provider, Buffer.concat([bytes, Buffer.from('\n// stale copy\n')]));
      if (mutation === 'mode') chmodSync(provider, 0o700);
      if (mutation === 'identity')
        writeFileSync(manifestPath, JSON.stringify({ ...manifest, bundleHash: 'f'.repeat(64) }));
      const refused = run();
      assert.ifError(refused.error);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /RUNNER_OBSERVABILITY_BUNDLE_MISMATCH/);
      assert.equal(existsSync(marker), false);
      writeFileSync(provider, bytes);
      chmodSync(provider, 0o644);
      writeFileSync(manifestPath, JSON.stringify(manifest));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the serialized verifier resolves a source-bound node home on that node', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'runner-bundle-home-'));
  try {
    mkdirSync(path.join(home, 'bundle'));
    writeFileSync(path.join(home, 'bundle/code.mjs'), 'fixture');
    const program =
      supportVerificationProgram() +
      `verifySupportBundle('~/bundle',undefined,[{relativePath:'code.mjs'}]).then(value=>console.log(value.hash)).catch(error=>{console.error(error.message);process.exitCode=1;});`;
    const result = spawnSync(process.execPath, ['-e', program], {
      env: { HOME: home },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^[a-f0-9]{64}$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const exitCode of [1, 78]) {
  test(`optional hook wrapper ${exitCode === 78 ? 'refuses identity errors' : 'preserves ordinary fallback'}`, () => {
    const command = withRunnerObservabilityInstall(
      'printf started',
      `/bin/sh -c 'exit ${exitCode}'`,
    );
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, exitCode === 78 ? 78 : 0);
    assert.equal(result.stdout, exitCode === 78 ? '' : 'started');
  });
}
