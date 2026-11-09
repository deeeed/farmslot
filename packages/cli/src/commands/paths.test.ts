import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveFarmPaths } from '@farmslot/protocol/node/farm-paths';
import { Command } from 'commander';

import { registerPathsCommand } from './paths.js';

test('paths is registered with the standard global JSON flag and role choices', () => {
  const program = new Command().option('--json');
  registerPathsCommand(program);
  const paths = program.commands.find((command) => command.name() === 'paths');
  assert.ok(paths);
  assert.equal(paths.commands[0].name(), 'get');
  const role = paths.options.find((option) => option.long === '--role');
  assert.deepEqual(role?.argChoices, ['gateway', 'node']);
});

test('CLI paths reports JSON, tab-separated paths and dot-key lookups without writes', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'cli-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'instance');
  const envHome = path.join(root, 'env-instance');
  for (const dir of [home, envHome]) {
    mkdirSync(path.join(dir, 'config'), { recursive: true });
    writeFileSync(path.join(dir, 'config/instance.json'), '{"layout":2}');
  }
  // Run the actual entry point, including command registration and checkout-env bootstrapping.
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const checkout = path.join(root, 'checkout');
  for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
    const file = path.join(checkout, marker);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, marker.endsWith('.json') ? '{}' : '');
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('FARMSLOT_')) delete env[key];
  Object.assign(env, {
    HOME: root,
    FARMSLOT_HOME: envHome,
    FARMSLOT_WORKSPACE: path.join(root, 'workspace'),
    FARMSLOT_ROOT: checkout,
    TSX_TSCONFIG_PATH: path.join(repo, 'packages/cli/tsconfig.json'),
  });
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        path.join(repo, 'packages/cli/src/entry.ts'),
        ...args,
      ],
      {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
  const before = readdirSync(root, { recursive: true });
  const json = run('paths', '--json', '--home', home, '--role', 'gateway');
  assert.equal(json.status, 0, `${json.stderr}\n${json.stdout}`);
  assert.deepEqual(JSON.parse(json.stdout), resolveFarmPaths({ home, role: 'gateway', env: {} }));
  const plain = run('paths', '--home', home, '--role', 'node');
  assert.equal(plain.status, 0, plain.stderr);
  const rows = plain.stdout
    .trimEnd()
    .split('\n')
    .map((line) => line.split('\t'));
  assert.ok(rows.every((row) => row.length === 2 && path.isAbsolute(row[1])));
  const outputPaths = Object.fromEntries(rows);
  assert.equal(outputPaths['data.runBundles'], path.join(home, 'data/run-bundles'));
  assert.equal(outputPaths['state.backlog'], undefined);
  assert.equal(outputPaths.layout, undefined);
  assert.equal(outputPaths.instance, undefined);
  assert.equal(Object.keys(outputPaths).length, 25);
  const get = run('paths', 'get', 'data.runBundles', '--home', home, '--role', 'node');
  assert.equal(get.status, 0, get.stderr);
  assert.equal(get.stdout, `data.runBundles\t${path.join(home, 'data/run-bundles')}\n`);
  const getJson = run('--json', 'paths', '--home', home, 'get', 'state.gatewayLock');
  assert.equal(getJson.status, 0, getJson.stderr);
  assert.equal(JSON.parse(getJson.stdout), path.join(home, 'state/gateway.lock'));
  const defaultHome = run('paths', 'get', 'home');
  assert.equal(defaultHome.status, 0, defaultHome.stderr);
  assert.equal(defaultHome.stdout, `home\t${envHome}\n`);
  for (const key of ['data', 'missing.path', 'instance', '__proto__', 'code.toString']) {
    const missing = run('paths', 'get', key, '--home', home);
    assert.equal(missing.status, 1, missing.stdout);
    assert.match(missing.stdout + missing.stderr, /Unknown farm path key/);
  }
  const invalidRole = run('paths', '--home', home, '--role', 'worker');
  assert.equal(invalidRole.status, 1);
  assert.match(invalidRole.stderr, /Allowed choices are gateway, node/);
  assert.deepEqual(readdirSync(root, { recursive: true }), before);
});
