import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Command } from 'commander';

import { farmPathEntries, resolveFarmPaths } from '@farmslot/protocol/node/farm-paths';

import { OutputContext } from '../output.js';

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
  const started = performance.now();
  t.after(() =>
    assert.ok(performance.now() - started < 5_000, 'CLI paths test must finish under 5 s'),
  );
  const root = mkdtempSync(path.join(tmpdir(), 'cli-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'instance');
  const envHome = path.join(root, 'env-instance');
  for (const dir of [home, envHome]) {
    mkdirSync(path.join(dir, 'config'), { recursive: true });
    writeFileSync(path.join(dir, 'config/instance.json'), '{"layout":2}');
  }
  const previousEnv = process.env;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('FARMSLOT_')) delete env[key];
  Object.assign(env, { HOME: root, FARMSLOT_HOME: envHome });
  process.env = env;
  t.after(() => {
    process.env = previousEnv;
  });
  let stdout = '';
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  // Exercise the registered Commander actions in-process; entry.ts's unrelated
  // command graph used to be started once for every lookup.
  const run = (...args: string[]) => {
    stdout = '';
    let stderr = '';
    const program = new Command()
      .option('--json')
      .exitOverride()
      .configureOutput({
        writeOut: (text) => {
          stdout += text;
        },
        writeErr: (text) => {
          stderr += text;
        },
      });
    registerPathsCommand(program);
    try {
      program.parse(args, { from: 'user' });
      return { status: 0, stdout, stderr };
    } catch (error) {
      return { status: 1, stdout, stderr: stderr + String(error) };
    }
  };
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
  assert.deepEqual(rows, farmPathEntries(resolveFarmPaths({ home, role: 'node', env: {} })));
  assert.equal(
    Object.keys(outputPaths).length,
    farmPathEntries(resolveFarmPaths({ home, role: 'node', env: {} })).length,
  );
  const get = run('paths', 'get', 'data.runBundles', '--home', home, '--role', 'node');
  assert.equal(get.status, 0, get.stderr);
  assert.equal(get.stdout, `${path.join(home, 'data/run-bundles')}\n`);
  const getJson = run('--json', 'paths', '--home', home, 'get', 'state.gatewayLock');
  assert.equal(getJson.status, 0, getJson.stderr);
  assert.equal(JSON.parse(getJson.stdout), path.join(home, 'state/gateway.lock'));
  const defaultHome = run('paths', 'get', 'home');
  assert.equal(defaultHome.status, 0, defaultHome.stderr);
  assert.equal(defaultHome.stdout, `${envHome}\n`);
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

test('plain paths get reports a legacy configured store outside the farm home', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'cli-paired-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const storeRoot = path.join(root, 'volume-store');
  mkdirSync(home);
  writeFileSync(
    path.join(home, 'run-bundle-retention.json'),
    JSON.stringify({ runBundleRetention: { storeRoot } }),
  );
  let stdout = '';
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  const program = new Command().option('--json').exitOverride();
  registerPathsCommand(program);
  program.parse(['paths', '--home', home, 'get', 'data.runBundles'], { from: 'user' });
  assert.equal(stdout, `${storeRoot}\n`);
});

test('migrate CLI requires one mode and returns reviewable JSON without file contents', async (t) => {
  const started = performance.now();
  t.after(() => assert.ok(performance.now() - started < 5000));
  const root = mkdtempSync(path.join(tmpdir(), 'migrate-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The resolver rejects redirected migration paths, including macOS /var aliases.
  const { realpathSync } = await import('node:fs');
  const home = realpathSync(root);
  writeFileSync(
    path.join(home, 'sources.json'),
    JSON.stringify({ path: path.join(home, 'sources') }),
  );
  const prior = process.env;
  process.env = {
    HOME: home,
    FARMSLOT_ROOT: path.join(home, 'checkout'),
    CANARY_HOME: path.join(home, 'canary'),
  };
  t.after(() => {
    process.env = prior;
  });
  let stdout = '';
  t.mock.method(OutputContext.prototype, 'writeJson', (value: unknown) => {
    stdout = JSON.stringify(value);
  });
  const program = () => {
    const command = new Command().option('--json').exitOverride();
    registerPathsCommand(command);
    return command;
  };
  await program().parseAsync(['paths', 'migrate', '--home', home, '--plan', '--json'], {
    from: 'user',
  });
  const result: { steps: { kind: string; body?: string; before?: string; target: string }[] } =
    JSON.parse(stdout);
  assert.ok(
    result.steps.some((step) => step.kind === 'write' && step.target.endsWith('sources.json')),
  );
  assert.ok(result.steps.every((step) => step.body === undefined && step.before === undefined));
  await assert.rejects(
    program().parseAsync(['paths', 'migrate', '--home', home, '--plan', '--apply'], {
      from: 'user',
    }),
    /exactly one/,
  );
});
