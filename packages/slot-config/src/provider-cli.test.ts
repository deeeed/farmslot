import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  inspectProviderCli,
  installProviderCli,
  poolProviderRoots,
  type ProviderCliRunner,
  providerShellPath,
} from './provider-cli.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'provider-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'pinned');
  const current = path.join(directory, 'global');
  const stale = path.join(directory, 'stale');
  const priorPath = process.env.PATH;
  process.env.PATH = current;
  t.after(() => {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  });
  for (const bin of [root, current, stale]) {
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'fixture-tool'), '#!/bin/sh\n', { mode: 0o755 });
  }
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@fixture/provider',
      version: '1.2.3',
      bin: { 'fixture-tool': 'fixture-tool' },
    }),
  );
  const versions = new Map([
    [root, '1.2.3'],
    [current, '1.2.3'],
    [stale, '1.0.0'],
  ]);
  let sshPath = current;
  const calls: Array<{ executable: string; args: string[]; timeout?: number }> = [];
  const runner: ProviderCliRunner = async (executable, args, env, timeout) => {
    calls.push({ executable, args, timeout });
    if (args.at(-1)?.includes('FARMSLOT_PROVIDER_PATH')) {
      const selected = args[0] === '-c' ? sshPath : current;
      return `profile chatter\0FARMSLOT_PROVIDER_PATH\0${selected}\0`;
    }
    if (executable === 'npm') return '';
    if (path.dirname(executable) === stale) assert.equal(env.PATH, sshPath);
    assert.equal(env.MM_HARNESS_BIN, undefined);
    assert.equal(env.MM_HARNESS_PACKAGE_ROOT, undefined);
    return versions.get(path.dirname(executable)) + '\n';
  };
  return {
    directory,
    root,
    current,
    stale,
    calls,
    versions,
    runner,
    sshPath: (value: string) => {
      sshPath = value;
    },
  };
}

test('health reports an older executable hidden later on non-interactive SSH PATH', async (t) => {
  const f = await fixture(t);
  f.sshPath([f.current, f.stale].join(path.delimiter));
  const health = await inspectProviderCli(f.root, f.runner);
  assert.equal(health.ok, false);
  assert.match(health.reason ?? '', /non-interactive fixture-tool: 1.0.0, expected 1.2.3/);
  assert(health.binaries.some((bin) => bin.path === path.join(f.stale, 'fixture-tool')));
});

test('health detects SSH drift even when node/login resolution is current', async (t) => {
  const f = await fixture(t);
  f.sshPath(f.stale);
  const health = await inspectProviderCli(f.root, f.runner);
  assert.equal(health.ok, false);
  assert(
    health.binaries
      .filter((bin) => bin.scope !== 'non-interactive' && bin.scope !== 'node')
      .every((bin) => bin.version === '1.2.3'),
  );
  assert.match(health.reason ?? '', /non-interactive/);
  assert.equal(health.status, 'version-mismatch');
});

test('a version timeout under load is unverified rather than drift', async (t) => {
  const f = await fixture(t);
  t.mock.method(os, 'loadavg', () => [178, 178, 178]);
  t.mock.method(os, 'availableParallelism', () => 16);
  const health = await inspectProviderCli(f.root, async (file, args, env, timeout) => {
    if (args[0] === '--version') throw new DOMException('deadline expired', 'TimeoutError');
    return f.runner(file, args, env, timeout);
  });
  assert.equal(health.ok, false);
  assert.equal(health.status, 'probe-timeout');
  assert.equal(health.reason, 'Probe timed out under load');
  assert.equal(health.loadAvg1, 178);
});

test('measured drift survives a later version timeout', async (t) => {
  const f = await fixture(t);
  f.sshPath([f.stale, f.current].join(path.delimiter));
  const health = await inspectProviderCli(f.root, async (file, args, env, timeout) => {
    if (path.dirname(file) === f.current && env.PATH?.startsWith(f.stale))
      throw new DOMException('deadline expired', 'TimeoutError');
    return f.runner(file, args, env, timeout);
  });
  assert.equal(health.ok, false);
  assert.equal(health.status, 'version-mismatch');
  assert.match(health.reason ?? '', /1.0.0, expected 1.2.3/);
});

test('rollout installs the exact pinned version but refuses stale PATH read-back', async (t) => {
  const f = await fixture(t);
  f.sshPath(f.stale);
  await assert.rejects(
    installProviderCli(f.root, '/fixture/prefix', f.runner),
    /Provider rollout failed/,
  );
  assert.deepEqual(
    f.calls.find((call) => call.executable === 'npm'),
    {
      executable: 'npm',
      args: ['install', '--global', '--prefix', '/fixture/prefix', '@fixture/provider@1.2.3'],
      timeout: 120_000,
    },
  );
});

test('rollout succeeds only after every declared binary matches the pin', async (t) => {
  const f = await fixture(t);
  assert.equal((await installProviderCli(f.root, undefined, f.runner)).ok, true);
  const pool = path.join(f.directory, 'pool.json');
  await writeFile(
    pool,
    JSON.stringify({
      env: { EXAMPLE_PACKAGE_ROOT: f.root, EXAMPLE_BIN: '/ignored', OTHER: 'value' },
    }),
  );
  assert.deepEqual(await poolProviderRoots(pool), [f.root]);
});

test('SSH defaults cover Linux global npm without changing the macOS baseline', () => {
  assert(providerShellPath('linux').split(path.delimiter).includes('/usr/local/bin'));
  assert.equal(providerShellPath('darwin'), '/usr/bin:/bin:/usr/sbin:/sbin');
});

test('standalone node imports provider health without a Farmslot checkout', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'provider-standalone-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = path.join(directory, 'node_modules/@farmslot/slot-config');
  await mkdir(path.join(installed, 'src'), { recursive: true });
  await writeFile(
    path.join(installed, 'package.json'),
    await readFile(new URL('../package.json', import.meta.url)),
  );
  await copyFile(
    new URL('./provider-cli.ts', import.meta.url),
    path.join(installed, 'src/provider-cli.ts'),
  );
  const resolve = createRequire(path.join(directory, 'consumer.cjs')).resolve;
  const entry = resolve('@farmslot/slot-config/provider-cli');
  const provider = await import(pathToFileURL(entry).href);
  assert.equal(typeof provider.inspectProviderCli, 'function');
  assert.equal(typeof provider.installProviderCli, 'function');
  const pool = path.join(directory, 'pool.json');
  await writeFile(pool, '{}');
  assert.deepEqual(await provider.poolProviderRoots(pool), []);
});
