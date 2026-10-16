import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  inspectProviderCli,
  installProviderCli,
  poolProviderRoots,
  type ProviderCliRunner,
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
