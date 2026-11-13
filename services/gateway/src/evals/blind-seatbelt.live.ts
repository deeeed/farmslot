// Manual macOS proof only. Every tmux command selects a private fixture socket.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { shSingleQuote as q } from '../../../../scripts/lib/shell-quote.mjs';
import { buildLaunchCommand, buildRunnerSessionReloadCommand } from '../runners/launch-command.js';
import { getRunnerDefinition } from '../runners/registry.js';
import { makeVars } from '../runners/test-fixtures.js';

import { type BlindGitSpec, buildBlindGitCommand, withBlindTrialBoundary } from './blind-git.js';

const python = fileURLToPath(new URL('./blind-git.py', import.meta.url));
const adapter = fileURLToPath(new URL('../../../../packages/adapter-web/', import.meta.url));
const { stopWebDappBrowser } = await import(path.join(adapter, 'src/web-dapp/lib/processes.mjs'));
const syntheticHome = realpathSync(mkdtempSync(path.join(os.homedir(), '.seatbelt-home-')));
after(() => rmSync(syntheticHome, { recursive: true }));
const allocatedTempRoots = new Set<string>();
after(() => {
  for (const root of allocatedTempRoots) rmSync(root, { recursive: true, force: true });
});
const env = {
  PATH: process.env.PATH,
  HOME: syntheticHome,
  TMPDIR: os.tmpdir(),
  TMUX_TMPDIR: process.env.TMUX_TMPDIR,
  PYTHONDONTWRITEBYTECODE: '1',
};
const fixtureCapsules = new Map<string, string>();

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(syntheticHome, 'blind-seatbelt-live-')));
  const capsule = path.join(root, '.farmslot-blind-evals/fixture/run-epoch');
  fixtureCapsules.set(root, capsule);
  mkdirSync(path.join(capsule, 'boundary'), { recursive: true });
  writeFileSync(path.join(capsule, 'state.json'), '{"originalIsDirectory":true}');
  // Keep probe paths stable while using a separate checkout and capsule, as in production.
  symlinkSync(path.join(capsule, 'boundary'), path.join(root, 'boundary'));
  symlinkSync(path.join(capsule, 'state.json'), path.join(root, 'state.json'));
  writeFileSync(
    path.join(root, 'owned-cleanup.mjs'),
    `
export function ownCleanup(parent, stop) {
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= Promise.resolve().then(async () => {
    clearInterval(watchdog);
    await stop();
  });
  const shutdown = () => { void cleanup().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  const watchdog = setInterval(() => {
    try { process.kill(parent, 0); }
    catch (error) { if (error.code !== 'ESRCH') throw error; shutdown(); }
  }, 100);
  return cleanup;
}
`,
  );
  return root;
}
function profile(
  root: string,
  launchEnv: NodeJS.ProcessEnv = env,
  slotResourcePorts: Record<string, number> = {},
) {
  execFileSync(
    'python3',
    [
      '-c',
      `
import json, pathlib, runpy, sys
blind = runpy.run_path(sys.argv[1], run_name='fixture')
root = pathlib.Path(sys.argv[2])
blind['prepare_boundary']({'repo': str(root), 'siblingRepos': [str(root / 'hidden')], 'slotResourcePorts': json.loads(sys.argv[3])}, pathlib.Path(sys.argv[4]))
`,
      python,
      root,
      JSON.stringify(slotResourcePorts),
      fixtureCapsules.get(root) ?? root,
    ],
    { env: launchEnv, encoding: 'utf8', timeout: 10_000 },
  );
  const temporary = path.join(root, 'boundary/tmp');
  if (existsSync(temporary)) allocatedTempRoots.add(realpathSync(temporary));
}
function worker(
  root: string,
  command: string,
  launchEnv: NodeJS.ProcessEnv = env,
  timeout = 45_000,
  modelEnvironment: readonly string[] = [],
) {
  return spawnSync(
    '/bin/sh',
    [
      '-c',
      withBlindTrialBoundary(
        command,
        {
          capsule: fixtureCapsules.get(root) ?? root,
          baseSha: 'a'.repeat(40),
          browserCdpPort: JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8'))
            .browserCdpPort,
        },
        modelEnvironment,
      ).replace('/usr/bin/env -i', 'exec /usr/bin/env -i'),
    ],
    {
      env: launchEnv,
      encoding: 'utf8',
      timeout,
    },
  );
}

test(
  'blind worker cannot mutate capsule journals, stores, siblings or ancestors while checkout and logs stay writable',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true }));
    const repo = path.join(root, 'checkout');
    mkdirSync(repo);
    const gitEnv = { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { env: gitEnv, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(repo, 'value'), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const capsule = path.join(root, '.farmslot-blind-evals/slot/run-epoch');
    const spec: BlindGitSpec = {
      repo,
      capsule,
      slotId: 'slot',
      slotEpoch: 1,
      runId: 'run',
      branch: 'eval/run',
      baseSha: git('rev-parse', 'HEAD'),
      referenceCommits: [],
      siblingRepos: [path.join(root, 'other/checkout')],
    };
    for (const action of ['isolate', 'boundary'] as const)
      execFileSync('/bin/sh', ['-c', buildBlindGitCommand(action, spec)], {
        env: gitEnv,
        encoding: 'utf8',
        timeout: 10_000,
      });
    allocatedTempRoots.add(realpathSync(path.join(capsule, 'boundary/tmp')));
    const targets = [
      path.join(capsule, 'state.json'),
      path.join(capsule, 'original.entry/config'),
      path.join(capsule, 'prepared.git/config'),
      path.join(capsule, 'candidate.git/config'),
      path.join(capsule, 'boundary/gh-config/config'),
      path.join(root, '.farmslot-blind-evals/slot/other-run/state.json'),
      path.join(root, '.farmslot-blind-evals/sibling/run/state.json'),
      path.join(root, 'other/.farmslot-blind-evals/sibling/run/state.json'),
    ];
    for (const target of targets) {
      mkdirSync(path.dirname(target), { recursive: true });
      if (!existsSync(target)) writeFileSync(target, 'synthetic retained store');
    }
    const saved = targets.map((target) => readFileSync(target));
    const alias = path.join(repo, 'capsule-alias');
    symlinkSync(capsule, alias);
    const aliases = [...targets, path.join(alias, 'state.json')];
    const routing = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'capsule-alias-')));
    t.after(() => rmSync(routing, { recursive: true }));
    symlinkSync(capsule, path.join(routing, 'capsule'));
    aliases.push(path.join(routing, 'capsule/state.json'));
    // Exercise both spellings of the macOS /var or /tmp alias, independent of TMPDIR.
    for (const target of [...targets, path.join(routing, 'capsule/state.json')])
      if (/^\/private\/(var|tmp)\//u.test(target)) aliases.push(target.slice('/private'.length));

    await t.test('boundary logs, private temp and normal checkout Git writes succeed', () => {
      const result = worker(
        capsule,
        `exec ${q(process.execPath)} --input-type=module -e ${q(`
import assert from 'node:assert/strict'; import * as fs from 'node:fs'; import { execFileSync } from 'node:child_process';
const repo = ${JSON.stringify(repo)};
for (const name of ['attempts.log', 'git-trace.jsonl'])
  fs.appendFileSync(${JSON.stringify(capsule)} + '/boundary/' + name, 'synthetic log\\n');
fs.writeFileSync(process.env.TMPDIR + '/worker-file', 'synthetic temp');
fs.writeFileSync(repo + '/value', 'candidate\\n');
for (const args of [['add', 'value'], ['commit', '-qm', 'candidate'], ['status', '--porcelain']])
  execFileSync('git', ['-C', repo, ...args]);
assert.equal(fs.readFileSync(repo + '/value', 'utf8'), 'candidate\\n');
`)}`,
        gitEnv,
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      for (const name of ['attempts.log', 'git-trace.jsonl'])
        assert.match(readFileSync(path.join(capsule, 'boundary', name), 'utf8'), /synthetic log/u);
      assert.equal(git('log', '-1', '--format=%s'), 'candidate');
    });

    for (const operation of [
      'write',
      'append',
      'create',
      'rename-in',
      'rename-out',
      'unlink',
      'link-in',
      'link-out',
      'symlink',
    ])
      await t.test(`${operation} is denied for every capsule target and alias`, () => {
        const incoming = path.join(repo, 'incoming');
        writeFileSync(incoming, 'synthetic replacement');
        const result = worker(
          capsule,
          `exec ${q(process.execPath)} --input-type=module -e ${q(`
import * as fs from 'node:fs';
const results = [];
for (const [index, target] of ${JSON.stringify(aliases)}.entries()) {
  const outgoing = ${JSON.stringify(repo)} + '/outgoing-' + index;
  try {
    switch (${JSON.stringify(operation)}) {
      case 'write': fs.writeFileSync(target, 'tampered'); break;
      case 'append': fs.appendFileSync(target, 'tampered'); break;
      case 'create': fs.writeFileSync(target + '.new', 'tampered'); break;
      case 'rename-in': fs.renameSync(${JSON.stringify(incoming)}, target); break;
      case 'rename-out': fs.renameSync(target, outgoing); break;
      case 'unlink': fs.unlinkSync(target); break;
      case 'link-in': fs.linkSync(${JSON.stringify(incoming)}, target + '.link'); break;
      case 'link-out': fs.linkSync(target, outgoing); break;
      case 'symlink': fs.symlinkSync(${JSON.stringify(incoming)}, target + '.symlink'); break;
    }
    results.push('ALLOWED');
  } catch (error) { results.push(error.code); }
}
console.log(JSON.stringify(results));
`)}`,
          gitEnv,
        );
        // Reset outside Seatbelt so every attack also runs independently on the vulnerable profile.
        for (const [index, target] of targets.entries()) writeFileSync(target, saved[index]);
        for (const target of targets)
          for (const suffix of ['.new', '.link', '.symlink'])
            rmSync(target + suffix, { force: true });
        for (const index of aliases.keys())
          rmSync(path.join(repo, 'outgoing-' + index), { force: true });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        const outcomes: string[] = JSON.parse(result.stdout);
        for (const [index, outcome] of outcomes.entries())
          assert.equal(outcome, 'EPERM', `${operation}: ${aliases[index]}`);
      });

    for (const directory of [
      capsule,
      path.dirname(capsule),
      path.dirname(path.dirname(capsule)),
      path.join(root, 'other/.farmslot-blind-evals'),
      path.join(root, 'other'),
      root,
    ])
      await t.test(
        `ancestor rename is denied: ${path.relative(root, directory) || 'fixture root'}`,
        () => {
          const moved = directory + '-moved';
          const result = worker(
            capsule,
            `exec ${q(process.execPath)} --input-type=module -e ${q(`
import assert from 'node:assert/strict'; import { renameSync } from 'node:fs';
assert.throws(() => renameSync(${JSON.stringify(directory)}, ${JSON.stringify(moved)}), { code: 'EPERM' });
`)}`,
            gitEnv,
          );
          if (existsSync(moved)) renameSync(moved, directory);
          assert.ifError(result.error);
          assert.equal(result.status, 0, result.stderr);
        },
      );
  },
);

test(
  'directory imports cannot acquire broker connect access under the real blind wrapper',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true }));
    profile(root);
    for (const destination of ['temp', 'broker']) {
      const source = path.join(root, destination + '-run');
      mkdirSync(source);
      const server = net.createServer((socket) => socket.destroy());
      t.after(
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      );
      server.listen(path.join(source, 'control.sock'));
      await once(server, 'listening');
      await t.test(`home directory into ${destination} cannot connect`, () => {
        const result = worker(
          root,
          `exec ${q(process.execPath)} --input-type=module -e ${q(`
import assert from 'node:assert/strict'; import * as fs from 'node:fs'; import net from 'node:net';
const source = ${JSON.stringify(source)};
const target = (${JSON.stringify(destination)} === 'broker'
  ? process.env.FARMSLOT_BLIND_BROKER_DIR : process.env.TMPDIR) + '/imported';
let relocationError;
try { fs.renameSync(source, target); } catch (error) { relocationError = error; }
const error = await new Promise(resolve => net.connect(target + '/control.sock')
  .on('error', resolve).on('connect', () => { throw Error('imported directory socket connected'); }));
if (${JSON.stringify(destination)} === 'broker') assert.equal(relocationError?.code, 'EPERM');
else assert.equal(relocationError, undefined, 'general temp import must reach the connect check');
assert.equal(error.code, ${JSON.stringify(destination)} === 'broker' ? 'ENOENT' : 'EPERM');
// A directory moved into general temp must not provide a second-step socket import.
if (!relocationError) for (const operation of ['renameSync', 'linkSync']) {
  const socket = process.env.FARMSLOT_BLIND_BROKER_DIR + '/' + operation + '.sock';
  assert.throws(() => fs[operation](target + '/control.sock', socket), { code: 'EPERM' });
}
`)}`,
        );
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
      });
    }
    // Seed an otherwise forbidden nested directory outside Seatbelt to prove
    // that the connect filter itself admits only direct broker children.
    const nested = path.join(root, 'boundary/tmp/broker/nested');
    mkdirSync(nested);
    const nestedServer = net.createServer((socket) => socket.destroy());
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          nestedServer.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    nestedServer.listen(path.join(nested, 'control.sock'));
    await once(nestedServer, 'listening');
    await t.test('nested broker socket cannot connect', () => {
      const result = worker(
        root,
        `exec ${q(process.execPath)} --input-type=module -e ${q(`
import assert from 'node:assert/strict'; import net from 'node:net';
const error = await new Promise(resolve => net.connect(process.env.FARMSLOT_BLIND_BROKER_DIR + '/nested/control.sock')
  .on('error', resolve).on('connect', () => { throw Error('nested broker socket connected'); }));
assert.equal(error.code, 'EPERM');
`)}`,
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    });
  },
);

test(
  'lookalike capsule directory import is refused while the own broker connects',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true }));
    const capsule = path.join(root, '.farmslot-blind-evals/slot/run-epoch');
    mkdirSync(path.join(capsule, 'boundary'), { recursive: true });
    writeFileSync(path.join(capsule, 'state.json'), '{"originalIsDirectory":true}');
    profile(capsule);
    const source = path.join(root, 'run');
    mkdirSync(source);
    const ownBroker = path.join(realpathSync(path.join(capsule, 'boundary/tmp')), 'broker');
    const servers = [path.join(source, 'control.sock'), path.join(ownBroker, 'own.sock')].map(
      (socketPath) => {
        const server = net.createServer((socket) => socket.destroy());
        t.after(
          () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        );
        server.listen(socketPath);
        return server;
      },
    );
    await Promise.all(servers.map((server) => once(server, 'listening')));
    const run = (source: string) => {
      const result = worker(
        capsule,
        `exec ${q(process.execPath)} --input-type=module -e ${q(source)}`,
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    };
    await t.test('own physical and /tmp alias broker connects', () =>
      run(`
import net from 'node:net';
for (const broker of ${JSON.stringify([ownBroker, ownBroker.replace('/private/tmp/', '/tmp/')])}) {
  await new Promise((resolve, reject) => {
    const socket = net.connect(broker + '/own.sock');
    socket.on('error', reject).on('connect', () => { socket.destroy(); resolve(); });
  });
}
`),
    );
    await t.test(
      'relative connect to renamed external socket in lookalike directory is EPERM',
      () =>
        run(`
import assert from 'node:assert/strict'; import * as fs from 'node:fs'; import net from 'node:net';
const temporary = ${JSON.stringify(path.join(root, '_farmslot-blind-evals/slot/run-epoch/boundary/tmp'))};
fs.mkdirSync(temporary, { recursive: true });
fs.renameSync(${JSON.stringify(source)}, temporary + '/broker');
assert.ok(fs.statSync(temporary + '/broker/control.sock').isSocket());
process.chdir(temporary);
const error = await new Promise((resolve, reject) => {
  const socket = net.connect('broker/control.sock');
  socket.on('error', resolve).on('connect', () => {
    socket.destroy(); reject(new Error('lookalike directory socket connected'));
  });
});
assert.equal(error.code, 'EPERM');
`),
    );
  },
);

test(
  'Mobile broker and temp ownership under the real blind wrapper',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    const other = realpathSync(mkdtempSync('/tmp/mmh-cdp-fixture-'));
    t.after(() => rmSync(root, { recursive: true }));
    t.after(() => rmSync(other, { recursive: true }));
    profile(root);
    const own = path.join(root, 'boundary/tmp');
    const allocated = realpathSync(own);
    profile(root);
    assert.equal(realpathSync(own), allocated, 'retained launches must reuse the same temp');
    mkdirSync(path.join(root, 'hidden/pins'), { recursive: true });
    writeFileSync(path.join(root, 'hidden/pins/input'), 'synthetic other-task pin');
    writeFileSync(path.join(root, 'blind-git.py'), 'synthetic protected boundary');
    writeFileSync(path.join(other, 'state'), 'synthetic other-run state');
    const brokerDir = path.join(realpathSync(own), 'broker');
    const ownSocket = path.join(brokerDir, 'broker.sock');
    // A synthetic flat socket also exercises the legacy /tmp/mmh-cdp-* layout.
    const otherSocket = other + '.sock';
    symlinkSync(other, path.join(own, 'foreign'));
    symlinkSync(otherSocket, path.join(own, 'foreign.sock'));
    const homeSockets = ['rename', 'link'].map((operation) => path.join(root, operation + '.sock'));
    const servers = [ownSocket, otherSocket, ...homeSockets].map((socketPath) => {
      const server = net.createServer((socket) => socket.end('fixture-ok'));
      t.after(
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      );
      server.listen(socketPath);
      return server;
    });
    await Promise.all(servers.map((server) => once(server, 'listening')));
    const run = (source: string) => {
      const result = worker(
        root,
        `exec ${q(process.execPath)} --input-type=module -e ${q(source)}`,
        { ...env, TMPDIR: other, TMP: other, TEMP: other, FARMSLOT_BLIND_BROKER_DIR: other },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    };
    await t.test('own broker connects', () =>
      run(`
      import assert from 'node:assert/strict'; import net from 'node:net';
      const socket = net.connect(${JSON.stringify(ownSocket)});
      socket.on('error', error => { throw error; });
      await new Promise(resolve => socket.once('connect', resolve)); socket.destroy();`),
    );
    await t.test('other broker connect is EPERM', () =>
      run(`
      import assert from 'node:assert/strict'; import net from 'node:net';
      for (const target of ${JSON.stringify([otherSocket, path.join(own, 'foreign.sock')])}) {
        const error = await new Promise(resolve => net.connect(target)
          .on('error', resolve).on('connect', () => { throw Error('foreign socket connected'); }));
        assert.equal(error.code, 'EPERM');
      }`),
    );
    for (const [index, operation] of ['renameSync', 'linkSync'].entries()) {
      for (const directory of ['TMPDIR', 'FARMSLOT_BLIND_BROKER_DIR'])
        await t.test(`home socket ${operation} into ${directory} is EPERM`, () =>
          run(`
      import assert from 'node:assert/strict'; import * as fs from 'node:fs'; import net from 'node:net';
      const source = ${JSON.stringify(homeSockets[index])};
      const target = process.env.${directory} + '/imported-${operation}.sock';
      let relocationError;
      try { fs.${operation}(source, target); } catch (error) { relocationError = error; }
      const connectionError = await new Promise(resolve => net.connect(target)
        .on('error', resolve).on('connect', () => { throw Error('imported socket connected'); }));
      assert.equal(relocationError?.code, 'EPERM');
      assert.ok(['EPERM', 'ENOENT'].includes(connectionError.code));
      assert.ok(fs.existsSync(source));`),
        );
    }
    await t.test('broker admits sockets only and cannot be moved or replaced', () =>
      run(`
      import assert from 'node:assert/strict'; import * as fs from 'node:fs';
      const broker = process.env.FARMSLOT_BLIND_BROKER_DIR;
      assert.throws(() => fs.mkdirSync(broker + '/nested'), { code: 'EPERM' });
      assert.throws(() => fs.writeFileSync(broker + '/file', 'fixture'), { code: 'EPERM' });
      assert.throws(() => fs.symlinkSync(process.env.TMPDIR, broker + '/alias'), { code: 'EPERM' });
      assert.throws(() => fs.renameSync(broker, broker + '-moved'), { code: 'EPERM' });
      assert.throws(() => fs.rmdirSync(broker), { code: 'EPERM' });
      assert.throws(() => fs.chmodSync(broker, 0o777), { code: 'EPERM' });`),
    );
    await t.test('ps supplies harness identity and health fields', () =>
      run(`
      import assert from 'node:assert/strict'; import { execFileSync } from 'node:child_process';
      for (const fields of ['lstart=', 'etime=,rss=', 'command=', 'comm=', 'ppid=,args='])
        assert.ok(execFileSync('ps', ['-ww', '-p', String(process.pid), '-o', fields], { encoding: 'utf8' }).trim());
      assert.ok(execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).includes(String(process.pid)));`),
    );
    await t.test('other temp state cannot be deleted or written', () =>
      run(`
      import assert from 'node:assert/strict';
      import { unlinkSync, rmdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
      for (const target of ${JSON.stringify([otherSocket, path.join(other, 'state'), path.join(own, 'foreign/state')])}) {
        assert.throws(() => unlinkSync(target), { code: 'EPERM' });
        assert.throws(() => chmodSync(target, 0o777), { code: 'EPERM' });
      }
      assert.throws(() => rmdirSync(${JSON.stringify(other)}), { code: 'EPERM' });
      assert.throws(() => renameSync(${JSON.stringify(other)}, ${JSON.stringify(other + '-moved')}), { code: 'EPERM' });
      assert.throws(() => writeFileSync(${JSON.stringify(path.join(other, 'state'))}, 'changed'), { code: 'EPERM' });`),
    );
    await t.test('boundary assigns writable private temp and broker paths', () =>
      run(`
      import assert from 'node:assert/strict'; import { writeFileSync, unlinkSync, realpathSync } from 'node:fs';
      assert.equal(realpathSync(process.env.TMPDIR), ${JSON.stringify(realpathSync(own))});
      assert.equal(process.env.TMP, process.env.TMPDIR); assert.equal(process.env.TEMP, process.env.TMPDIR);
      assert.equal(process.env.FARMSLOT_BLIND_BROKER_DIR, process.env.TMPDIR + '/broker');
      assert.equal(process.env.MAC_CHROMIUM_TMPDIR, process.env.TMPDIR);
      const file = process.env.TMPDIR + '/own-file'; writeFileSync(file, 'fixture'); unlinkSync(file);`),
    );
    await t.test('production broker exchanges commands in the boundary allocation', () =>
      run(`
      import assert from 'node:assert/strict';
      import * as fs from 'node:fs';
      import broker from ${JSON.stringify(fileURLToPath(new URL('../../../../packages/recipe-runner/cdp-broker/cdp-broker.cjs', import.meta.url)))};
      import path from 'node:path';
      const first = broker.brokerSocketPath('/synthetic/runtime', 8081);
      assert.equal(path.dirname(first), process.env.FARMSLOT_BLIND_BROKER_DIR);
      assert.notEqual(first, broker.brokerSocketPath('/synthetic/runtime', 8082));
      assert.ok(Buffer.byteLength(first) < 104);
      const sessions = new Map([['fixture', { deviceId: 'fixture', name: 'synthetic', opened: true, brokerReady: true }]]);
      const server = broker.createCdpBroker({ socketPath: first, sessions, sendCommand: async () => ({ fixture: true }) });
      let client;
      try {
        client = await broker.createBrokerClient(first, 'fixture', 1000);
        assert.ok(fs.statSync(process.env.TMPDIR + '/' + path.basename(first) + '.owner').isDirectory());
        assert.ok(fs.readdirSync(process.env.FARMSLOT_BLIND_BROKER_DIR).every(name => fs.lstatSync(path.dirname(first) + '/' + name).isSocket()));
        assert.throws(() => broker.createCdpBroker({ socketPath: first, sessions, sendCommand: async () => ({}) }), /socket is owned/);
        assert.deepEqual(await client.send('Runtime.evaluate', { expression: 'synthetic' }, 1000), { fixture: true });
      } finally { client?.close(); server.close(); }
      assert.equal(fs.existsSync(process.env.TMPDIR + '/' + path.basename(first) + '.owner'), false);`),
    );
    await t.test('routing link and ps cannot be replaced or moved', () =>
      run(`
      import assert from 'node:assert/strict'; import { unlinkSync, renameSync, writeFileSync } from 'node:fs';
      for (const target of ${JSON.stringify([own, path.join(root, 'boundary/bin/ps')])}) {
        assert.throws(() => unlinkSync(target), { code: 'EPERM' });
        assert.throws(() => renameSync(target, target + '-moved'), { code: 'EPERM' });
      }
      assert.throws(() => writeFileSync(${JSON.stringify(path.join(root, 'boundary/bin/ps'))}, 'changed'), { code: 'EPERM' });`),
    );
    await t.test('boundary chmod/dd and other task pin reads stay EPERM', () =>
      run(`
      import assert from 'node:assert/strict'; import { chmodSync, readFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      const file = ${JSON.stringify(path.join(root, 'blind-git.py'))};
      assert.throws(() => chmodSync(file, 0o777), { code: 'EPERM' });
      const result = spawnSync('/bin/dd', ['if=/dev/zero', 'of=' + file, 'count=1'], { encoding: 'utf8' });
      assert.notEqual(result.status, 0); assert.match(result.stderr, /Operation not permitted/);
      assert.throws(() => readFileSync(${JSON.stringify(path.join(root, 'hidden/pins/input'))}), { code: 'EPERM' });`),
    );
  },
);

test(
  'blind launch admits tooling and provider config without ambient secrets',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true }));
    profile(root);
    const agent = path.join(root, 'synthetic-agent');
    mkdirSync(agent);
    writeFileSync(
      path.join(agent, 'models.json'),
      '{"providers":{"fixture":{"apiKey":"fixture-only"}}}',
    );
    const secrets = [
      'GH_REGISTRY_PAT',
      'GITHUB_TOKEN',
      'NPM_TOKEN',
      'FOO_SECRET',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'npm_config_auth',
      'GH_OTHER',
      'OTHER_API_KEY',
      'OPENAI_API_KEY',
    ];
    const probe = path.join(root, 'env-probe.mjs');
    writeFileSync(
      probe,
      `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
for (const name of ${JSON.stringify(secrets)}) assert.equal(process.env[name], undefined, name + ' leaked into blind worker');
assert.equal(process.env.LITELLM_API_KEY, 'fixture-provider');
assert.equal(process.env.PI_CODING_AGENT_DIR, ${JSON.stringify(agent)});
assert.equal(JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR + '/models.json')).providers.fixture.apiKey, 'fixture-only');
assert.equal(process.env.TMUX_PANE, '%42');
assert.equal(process.env.FARMSLOT_TASK_DIR, ${JSON.stringify(root)});
assert.equal(process.env.ANDROID_HOME, '/synthetic/android');
assert.ok(process.env.PATH);
assert.ok(process.env.HOME);
console.log('ambient secrets absent; tooling, task, pane and synthetic model config available');
`,
    );
    const result = worker(
      root,
      `exec ${q(process.execPath)} ${q(probe)}`,
      {
        ...env,
        ...Object.fromEntries(secrets.map((name) => [name, 'fixture-only'])),
        PI_CODING_AGENT_DIR: agent,
        TMUX_PANE: '%42',
        FARMSLOT_TASK_DIR: root,
        ANDROID_HOME: '/synthetic/android',
        LITELLM_API_KEY: 'fixture-provider',
      },
      45_000,
      getRunnerDefinition('pi').blindModelEnvironment?.('litellm/fixture'),
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    t.diagnostic(result.stdout.trim());
  },
);

for (const provider of ['localsparks', 'router', 'litellm', 'ollama'] as const) {
  test(
    `blind pi ${provider} pool config survives fresh launch and retained reload`,
    { skip: process.platform !== 'darwin' },
    async (t) => {
      const root = fixture();
      t.after(() => rmSync(root, { recursive: true }));
      profile(root);
      const agent = path.join(root, 'pi-agent');
      mkdirSync(agent);
      const binary = path.join(root, 'pi-fixture.mjs');
      const selectedKind = provider === 'localsparks' ? 'router' : provider;
      const secrets = [
        'GH_REGISTRY_PAT',
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'LITELLM_API_KEY',
        'OLLAMA_API_KEY',
        'FARMSLOT_PI_ROUTER_KEY',
      ];
      const selectedKey = {
        router: 'FARMSLOT_PI_ROUTER_KEY',
        litellm: 'LITELLM_API_KEY',
        ollama: 'OLLAMA_API_KEY',
      }[selectedKind];
      const config = {
        FARMSLOT_PI_ROUTER_ID: 'localsparks',
        FARMSLOT_PI_ROUTER_URL: 'http://router.invalid/v1',
        LITELLM_URL: 'http://litellm.invalid/v1',
        FARMSLOT_PI_OLLAMA: '1',
        FARMSLOT_PI_OLLAMA_URL: 'http://ollama.invalid/v1',
        FARMSLOT_PI_REQUEST_TIMEOUT_MS: '12345',
        FARMSLOT_PI_REQUEST_TIMEOUT_MODE: 'idle',
        FARMSLOT_PI_PROVIDERS_DEBUG: '1',
        FARMSLOT_PI_WORKSPACE_TRUST: '1',
        ...Object.fromEntries(
          ['ROUTER', 'LITELLM', 'OLLAMA'].flatMap((kind) => [
            [`FARMSLOT_PI_${kind}_CONTEXT`, '64000'],
            [`FARMSLOT_PI_${kind}_MAX_TOKENS`, '4096'],
            [`FARMSLOT_PI_${kind}_REASONING`, 'true'],
            [
              `FARMSLOT_PI_${kind}_MODEL_LIMITS`,
              JSON.stringify({
                fixture: {
                  contextWindow: 32000,
                  maxTokens: 2048,
                  reasoning: true,
                },
              }),
            ],
          ]),
        ),
      };
      writeFileSync(
        binary,
        `
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const extension = process.argv[process.argv.indexOf('-e') + 1];
const { resolvePiProviderCatalog } = await import(pathToFileURL(path.join(path.dirname(extension), 'pi-farmslot-providers.mjs')));
for (const name of ${JSON.stringify(secrets.filter((name) => name !== selectedKey))})
  assert.equal(process.env[name], undefined, name + ' leaked');
assert.equal(process.env[${JSON.stringify(selectedKey)}], 'synthetic-selected-auth');
const requests = [];
const catalog = await resolvePiProviderCatalog(process.env, {
  fetchImpl: async (url, options) => {
    requests.push([url, new Headers(options.headers).get('Authorization')]);
    return Response.json({ data: [{ id: 'fixture' }] });
  },
});
const selectedUrl = ${JSON.stringify(config[`${selectedKind === 'router' ? 'FARMSLOT_PI_ROUTER' : selectedKind === 'litellm' ? 'LITELLM' : 'FARMSLOT_PI_OLLAMA'}_URL`])};
assert.ok(requests.length > 0, 'discovery must run through the real wrapper');
const leaked = requests.find(([url, authorization]) => authorization === 'Bearer synthetic-selected-auth' && !url.startsWith(selectedUrl + '/'));
assert.ok(!leaked, 'selected credential reached an unselected endpoint: ' + leaked?.[0]);
for (const [url, authorization] of requests) {
  assert.ok(url.startsWith(selectedUrl + '/'), 'discovery reached an unselected endpoint: ' + url);
  assert.ok(authorization === 'Bearer synthetic-selected-auth', 'endpoint received incorrect auth');
}
for (const [name, value] of Object.entries(${JSON.stringify(config)})) {
  const shared = ['FARMSLOT_PI_REQUEST_TIMEOUT_MS', 'FARMSLOT_PI_REQUEST_TIMEOUT_MODE', 'FARMSLOT_PI_PROVIDERS_DEBUG', 'FARMSLOT_PI_WORKSPACE_TRUST'].includes(name);
  const selected = name.startsWith('FARMSLOT_PI_' + ${JSON.stringify(selectedKind.toUpperCase())}) || name.startsWith(${JSON.stringify(selectedKind.toUpperCase())} + '_');
  assert.equal(process.env[name], shared || selected ? value : undefined, name);
}
assert.deepEqual(catalog.map(source => source.kind), [${JSON.stringify(selectedKind)}]);
const source = catalog.find(source => source.kind === ${JSON.stringify(selectedKind)});
assert.ok(source, 'selected pool provider must be registered');
assert.equal(source.id, ${JSON.stringify(selectedKind === 'router' ? 'localsparks' : selectedKind)});
assert.equal(source.apiKey, 'synthetic-selected-auth');
assert.equal(source.models[0].contextWindow, 32000);
assert.equal(source.models[0].maxTokens, 2048);
assert.equal(source.models[0].reasoning, true);
console.log('synthetic provider config and scoped auth passed');
`,
      );
      const vars = makeVars({
        remoteRepo: root,
        piPath: `${q(process.execPath)} ${q(binary)}`,
        machineEnv: {
          ...config,
          PI_CODING_AGENT_DIR: agent,
          ...Object.fromEntries(secrets.map((name) => [name, 'synthetic-unselected-auth'])),
          [selectedKey]: 'synthetic-selected-auth',
        },
      });
      const options = {
        taskDir: path.join(root, 'task'),
        blindTrialBoundary: { capsule: root, baseSha: 'a'.repeat(40) },
      };
      for (const [stage, command] of Object.entries({
        fresh: buildLaunchCommand(vars, 'pi', `${provider}/fixture`, 'Synthetic task', options),
        retained: buildRunnerSessionReloadCommand(
          vars,
          'pi',
          `${provider}/fixture`,
          'synthetic-session',
          options,
        ),
      }))
        await t.test(stage, () => {
          const result = spawnSync('/bin/bash', ['-c', command], {
            env,
            encoding: 'utf8',
            timeout: 10_000,
          });
          assert.ifError(result.error);
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stdout, /synthetic provider config and scoped auth passed/);
        });
    },
  );
}

test(
  'frozen mark helper verifies its CLI and marks progress under the real seatbelt',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const { cliTaskInputExclusions } = await import(
      new URL('../../../../packages/cli/src/commands/task.ts', import.meta.url).href
    );
    const { retainTaskExecution } =
      await import('../../../../packages/agent-runtime/src/task-init/execution-provenance.js');
    const { buildMarkShim } =
      await import('../../../../packages/agent-runtime/src/task-init/write.js');
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true }));
    const launchEnv = { ...env, FARMSLOT_HOME: path.join(root, 'farm') };
    const previous = process.env.FARMSLOT_HOME;
    process.env.FARMSLOT_HOME = launchEnv.FARMSLOT_HOME;
    t.after(() => {
      if (previous === undefined) delete process.env.FARMSLOT_HOME;
      else process.env.FARMSLOT_HOME = previous;
    });
    const installed = path.join(root, 'installed');
    const task = path.join(root, 'task');
    const source = path.join(installed, 'services/gateway/src/evals/blind-git.py');
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, '# synthetic private boundary source\n');
    writeFileSync(
      path.join(installed, 'package.json'),
      '{"name":"@farmslot/cli","version":"1.0.0"}',
    );
    const executable = path.join(installed, 'farmslot');
    // Retain a tiny distribution fixture. The executable invokes the real CLI,
    // including its receipt verifier and the production checklist marker.
    writeFileSync(
      executable,
      `#!/bin/sh\nexec ${q(process.execPath)} ${q(fileURLToPath(new URL('../../../../packages/cli/bin/farmslot.mjs', import.meta.url)))} "$@"\n`,
      { mode: 0o755 },
    );
    const receipt = retainTaskExecution(task, {
      executable,
      packageRoot: installed,
      distributionRoot: installed,
      bindingIdentity: null,
      inputs: [],
      excludedRoots: cliTaskInputExclusions(installed),
      selectedConfiguration: '{"identity":null}',
    });
    writeFileSync(
      path.join(task, 'CHECKLIST.md'),
      '# Synthetic task\n- [ ] 1. Prove marker progress\n',
    );
    writeFileSync(
      path.join(task, 'mark'),
      buildMarkShim(`${q(receipt.resolvedExecutable)} task mark`, true),
      { mode: 0o755 },
    );
    assert.equal(
      existsSync(path.join(receipt.pin, 'cli/services/gateway/src/evals/blind-git.py')),
      false,
    );
    profile(root, launchEnv);
    const result = worker(root, `${q(path.join(task, 'mark'))} 1`, launchEnv);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(readFileSync(path.join(task, 'CHECKLIST.md'), 'utf8'), /- \[x\] 1\./u);
    writeFileSync(
      receipt.resolvedExecutable,
      readFileSync(receipt.resolvedExecutable, 'utf8') + '# synthetic tamper\n',
    );
    const tampered = worker(root, `${q(path.join(task, 'mark'))} start`, launchEnv);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stdout + tampered.stderr, /TASK_INPUT_CHANGED/u);
    const denied = worker(
      root,
      `cat ${q(source)}; cat ${q(path.join(root, 'boundary/sandbox.sb'))}`,
      launchEnv,
    );
    assert.notEqual(denied.status, 0);
    assert.doesNotMatch(denied.stdout, /synthetic private boundary source/u);
    assert.match(denied.stderr, /Operation not permitted/u);
    t.diagnostic(
      'real frozen mark verified its receipt and wrote CHECKLIST; boundary builder and sandbox profile contents remain denied',
    );
  },
);

test(
  'hosted static init and retained init keep mark usable inside Seatbelt',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true }));
    const checkout = fileURLToPath(new URL('../../../../', import.meta.url));
    const installed = path.join(root, 'installed');
    // Copy program sources into a disposable installation. No build,
    // operator configuration, package install, or shared distribution is touched.
    for (const directory of [
      'packages/cli/src',
      'packages/agent-runtime/src',
      'packages/agent-runtime/scripts',
      'packages/agent-runtime/bin',
    ]) {
      cpSync(path.join(checkout, directory), path.join(installed, directory), {
        recursive: true,
        filter: (file) =>
          !file.endsWith('.test.ts') &&
          !file.endsWith('.test.tsx') &&
          !['.env', '.npmrc', '.pi', '.ssh'].includes(path.basename(file)) &&
          !path.basename(file).startsWith('.env.'),
      });
    }
    symlinkSync(path.join(checkout, 'node_modules'), path.join(root, 'node_modules'));
    writeFileSync(path.join(installed, 'package.json'), '{"type":"module"}');
    writeFileSync(path.join(installed, 'yarn.lock'), '# synthetic immutable installation');
    writeFileSync(path.join(installed, 'DEPLOYED-REVISION.json'), '{}');
    const cli = path.join(installed, 'packages/cli');
    writeFileSync(
      path.join(cli, 'package.json'),
      '{"name":"@farmslot/cli","version":"1.0.0","type":"module"}',
    );
    mkdirSync(path.join(cli, 'bin'));
    writeFileSync(
      path.join(cli, 'bin/farmslot.mjs'),
      `#!/bin/sh\nexec ${q(process.execPath)} ${q(path.join(checkout, 'packages/cli/bin/farmslot.mjs'))} "$@"\n`,
      { mode: 0o755 },
    );
    const tsconfig = JSON.parse(
      readFileSync(path.join(checkout, 'packages/cli/tsconfig.json'), 'utf8'),
    );
    for (const [name, paths] of Object.entries(tsconfig.compilerOptions.paths)) {
      assert.ok(Array.isArray(paths));
      tsconfig.compilerOptions.paths[name] = paths.map((entry: string) =>
        path.resolve(checkout, 'packages/cli', entry),
      );
    }
    tsconfig.compilerOptions.paths['@farmslot/agent-runtime'] = [
      path.join(installed, 'packages/agent-runtime/src/index.ts'),
    ];
    tsconfig.extends = path.join(checkout, 'apps/command-center/tsconfig.base.json');
    const configFile = path.join(installed, 'tsconfig.json');
    writeFileSync(configFile, JSON.stringify(tsconfig));
    const boundarySource = path.join(installed, 'services/gateway/src/evals/blind-git.py');
    mkdirSync(path.dirname(boundarySource), { recursive: true });
    writeFileSync(boundarySource, '# synthetic private boundary builder');
    const pack = path.join(root, 'projects/fixture');
    mkdirSync(path.join(pack, 'templates/worker'), { recursive: true });
    writeFileSync(path.join(pack, 'project.json'), '{"name":"fixture","task_dir":"tasks"}');
    writeFileSync(
      path.join(pack, 'templates/worker/dev.md'),
      '---\nplatforms: [core]\n---\n# Synthetic task\n- [ ] 1. Prove hosted marker progress\n',
    );
    mkdirSync(path.join(pack, 'tasks'));
    writeFileSync(path.join(pack, 'tasks/unretained.txt'), 'synthetic task output');
    mkdirSync(path.join(root, 'pool'));
    writeFileSync(
      path.join(root, 'pool/local.json'),
      JSON.stringify({
        host: 'localhost',
        project: 'fixture',
        slots: [{ id: 'fixture-core-1', repo: root, platform: 'core' }],
      }),
    );
    const task = path.join(root, 'tasks/dev/proof');
    const driver = path.join(root, 'hosted-init.mjs');
    writeFileSync(
      driver,
      `
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const { runHostedTaskInit } = await import(${JSON.stringify(path.join(cli, 'src/commands/hosted-task-init.ts'))});
const file = ${JSON.stringify(root)} + '/.task-init-' + randomUUID() + '.json';
writeFileSync(file, JSON.stringify({ version: 1, slotId: 'fixture-core-1', binding: 'static',
  task: { taskDir: ${JSON.stringify(task)}, flow: 'dev', platform: 'core',
    task: { title: 'Synthetic static task', sourceKind: 'text' },
    handoff: { surface: 'farmslot', project: 'fixture', attemptId: 'synthetic-run' } },
  template: { sourceId: 'project:fixture', id: 'dev/default', selectionReason: 'single-general-candidate',
    sha256: createHash('sha256').update(readFileSync(${JSON.stringify(path.join(pack, 'templates/worker/dev.md'))})).digest('hex') }
}));
const result = await runHostedTaskInit(file);
assert.ok(result.executionProvenance);
const pack = result.executionProvenance.retainedInputs.find(input => input.source === ${JSON.stringify(pack)});
assert.ok(pack);
console.log(JSON.stringify({ pin: result.executionProvenance.pin, pack: pack.path }));
`,
    );
    const launchEnv = {
      ...env,
      FARMSLOT_HOME: path.join(root, 'farm'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      TSX_TSCONFIG_PATH: configFile,
    };
    const initialize = () => {
      const result = spawnSync(
        process.execPath,
        ['--import', path.join(checkout, 'node_modules/tsx/dist/loader.mjs'), driver],
        {
          env: launchEnv,
          encoding: 'utf8',
          timeout: 20_000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.trim());
    };
    const fresh = initialize();
    profile(root, launchEnv);
    for (const stage of ['fresh', 'retained'])
      await t.test(stage, () => {
        if (stage === 'retained') assert.deepEqual(initialize(), fresh);
        const marked = worker(root, `${q(path.join(task, 'mark'))} 1`, launchEnv);
        assert.ifError(marked.error);
        assert.equal(marked.status, 0, stage + ': ' + marked.stderr + marked.stdout);
        assert.match(readFileSync(path.join(task, 'CHECKLIST.md'), 'utf8'), /- \[x\] 1\./);
      });
    assert.equal(
      existsSync(path.join(fresh.pin, 'cli/services/gateway/src/evals/blind-git.py')),
      false,
    );
    assert.equal(existsSync(path.join(fresh.pack, 'tasks/unretained.txt')), false);
    assert.equal(existsSync(path.join(fresh.pack, 'project.json')), true);
  },
);

test(
  'blind Mobile tooling can reach its synthetic Metro TCP endpoint',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true }));
    const metro = net.createServer((socket) => socket.end('synthetic-metro'));
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          metro.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    metro.listen(0, '127.0.0.1');
    await once(metro, 'listening');
    const address = metro.address();
    assert.ok(address && typeof address !== 'string');
    profile(root, env, { metro_port: address.port });
    const probe = path.join(root, 'metro-probe.mjs');
    writeFileSync(
      probe,
      `
import assert from 'node:assert/strict';
import net from 'node:net';
assert.equal(process.env.IOS_SIMULATOR, 'Synthetic simulator');
assert.equal(process.env.SIM_UDID, 'synthetic-device');
const data = await new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port: Number(process.env.METRO_PORT) });
  socket.setTimeout(1000, () => socket.destroy(new Error('synthetic Metro timeout')));
  socket.on('error', reject);
  let bytes = ''; socket.on('data', chunk => bytes += chunk);
  socket.on('end', () => resolve(bytes));
});
assert.equal(data, 'synthetic-metro');
`,
    );
    // Async spawning lets the parent serve Metro while the child connects.
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        withBlindTrialBoundary(`exec ${q(process.execPath)} ${q(probe)}`, {
          capsule: root,
          baseSha: 'a'.repeat(40),
          browserCdpPort: JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8'))
            .browserCdpPort,
        }).replace('/usr/bin/env -i', 'exec /usr/bin/env -i'),
      ],
      {
        env: {
          ...env,
          METRO_PORT: String(address.port),
          IOS_SIMULATOR: 'Synthetic simulator',
          SIM_UDID: 'synthetic-device',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdout.resume();
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    t.diagnostic(
      'synthetic Metro TCP and Mobile device environment passed; no live simulator was contacted',
    );
  },
);

test(
  'gateway network is denied even with a readable valid token; browser stores and operator CDP are denied',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    let stopGateway = async () => {};
    let stopSlotBrowser = async () => {};
    t.after(async () => {
      try {
        try {
          await stopSlotBrowser();
        } finally {
          await stopGateway();
        }
      } finally {
        rmSync(root, { recursive: true });
      }
    });
    const home = path.join(root, 'home');
    const config = path.join(root, 'boundary/private-config');
    mkdirSync(home);
    mkdirSync(config);
    symlinkSync(config, path.join(home, '.farmslot-automation'));
    const installed = path.join(root, 'external-control/node');
    mkdirSync(installed, { recursive: true });
    symlinkSync(installed, path.join(home, 'farmslot-node-dev'));
    const launchEnv = {
      ...env,
      HOME: home,
      FARMSLOT_HOME: path.join(home, '.farmslot-automation'),
      FARMSLOT_CONFIG_DIR: config,
      FARMSLOT_ROOT: path.join(home, 'farmslot-node'),
    };
    const credentialFiles = [
      ...['.farmslot', '.farmslot-dev/config', '.farmslot-automation'].flatMap((directory) =>
        [
          'gateways.json',
          'credentials.json',
          'provider-accounts.json',
          'active-provider-accounts.json',
          'node.secret',
          'providers.env',
        ].map((name) => path.join(home, directory, name)),
      ),
      path.join(home, '.farmslot-automation/fixture-node-automation.secret'),
      path.join(home, 'Library/LaunchAgents/com.farmslot.node.dev.plist'),
      path.join(home, '.config/systemd/user/farmslot-node-dev.service'),
      path.join(home, 'farmslot-node/.env'),
      path.join(home, 'farmslot-node-dev/.env.ports'),
      path.join(root, 'external-control/.env'),
    ];
    for (const file of credentialFiles) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        path.basename(file) === 'gateways.json' ? '{"gateways":{}}' : 'synthetic credential only',
        { mode: 0o600 },
      );
    }
    for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
      const file = path.join(launchEnv.FARMSLOT_ROOT, marker);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, marker.endsWith('.json') ? '{}' : 'synthetic root marker');
    }
    // Resolve an individual credential symlink outside the config directory too.
    const target = path.join(root, 'boundary/opaque-credential');
    writeFileSync(target, '{"gateways":{}}');
    rmSync(path.join(home, '.farmslot/gateways.json'));
    symlinkSync(target, path.join(home, '.farmslot/gateways.json'));
    credentialFiles.push(...credentialFiles.map((file) => realpathSync(file)), target);
    credentialFiles.push(...credentialFiles.map((file) => file.replace('/private/tmp/', '/tmp/')));
    for (const name of ['gateways.json', 'credentials.json']) rmSync(path.join(config, name));
    const serverScript = path.join(root, 'gateway-fixture.mts');
    writeFileSync(
      serverScript,
      `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { ownCleanup } from './owned-cleanup.mjs';
import { testGatewayIdentity, testGatewayProfile } from ${JSON.stringify(new URL('../../../../scripts/lib/test-gateway-identity-source.mts', import.meta.url).href)};
import { createGatewayAuthRuntime, initializeGatewayIdentity, authenticateGatewayClient } from ${JSON.stringify(new URL('../security/auth.ts', import.meta.url).href)};
import { createWebSocketServer, disposeServerResourceObservations } from ${JSON.stringify(new URL('../server.ts', import.meta.url).href)};
const home = process.env.FARMSLOT_HOME!;
const token = testGatewayIdentity(home);
const runtime = createGatewayAuthRuntime(process.env);
initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
assert.equal((await authenticateGatewayClient({ runtime, connectParams: { clientKind: 'ui', token }, clientIp: '127.0.0.1' })).ok, true);
const server = createServer();
const wss = createWebSocketServer(server, runtime);
ownCleanup(${process.pid}, async () => {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  disposeServerResourceObservations();
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const url = 'ws://127.0.0.1:' + address.port;
testGatewayProfile(home, url, token);
writeFileSync(${JSON.stringify(path.join(root, 'gateway-ready.json'))}, JSON.stringify({ url }));
`,
    );
    // Importing the production server configures tmux options at module load.
    // Own its socket directory even without the outer test wrapper.
    const gatewayTmux = path.join(root, 'gateway-tmux');
    mkdirSync(gatewayTmux);
    const gateway = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), serverScript],
      {
        cwd: root,
        env: {
          ...launchEnv,
          TMUX_TMPDIR: gatewayTmux,
          NODE_TEST_CONTEXT: '1',
          TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
          FARMSLOT_POOL_DIR: path.join(root, 'pool'),
          FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
          FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = once(gateway, 'exit');
    let stderr = '';
    gateway.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    gateway.stdout.resume();
    stopGateway = async () => {
      if (gateway.exitCode === null && gateway.signalCode === null) {
        gateway.kill('SIGTERM');
        const deadline = Date.now() + 3000;
        while (gateway.exitCode === null && gateway.signalCode === null && Date.now() < deadline)
          await delay(25);
        if (gateway.exitCode === null && gateway.signalCode === null) gateway.kill('SIGKILL');
      }
      await exited;
    };
    const ready = path.join(root, 'gateway-ready.json');
    const deadline = Date.now() + 20_000;
    while (!existsSync(ready) && gateway.exitCode === null && Date.now() < deadline)
      await delay(25);
    assert.ok(existsSync(ready), stderr);
    const { url } = JSON.parse(readFileSync(ready, 'utf8'));
    const token = JSON.parse(readFileSync(path.join(config, 'gateways.json'), 'utf8')).gateways
      .proof.secret;
    // Hand the worker valid authority on purpose. Network policy must suffice.
    const handedToken = path.join(root, 'readable-token');
    writeFileSync(handedToken, token);
    const browserFiles = [
      'Google/Chrome',
      'Google/Chrome Beta',
      'Google/Chrome Canary',
      'Google/Chrome Dev',
      'Chromium',
      'Google/Chrome for Testing',
    ].map((name) =>
      path.join(
        home,
        'Library/Application Support',
        name,
        'Default/Local Storage/leveldb/synthetic.log',
      ),
    );
    browserFiles.push(
      path.join(home, '.chrome-farmslot-9323/Default/Local Storage/leveldb/synthetic.log'),
      path.join(root, 'operator-debug/Default/Local Storage/leveldb/synthetic.log'),
    );
    for (const file of browserFiles) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ refreshToken: 'synthetic-browser-session' }));
    }
    const disposable = path.join(root, 'boundary/worker-chrome/Default/Local Storage/fixture');
    mkdirSync(path.dirname(disposable), { recursive: true });
    writeFileSync(disposable, 'worker-disposable-session');
    // The slot's debug-chrome capability calls this launcher outside the worker
    // boundary. Substitute only its executable with a synthetic CDP listener.
    const slotProfile = path.join(root, 'outside-slot-browser');
    const chrome = path.join(root, 'synthetic-chrome.mjs');
    const slotPid = path.join(root, 'outside-slot-browser.pid');
    const slotReady = path.join(root, 'outside-slot-browser.json');
    writeFileSync(
      chrome,
      `#!${process.execPath}
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { ownCleanup } from './owned-cleanup.mjs';
writeFileSync(${JSON.stringify(slotPid)}, String(process.pid));
assert.equal(execFileSync('python3', ['-c', 'import ctypes, os; print(ctypes.CDLL("/usr/lib/libsandbox.dylib").sandbox_check(os.getpid(), None, 0))'], { encoding: 'utf8' }).trim(), '0');
const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ Browser: 'Synthetic capability Chrome' })); });
ownCleanup(${process.pid}, () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
server.listen(0, '127.0.0.1', () => writeFileSync(${JSON.stringify(slotReady)}, JSON.stringify({ port: server.address().port })));
`,
      { mode: 0o700 },
    );
    stopSlotBrowser = async () => {
      if (!existsSync(slotPid)) return;
      const pid = Number(readFileSync(slotPid, 'utf8'));
      const signal = (value: NodeJS.Signals | 0) => {
        try {
          process.kill(pid, value);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          return false;
        }
      };
      if (!signal('SIGTERM')) return;
      const deadline = Date.now() + 2000;
      while (signal(0) && Date.now() < deadline) await delay(25);
      if (signal(0)) signal('SIGKILL');
    };
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            '../../../../apps/command-center/scripts/chrome-profile-cleanup.cjs',
            import.meta.url,
          ),
        ),
        'launch',
        slotProfile,
        chrome,
        '--user-data-dir=' + slotProfile,
        '--remote-debugging-port=0',
      ],
      { env: launchEnv, encoding: 'utf8', timeout: 5000 },
    );
    const cdpDeadline = Date.now() + 3000;
    while (!existsSync(slotReady) && Date.now() < cdpDeadline) await delay(25);
    assert.ok(existsSync(slotReady), 'synthetic capability browser did not start');
    const cdpAddress: { port: number } = JSON.parse(readFileSync(slotReady, 'utf8'));
    assert.deepEqual(
      await fetch(`http://127.0.0.1:${cdpAddress.port}/json/version`).then((r) => r.json()),
      { Browser: 'Synthetic capability Chrome' },
    );
    Object.assign(launchEnv, {
      FARMSLOT_CDP_PORT: String(cdpAddress.port),
      FARMSLOT_CDP_PROFILE: path.join(root, 'operator-debug'),
    });
    profile(root, launchEnv, { cdp_port: cdpAddress.port });
    // A profile materialized after boundary generation still carries no authority.
    const late = path.join(root, 'late-config');
    mkdirSync(late);
    const lateProfile = path.join(late, 'gateways.json');
    writeFileSync(lateProfile, JSON.stringify({ gateways: { proof: { url, secret: token } } }));
    credentialFiles.push(lateProfile);
    const alias = path.join(root, 'worker-profile-alias');
    symlinkSync(path.join(config, 'gateways.json'), alias);
    const task = path.join(root, 'task');
    mkdirSync(task);
    writeFileSync(path.join(task, 'CHECKLIST.md'), '# Synthetic task\n- [ ] Prove local marking\n');
    const probe = path.join(root, 'gateway-probe.mjs');
    writeFileSync(
      probe,
      `
import assert from 'node:assert/strict';
import { readFileSync, renameSync, linkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import WebSocket from ${JSON.stringify(import.meta.resolve('ws'))};
import net from 'node:net';
const handedToken = readFileSync(${JSON.stringify(handedToken)}, 'utf8');
assert.ok(handedToken.length > 0);
if (process.argv[2] === 'control') {
  const socket = new WebSocket(${JSON.stringify(url)});
  const timeout = setTimeout(() => { socket.terminate(); throw new Error('control timed out'); }, 2500);
  try {
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const response = new Promise(resolve => socket.on('message', raw => { const frame = JSON.parse(raw); if (frame.id === 'auth') resolve(frame); }));
    socket.send(JSON.stringify({ type: 'req', id: 'auth', method: 'auth.connect', params: { clientKind: 'ui', token: handedToken } }));
    assert.equal((await response).ok, true);
    console.log('synthetic token authenticates outside seatbelt');
  } finally { clearTimeout(timeout); socket.terminate(); }
  process.exit(0);
}
for (const file of ${JSON.stringify(browserFiles)})
  assert.throws(() => readFileSync(file), { code: 'EPERM' });
assert.equal(readFileSync(${JSON.stringify(disposable)}, 'utf8'), 'worker-disposable-session');
for (const name of ['FARMSLOT_NODE_TOKEN', 'FARMSLOT_GATEWAY_TOKEN', 'FARMSLOT_GATEWAY_PASSWORD', 'GW_URL', 'GATEWAY_URL', 'FARMSLOT_GATEWAY', 'FARMSLOT_GATEWAY_PROFILE']) assert.equal(process.env[name], undefined, name);
for (const file of ${JSON.stringify([...new Set([...credentialFiles, alias])])}) {
  assert.throws(() => readFileSync(file), { code: 'EPERM' });
  if (file !== ${JSON.stringify(alias)}) assert.throws(() => renameSync(file, file + '-moved'), { code: 'EPERM' });
  assert.throws(() => linkSync(file, file + '-linked'), { code: 'EPERM' });
}
for (const directory of ${JSON.stringify([home, config, path.dirname(config), path.join(home, '.farmslot'), path.join(home, '.farmslot-dev'), path.join(home, '.farmslot-automation')])}) assert.throws(() => renameSync(directory, directory + '-moved'), { code: 'EPERM' });
renameSync(${JSON.stringify(late)}, ${JSON.stringify(late + '-moved')});
assert.throws(() => readFileSync(${JSON.stringify(late + '-moved/gateways.json')}), { code: 'EPERM' });
const marked = spawnSync(process.execPath, [${JSON.stringify(fileURLToPath(new URL('../../../../packages/agent-runtime/scripts/mark-checklist-step.cjs', import.meta.url)))}, ${JSON.stringify(task)}, '1'], { encoding: 'utf8' });
assert.equal(marked.status, 0, marked.stderr);
assert.ok(readFileSync(${JSON.stringify(path.join(task, 'CHECKLIST.md'))}, 'utf8').includes('- [x] Prove local marking'));
assert.ok(JSON.parse(readFileSync(${JSON.stringify(path.join(task, 'SIGNAL.json'))}, 'utf8')));
// Authority is readable, but the gateway transport must fail before auth.
const socket = new WebSocket(${JSON.stringify(url)});
try {
  await assert.rejects(new Promise((resolve, reject) => {
    socket.once('open', resolve); socket.once('error', reject);
  }), { code: 'EPERM' });
} finally { socket.terminate(); }
for (const host of ['127.0.0.1', '127.0.0.2', '::1', ${JSON.stringify(os.hostname())}]) {
  for (const port of [Number(new URL(${JSON.stringify(url)}).port), ${cdpAddress.port}, 7777, 7778, 7801, 8808, 8809, 9323]) {
    const connection = net.connect({ host, port });
    try {
      await assert.rejects(new Promise((resolve, reject) => { connection.once('connect', resolve); connection.once('error', reject); }), { code: 'EPERM' });
    } finally { connection.destroy(); }
  }
}
console.log('readable valid token cannot reach gateway; browser localStorage and operator CDP denied; disposable profile and local markers passed');
`,
    );
    const control = spawnSync(process.execPath, [probe, 'control'], {
      env: launchEnv,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(control.status, 0, control.stderr);
    const result = worker(root, `exec ${q(process.execPath)} ${q(probe)}`, {
      ...launchEnv,
      FARMSLOT_NODE_TOKEN: 'synthetic-node',
      FARMSLOT_GATEWAY_TOKEN: token,
      FARMSLOT_GATEWAY_PASSWORD: 'synthetic-password',
      GW_URL: url,
      GATEWAY_URL: url,
      FARMSLOT_GATEWAY: url,
      FARMSLOT_GATEWAY_PROFILE: 'proof',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    t.diagnostic(result.stdout.trim());
  },
);

test(
  'SSH execution, loopback remote shells, credentials and a known agent socket are denied',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    const agent = net.createServer((socket) => socket.destroy());
    t.after(async () => {
      try {
        if (agent.listening)
          await new Promise<void>((resolve, reject) =>
            agent.close((error) => (error ? reject(error) : resolve())),
          );
      } finally {
        rmSync(root, { recursive: true });
      }
    });
    const home = path.join(root, 'home');
    const credentials = path.join(root, 'credentials');
    mkdirSync(home);
    mkdirSync(credentials);
    symlinkSync(credentials, path.join(home, '.ssh'));
    for (const name of ['id_ed25519', 'config', 'known_hosts'])
      writeFileSync(path.join(credentials, name), 'synthetic SSH fixture only', { mode: 0o600 });
    const socket = path.join(root, 'agent.sock');
    agent.listen(socket);
    await once(agent, 'listening');
    const launchEnv = { ...env, HOME: home, SSH_AUTH_SOCK: socket, SSH_AGENT_PID: '123' };
    profile(root, launchEnv);
    const probe = path.join(root, 'ssh-probe.mjs');
    writeFileSync(
      probe,
      `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, linkSync } from 'node:fs';
import net from 'node:net';
assert.equal(process.env.SSH_AUTH_SOCK, undefined);
assert.equal(process.env.SSH_AGENT_PID, undefined);
const home = ${JSON.stringify(home)};
const credentials = ${JSON.stringify(credentials)};
for (const directory of [home + '/.ssh', credentials]) {
  for (const name of ['id_ed25519', 'config', 'known_hosts'])
    assert.throws(() => readFileSync(directory + '/' + name), { code: 'EPERM' });
  assert.throws(() => renameSync(directory, directory + '-moved'), { code: 'EPERM' });
  assert.throws(() => linkSync(directory + '/id_ed25519', home + '/linked-key'), { code: 'EPERM' });
}
assert.throws(() => renameSync(home, home + '-moved'), { code: 'EPERM' });
const deniedConnection = options => new Promise((resolve, reject) => {
  const client = net.connect(options);
  const timer = setTimeout(() => { client.destroy(); reject(new Error('connection did not fail promptly')); }, 1500);
  client.once('connect', () => { clearTimeout(timer); client.destroy(); reject(new Error('sandbox allowed connection')); });
  client.once('error', error => {
    clearTimeout(timer);
    client.destroy();
    try { assert.equal(error.code, 'EPERM'); resolve(); }
    catch (failure) { reject(failure); }
  });
});
// Raw TCP proves the network rule even if a worker copies an SSH client.
for (const host of ['localhost', '127.0.0.1', '::1', '127.0.0.2', '::ffff:127.0.0.1'])
  for (const port of [22, 512, 513, 514]) await deniedConnection({ host, port });
// Knowing or re-exporting the agent path must not restore access.
process.env.SSH_AUTH_SOCK = ${JSON.stringify(socket)};
await deniedConnection({ path: process.env.SSH_AUTH_SOCK });
for (const host of ['localhost', '127.0.0.1', '::1']) {
  const result = spawnSync('/usr/bin/ssh', ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=none', '-o', 'ConnectTimeout=1', host, 'true']);
  assert.ok(['EPERM', 'EACCES'].includes(result.error?.code), 'SSH execution must be denied');
}
for (const executable of ['/usr/bin/scp', '/usr/bin/sftp']) {
  const result = spawnSync(executable, ['-h']);
  assert.ok(['EPERM', 'EACCES'].includes(result.error?.code), executable + ' execution must be denied');
}
console.log('SSH/scp/sftp execution denied; loopback TCP 22/512/513/514 denied across IPv4/IPv6; synthetic SSH files unreadable; agent env stripped and known socket unusable');
`,
    );
    const result = worker(root, `exec ${q(process.execPath)} ${q(probe)}`, launchEnv);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    t.diagnostic(result.stdout.trim());
  },
);

test(
  'reconnaissance reads and alternate process launch paths stay blocked',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true }));
    const home = path.join(root, 'home');
    const blocked = ['.pi/agent/settings.json'];
    const allowed: string[] = [];
    for (const installation of ['farmslot-node', 'farmslot-node-dev']) {
      blocked.push(
        ...[
          'src/index.ts',
          'scripts/dev-stack/start.sh',
          'pool/fixture.json',
          'projects/fixture/private.txt',
        ].map((file) => `${installation}/${file}`),
      );
      allowed.push(
        ...[
          'support/fixture/scripts/proof.mjs',
          'node_modules/fixture/index.js',
          'packages/agent-runtime/scripts/proof.cjs',
        ].map((file) => `${installation}/${file}`),
      );
      // A runtime exception must never reopen installed wrapper source reads.
      blocked.push(`${installation}/node_modules/@farmslot/gateway/src/evals/blind-git.py`);
    }
    blocked.push('outside/services/gateway/src/evals/blind-git.ts');
    for (const file of [...blocked, ...allowed]) {
      mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
      writeFileSync(path.join(home, file), "console.log('synthetic helper executed');");
    }
    const launchEnv = { ...env, HOME: home };
    profile(root, launchEnv);
    const denied = [
      ...blocked.map((file) => path.join(home, file)),
      path.join(root, 'boundary/sandbox.sb'),
    ];
    // Exercise a worker-created alias as well as the resolved profile path.
    const profileAlias = path.join(root, 'profile-alias');
    symlinkSync(path.join(root, 'boundary/sandbox.sb'), profileAlias);
    denied.push(profileAlias);
    const copiedPs = path.join(root, 'copied-ps');
    copyFileSync('/bin/ps', copiedPs);
    const label = `seatbelt-fixture-${process.pid}-${path.basename(root)}`;
    t.after(() => {
      const removed = spawnSync('/bin/launchctl', ['remove', label], {
        env,
        encoding: 'utf8',
        timeout: 2000,
      });
      assert.ifError(removed.error);
      assert.ok([0, 3, 113].includes(removed.status!), removed.stderr);
    });
    const probe = path.join(root, 'recon-probe.mjs');
    writeFileSync(
      probe,
      `
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, renameSync, linkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const file of ${JSON.stringify(denied)}) assert.throws(() => readFileSync(file), { code: 'EPERM' });
for (const file of ${JSON.stringify(denied.filter((file) => file !== profileAlias))}) {
  assert.throws(() => renameSync(file, file + '-moved'), { code: 'EPERM' });
  assert.throws(() => linkSync(file, file + '-linked'), { code: 'EPERM' });
}
for (const directory of ${JSON.stringify(['.pi', '.pi/agent', 'farmslot-node', 'farmslot-node-dev'].map((file) => path.join(home, file)).concat([realpathSync(path.join(root, 'boundary'))]))}) assert.throws(() => renameSync(directory, directory + '-moved'), { code: 'EPERM' });
for (const installation of ['farmslot-node', 'farmslot-node-dev']) assert.throws(() => readdirSync(${JSON.stringify(home)} + '/' + installation), { code: 'EPERM' });
for (const file of ${JSON.stringify(allowed.map((file) => path.join(home, file)))}) {
  assert.equal(readFileSync(file, 'utf8'), "console.log('synthetic helper executed');");
  const helper = spawnSync(process.execPath, [file]);
  assert.equal(helper.status, 0, helper.stderr.toString());
  assert.equal(helper.stdout.toString().trim(), 'synthetic helper executed');
}
const launch = spawnSync('/bin/launchctl', ['submit', '-l', ${JSON.stringify(label)}, '--', '/bin/ps', '-p', '1'], { timeout: 2000 });
assert.notEqual(launch.status, 0, 'launchctl submit must fail');
const copied = spawnSync(${JSON.stringify(copiedPs)}, ['-p', '1'], { timeout: 2000 });
assert.notEqual(copied.status, 0, 'copied ps must remain non-functional');
console.log('synthetic settings/profile/wrapper/node reads denied; support/dependencies/helpers executed; launchctl submit and copied ps non-functional');
`,
    );
    const result = worker(root, `exec ${q(process.execPath)} ${q(probe)}`, launchEnv);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    t.diagnostic(result.stdout.trim());
  },
);

test(
  'private tmux servers refuse worker control; gateway-side control and pane identity survive',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const root = fixture();
    const socketDir = path.join(root, `tmux-${process.getuid!()}`);
    mkdirSync(socketDir, { mode: 0o700 });
    const sockets = [path.join(socketDir, 'default'), path.join(root, 'custom.sock')];
    const tmux = (socket: string, ...args: string[]) =>
      execFileSync('tmux', ['-f', '/dev/null', '-S', socket, ...args], {
        env,
        encoding: 'utf8',
        timeout: 3000,
      });
    const started: string[] = [];
    // spawnSync returns each failure so one missing server cannot skip the next.
    const stopServers = () =>
      started.map((socket) =>
        spawnSync('tmux', ['-S', socket, 'kill-server'], {
          env,
          encoding: 'utf8',
          timeout: 3000,
        }),
      );
    t.after(() => {
      try {
        const results = stopServers();
        for (const result of results) {
          assert.ifError(result.error);
          // The regression below deliberately stops the first server early.
          if (result.status !== 0)
            assert.match(result.stderr, /No such file or directory|no server running/u);
        }
      } finally {
        rmSync(root, { recursive: true });
      }
    });
    for (const socket of sockets) {
      tmux(socket, 'new-session', '-d', '-s', 'fixture', '/bin/cat');
      started.push(socket);
    }
    const pane = tmux(sockets[0], 'display-message', '-p', '-t', 'fixture', '#{pane_id}').trim();
    const launchEnv = { ...env, TMUX_TMPDIR: root, TMUX_PANE: pane };
    // custom.sock is learned from lsof, not inherited TMUX or a default directory.
    profile(root, launchEnv);
    const sandbox = readFileSync(path.join(root, 'boundary/sandbox.sb'), 'utf8');
    assert.ok(sandbox.includes(`(literal "${sockets[1]}")`), sandbox);
    // These servers did not exist when lsof and profile generation ran.
    const lateRoot = path.join(root, 'late');
    mkdirSync(lateRoot);
    const lateDirectory = path.join(lateRoot, `tmux-${process.getuid!()}`);
    mkdirSync(lateDirectory, { mode: 0o700 });
    const lateSockets = [path.join(lateDirectory, 'default'), path.join(lateRoot, 'explicit.sock')];
    execFileSync('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '/bin/cat'], {
      env: { ...env, TMUX_TMPDIR: lateRoot },
      encoding: 'utf8',
      timeout: 3000,
    });
    started.push(lateSockets[0]);
    tmux(lateSockets[1], 'new-session', '-d', '-s', 'fixture', '/bin/cat');
    started.push(lateSockets[1]);
    const alias = path.join(root, 'alias.sock');
    symlinkSync(sockets[1], alias);
    const hardAlias = path.join(root, 'hard.sock');
    linkSync(sockets[1], hardAlias);
    const marker = path.join(root, 'escaped');
    for (const prefix of [
      `TMUX_TMPDIR=${q(root)} tmux`,
      `TMUX_TMPDIR=${q(lateRoot)} tmux`,
      ...[
        ...lateSockets,
        ...sockets,
        ...sockets.map((s) => s.replace('/private/tmp/', '/tmp/')),
        alias,
        hardAlias,
      ].map((s) => `tmux -S ${q(s)}`),
    ]) {
      for (const action of [
        `new-session -d -s escape ${q(`touch ${q(marker)}`)}`,
        `run-shell -t fixture ${q(`touch ${q(marker)}`)}`,
        `send-keys -t fixture injected Enter`,
      ]) {
        const result = worker(root, `${prefix} ${action}`, launchEnv);
        assert.ifError(result.error);
        assert.notEqual(result.status, 0, `${prefix} ${action}`);
        assert.match(result.stderr, /Operation not permitted|Permission denied/u);
      }
    }
    const identity = worker(
      root,
      `test -z "\${TMUX-}\${TMUX_TMPDIR-}" && test "$TMUX_PANE" = ${q(pane)}`,
      launchEnv,
    );
    assert.equal(identity.status, 0, identity.stderr);
    assert.equal(existsSync(marker), false);
    assert.doesNotMatch(tmux(sockets[0], 'capture-pane', '-p', '-t', 'fixture'), /injected/u);
    // The trusted caller outside the sandbox still controls its own private pane.
    tmux(sockets[0], 'send-keys', '-t', 'fixture', 'observable', 'Enter');
    assert.match(tmux(sockets[0], 'capture-pane', '-p', '-t', 'fixture'), /observable/u);
    for (const socket of lateSockets)
      assert.doesNotMatch(tmux(socket, 'capture-pane', '-p', '-t', 'fixture'), /injected/u);
    // Prove teardown still reaches the second server when the first is gone.
    tmux(sockets[0], 'kill-server');
    const cleanup = stopServers();
    assert.notEqual(cleanup[0].status, 0);
    assert.equal(cleanup[1].status, 0, cleanup[1].stderr);

    t.diagnostic(
      'new-session/run-shell/send-keys denied for existing and post-profile private servers; trusted control passed; cleanup attempted every server',
    );
  },
);

test(
  'same-UID ownership and headless Chrome CDP work under the retained outer seatbelt',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    t.after(async () => {
      try {
        await stopWebDappBrowser(root, {
          runtimeDir: path.join(root, 'temp/recipe/runtime/terminal'),
        });
      } finally {
        rmSync(root, { recursive: true });
      }
    });
    const assigned = net.createServer((socket) => socket.end());
    assigned.listen(0, '127.0.0.1');
    await once(assigned, 'listening');
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          assigned.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = assigned.address();
    assert.ok(address && typeof address !== 'string');
    const assignedPort = address.port;
    profile(root, env, { cdp_port: assignedPort });
    const allocatedPort = JSON.parse(
      readFileSync(path.join(root, 'state.json'), 'utf8'),
    ).browserCdpPort;
    assert.notEqual(allocatedPort, assignedPort);
    // A retained dispatch must preserve the task's already published endpoint.
    profile(root, env, { cdp_port: assignedPort });
    assert.equal(
      JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8')).browserCdpPort,
      allocatedPort,
    );
    writeFileSync(
      path.join(root, 'adapter-launch.mjs'),
      `
import assert from 'node:assert/strict';
import { createWebDappAdapter } from ${JSON.stringify(path.join(adapter, 'src/web-dapp/index.mjs'))};
const adapter = createWebDappAdapter();
const resources = adapter.runtimeContext.resources({ existing: { cdpPort: ${assignedPort} }, defaults: {}, envPort: (...names) => {
  const value = names.map(name => process.env[name]).find(Boolean);
  return value ? Number(value) : undefined;
} });
assert.equal(resources.cdpPort, ${allocatedPort});
await adapter.launch({
  options: { cdpPort: String(${assignedPort}), watcherPort: process.argv[2], signer: 'injected', account: 'dev1', headless: true, freshProfile: true },
  target: ${JSON.stringify(root)}, jsonOutput: true,
  stream: { phase() {}, complete(status, code) { if (status !== 'pass' || code !== 0) process.exitCode = 1; } },
  usage(message) { throw new Error(message); },
});
`,
    );

    const probe = path.join(root, 'probe.mjs');
    const hidden = path.join(root, 'hidden');
    mkdirSync(hidden);
    writeFileSync(path.join(hidden, 'hidden'), 'synthetic hidden input');
    writeFileSync(
      path.join(root, 'base-policy.mjs'),
      readFileSync(path.join(adapter, 'test/fixtures/web-dapp-policy.mjs'), 'utf8'),
    );
    writeFileSync(
      path.join(root, 'policy.mjs'),
      `import { policy as base } from './base-policy.mjs';
export const policy = { ...base, module: import.meta.filename, venueHosts: () => ({ blocked: ['mainnet.example.invalid'], served: [], servedCheck: 'not-applicable' }) };`,
    );
    // Public development mnemonic, synthetic account only.
    writeFileSync(
      path.join(root, 'wallet.json'),
      JSON.stringify({
        password: 'fixture-only',
        accounts: [
          {
            name: 'dev1',
            type: 'mnemonic',
            value: 'test test test test test test test test test test test junk',
          },
        ],
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      probe,
      `
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { ownCleanup } from './owned-cleanup.mjs';
import { launchWebDappBrowser } from ${JSON.stringify(path.join(adapter, 'src/web-dapp/launch.mjs'))};
import { CdpClient } from ${JSON.stringify(path.join(adapter, 'src/web-dapp/lib/cdp-client.mjs'))};
import { processInfo } from ${JSON.stringify(path.join(adapter, 'src/web-dapp/lib/process-info.mjs'))};
import { ownsProcess, stopWebDappBrowser } from ${JSON.stringify(path.join(adapter, 'src/web-dapp/lib/processes.mjs'))};
const root = ${JSON.stringify(root)};
process.env.RECIPE_WEB_DAPP_POLICY = root + '/policy.mjs';
process.env.RECIPE_WALLET_FIXTURE = root + '/wallet.json';
if (${JSON.stringify(process.env.SEATBELT_TEST_CHROME ?? '')}) process.env.TERMINAL_CHROME_BIN = ${JSON.stringify(process.env.SEATBELT_TEST_CHROME ?? '')};
assert.notEqual(spawnSync('/bin/ps', ['-p', String(process.pid)]).status, 0);
assert.throws(() => readFileSync(root + '/hidden/hidden'), { code: 'EPERM' });
const app = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Seatbelt fixture</title><p>Synthetic app</p>'); });

const runtime = root + '/temp/recipe/runtime/terminal';
const stop = () => stopWebDappBrowser(root, { runtimeDir: runtime });
const mode = process.argv[2] ?? 'normal';
const parent = Number(process.argv[3] ?? ${process.pid});
let launching;
const close = server => new Promise((resolve, reject) => {
  if (!server.listening) return resolve();
  server.close(error => error ? reject(error) : resolve());
  server.closeAllConnections?.();
});
const cleanup = ownCleanup(parent, async () => {
  try { await launching; }
  finally {
    try { await stop(); }
    finally { await close(app); }
  }
});
try {
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const cdpPort = Number(process.env.RECIPE_CDP_PORT);
  assert.equal(cdpPort, ${allocatedPort});
  assert.equal(Number(process.env.CDP_PORT), cdpPort);
  await assert.rejects(fetch('http://127.0.0.1:${assignedPort}/json/version', { signal: AbortSignal.timeout(500) }));
  const args = { target: root, 'cdp-port': ${assignedPort}, 'app-port': app.address().port, signer: 'injected', account: 'dev1', headless: true, 'fresh-profile': true };
  launching = mode === 'normal'
    ? promisify(execFile)(process.execPath, [root + '/adapter-launch.mjs', String(app.address().port)], { timeout: 30000 }).then(({ stdout }) => JSON.parse(stdout))
    : launchWebDappBrowser(args, process.env, { timeouts: { browserStartMs: 10000, hostReadyMs: 15000 } });
  const state = await launching;
  assert.equal(state.cdpPort, cdpPort);
  assert.equal(state.browser.launchMethod, 'spawn');
  assert.equal(state.browser.outerSeatbelt, true);
  const { register } = await import(${JSON.stringify(import.meta.resolve('tsx/esm/api'))});
  const unregister = register({ tsconfig: ${JSON.stringify(fileURLToPath(new URL('../../../../packages/cli/tsconfig.json', import.meta.url)))} });
  const { createAdapterRegistry } = await import(${JSON.stringify(new URL('../../../../packages/adapter-sdk/src/index.ts', import.meta.url).href)});
  const { createWebDappAdapter } = await import(${JSON.stringify(path.join(adapter, 'src/web-dapp/index.mjs'))});
  const { configureHarnessAdapters, harnessAdapter } = await import(${JSON.stringify(new URL('../../../../packages/recipe-cli/src/harness/adapters.ts', import.meta.url).href)});
  const { activateRecipeRuntimeEnvironment } = await import(${JSON.stringify(new URL('../../../../packages/recipe-cli/src/harness/run-engine.ts', import.meta.url).href)});
  const { recipeRunOptionsFromCli } = await import(${JSON.stringify(new URL('../../../../packages/recipe-cli/src/harness/run-options.ts', import.meta.url).href)});
  const adapter = createWebDappAdapter();
  const registry = createAdapterRegistry();
  registry.register({ ...adapter, resolveSlotPorts() {
    // The Extension adapter's context/pool rung overwrites both inherited ports.
    process.env.CDP_PORT = String(${assignedPort});
    process.env.RECIPE_CDP_PORT = String(${assignedPort});
  } });
  configureHarnessAdapters(registry);
  harnessAdapter(adapter.id).resolveSlotPorts(root);
  const options = recipeRunOptionsFromCli(adapter.id, { cdpPort: String(${assignedPort}) });
  const restore = activateRecipeRuntimeEnvironment(adapter.id, root, options);
  let version;
  try {
    const runtimePort = Number(process.env.CDP_PORT);
    version = await fetch('http://127.0.0.1:' + runtimePort + '/json/version').then(r => r.json());
    assert.equal(runtimePort, cdpPort);
    assert.equal(options.cdpPort, String(cdpPort));
    assert.equal(process.env.RECIPE_CDP_PORT, String(cdpPort));
  } finally { restore(); unregister(); }

  assert.ok(version.webSocketDebuggerUrl);
  const client = await CdpClient.connect(version.webSocketDebuggerUrl);
  try {
    const { targetId } = await client.send('Target.createTarget', { url: 'http://127.0.0.1:' + app.address().port });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    let title;
    const deadline = Date.now() + 3000;
    do {
      title = (await client.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId)).result.value;
      if (title === 'Seatbelt fixture') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.equal(title, 'Seatbelt fixture');
    await client.send('Target.closeTarget', { targetId });
  } finally { client.close(); }
  assert.equal(ownsProcess('browser', state.browserPid, runtime), true);
  assert.equal(ownsProcess('browser', state.browserPid, runtime + '-foreign'), false);
  const info = processInfo(state.browserPid);
  assert.ok(info.state);
  assert.ok(info.startedAt);
  assert.equal(info.pgid, state.browserPid);
  assert.equal(info.startedAt, processInfo(state.browserPid).startedAt);
  assert.ok(info.argv.includes('--no-sandbox'));
  if (mode !== 'normal') {
    writeFileSync(root + '/ready-' + mode + '.json', JSON.stringify({ probePid: process.pid, browserPid: state.browserPid, hostPid: state.hostPid, appPort: app.address().port, cdpPort }));
    await new Promise(() => {});
  }
  const reused = await launchWebDappBrowser({ ...args, 'fresh-profile': false });
  assert.equal(reused.reused, true);
  assert.equal(reused.browserPid, state.browserPid);
  const stopped = await stop();
  assert.equal(stopped.stopped.length, 2);
  console.log('ps denied; ownership/group/state/start identity passed; production adapter launch remapped assigned slot CDP to allocated recipe port; configured port denied; harness launched and reused Chrome; recipe slot resolution and explicit slot flags remapped to trial CDP; recipe-style CDP target/evaluation passed; Chrome CDP served; outer read denial retained');
} finally {
  await cleanup();
}
`,
    );
    const result = worker(root, `exec ${q(process.execPath)} ${q(probe)}`);
    assert.ifError(result.error);
    const browserLog = path.join(root, 'temp/recipe/runtime/terminal/browser.log');
    assert.equal(
      result.status,
      0,
      result.stderr + (existsSync(browserLog) ? readFileSync(browserLog, 'utf8') : ''),
    );
    assert.match(result.stdout, /Chrome CDP served; outer read denial retained/u);
    t.diagnostic(result.stdout.trim());
    for (const mode of ['SIGTERM', 'SIGINT', 'parent-death'] as const) {
      await t.test(`full cleanup on ${mode}`, async (childTest) => {
        const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)'], {
          env,
          stdio: 'ignore',
        });
        childTest.after(async () => {
          if (parent.exitCode === null && parent.signalCode === null) {
            const exited = once(parent, 'exit');
            parent.kill();
            await exited;
          }
        });
        await once(parent, 'spawn');
        const child = spawn(
          '/bin/sh',
          [
            '-c',
            withBlindTrialBoundary(
              `exec ${q(process.execPath)} ${q(probe)} ${q(mode)} ${parent.pid}`,
              { capsule: root, baseSha: 'a'.repeat(40), browserCdpPort: allocatedPort },
            ).replace('/usr/bin/env -i', 'exec /usr/bin/env -i'),
          ],
          { env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const exited = once(child, 'exit');
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        // SIGTERM invokes the same complete cleanup if an assertion fails.
        childTest.after(async () => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            const deadline = Date.now() + 3000;
            while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
              await delay(25);
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await exited;
          }
          await stopWebDappBrowser(root, {
            runtimeDir: path.join(root, 'temp/recipe/runtime/terminal'),
          });
        });
        const ready = path.join(root, `ready-${mode}.json`);
        const deadline = Date.now() + 20000;
        while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline)
          await delay(25);
        assert.ok(existsSync(ready), stderr);
        const state = JSON.parse(readFileSync(ready, 'utf8'));
        if (mode === 'parent-death') {
          const parentExited = once(parent, 'exit');
          parent.kill();
          await parentExited;
        } else process.kill(state.probePid, mode);
        const exitDeadline = Date.now() + 3000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < exitDeadline)
          await delay(25);
        assert.ok(
          child.exitCode !== null || child.signalCode !== null,
          `${mode} did not exit after cleanup`,
        );
        const [code, signal] = await exited;
        assert.equal(code, 0, stderr);
        assert.equal(signal, null);
        for (const pid of [state.browserPid, state.hostPid])
          assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        for (const port of [state.appPort, state.cdpPort]) {
          await assert.rejects(
            fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }),
          );
        }
      });
    }
  },
);

test(
  'worker tools and DNS work with only the system resolver Unix socket allowed',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true }));
    profile(root);
    const pi = execFileSync('/usr/bin/which', ['pi'], { env, encoding: 'utf8' }).trim();
    const piProbe = path.join(root, 'pi-probe.mjs');
    writeFileSync(
      piProbe,
      String.raw`
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { ownCleanup } from './owned-cleanup.mjs';
const root = ${JSON.stringify(root)};
const mode = process.argv[2] ?? 'normal';
const server = http.createServer((req, res) => {
  req.resume();
  if (mode !== 'normal') {
    if (mode !== 'readiness-timeout') writeFileSync(root + '/pi-ready-' + mode + '.json', JSON.stringify({ probePid: process.pid, piPid: child.pid }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'seatbelt-fixture-ok' }, finish_reason: null }] };
  res.write('data: ' + JSON.stringify(chunk) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
let child;
const cleanup = ownCleanup(Number(process.argv[3] ?? ${process.pid}), async () => {
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      const escalation = setTimeout(() => child.kill('SIGKILL'), 500);
      try { await closed; }
      finally { clearTimeout(escalation); }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
  }
});
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const agent = root + '/pi-agent-' + mode;
  mkdirSync(agent);
  const extension = agent + '/fixture-extension.mjs';
  writeFileSync(extension, "import { writeFileSync } from 'node:fs'; export default function(pi) { pi.on('session_start', () => writeFileSync(" + JSON.stringify(agent + '/extension-loaded') + ", 'synthetic extension loaded')); }");
  writeFileSync(agent + '/models.json', JSON.stringify({ providers: { 'seatbelt-fixture': {
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', api: 'openai-completions', apiKey: 'fixture-only',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 }],
  } } }));
  child = spawn(${JSON.stringify(pi)}, ['--offline', '--print', '--no-session', '--no-tools', '--no-extensions', '--extension', extension, '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--provider', 'seatbelt-fixture', '--model', 'fixture', '--system-prompt', 'Synthetic fixture only.', 'Reply with seatbelt-fixture-ok'], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(root + '/pi-spawned-' + mode + '.json', JSON.stringify({ piPid: child.pid }));
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  if (mode !== 'normal') {
    assert.ok(signal, 'interrupted Pi should be terminated');
  } else {
    assert.equal(code, 0, stderr);
    assert.match(stdout, /seatbelt-fixture-ok/u);
    assert.equal((await import('node:fs')).readFileSync(agent + '/extension-loaded', 'utf8'), 'synthetic extension loaded');
    console.log('pi loaded its synthetic extension and completed a turn through a local synthetic provider');
  }
} finally {
  await cleanup();
}
`,
    );
    for (const command of [
      `${q(pi)} --version`,
      `${q(pi)} --help`,
      `exec ${q(process.execPath)} ${q(piProbe)}`,
      `git init -q ${q(path.join(root, 'tools'))} && git -C ${q(path.join(root, 'tools'))} status --porcelain && printf fixture | git hash-object --stdin`,
      `${q(process.execPath)} --input-type=module -e ${q("import dns from 'node:dns/promises'; import { spawnSync } from 'node:child_process'; import assert from 'node:assert/strict'; assert.ok((await dns.lookup('example.com')).address); assert.equal(spawnSync('/usr/bin/true').status, 0); console.log('Node DNS and child spawning passed');")}`,
    ]) {
      const result = worker(root, command);
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    }
    for (const mode of [
      'timeout',
      'SIGTERM',
      'SIGINT',
      'parent-death',
      'readiness-timeout',
    ] as const) {
      await t.test(`interrupted pi fixture cleans up on ${mode}`, async (childTest) => {
        const ready = path.join(root, `pi-ready-${mode}.json`);
        const spawned = path.join(root, `pi-spawned-${mode}.json`);
        let cleanupProbe: (() => Promise<void>) | undefined;
        // A failed regression must still reap the owned fixture child.
        childTest.after(async () => {
          await (cleanupProbe?.() ?? Promise.resolve()).finally(() => {
            if (existsSync(spawned)) {
              const { piPid } = JSON.parse(readFileSync(spawned, 'utf8'));
              try {
                process.kill(piPid, 'SIGKILL');
              } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
                  throw error;
              }
            }
          });
        });
        if (mode === 'timeout') {
          const result = worker(
            root,
            `exec ${q(process.execPath)} ${q(piProbe)} timeout`,
            env,
            3000,
          );
          assert.ok(result.error && 'code' in result.error);
          assert.equal(result.error.code, 'ETIMEDOUT');
        } else {
          const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100)'], {
            env,
            stdio: 'ignore',
          });
          const parentExited = once(parent, 'exit');
          childTest.after(async () => {
            parent.kill();
            await parentExited;
          });
          await once(parent, 'spawn');
          const child = spawn(
            '/bin/sh',
            [
              '-c',
              withBlindTrialBoundary(
                `exec ${q(process.execPath)} ${q(piProbe)} ${q(mode)} ${parent.pid}`,
                { capsule: root, baseSha: 'a'.repeat(40) },
              ).replace('/usr/bin/env -i', 'exec /usr/bin/env -i'),
            ],
            { env, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          const exited = once(child, 'exit');
          let stderr = '';
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
          });
          cleanupProbe = async () => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGTERM');
              const deadline = Date.now() + 3000;
              while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
                await delay(25);
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }
            await exited;
          };
          if (mode === 'readiness-timeout') {
            const spawnDeadline = Date.now() + 10000;
            while (!existsSync(spawned) && child.exitCode === null && Date.now() < spawnDeadline)
              await delay(25);
            assert.ok(existsSync(spawned), stderr);
            const { piPid } = JSON.parse(readFileSync(spawned, 'utf8'));
            process.kill(piPid, 0);
          }
          const deadline = Date.now() + (mode === 'readiness-timeout' ? 100 : 10000);
          while (
            !existsSync(ready) &&
            child.exitCode === null &&
            child.signalCode === null &&
            Date.now() < deadline
          )
            await delay(25);
          if (mode !== 'readiness-timeout') assert.ok(existsSync(ready), stderr);
          if (mode === 'readiness-timeout') {
            assert.equal(existsSync(ready), false, 'Pi readiness must time out');
            await cleanupProbe();
            const { piPid } = JSON.parse(readFileSync(spawned, 'utf8'));
            // Assert before the fallback hook can hide an orphaned Pi.
            assert.throws(() => process.kill(piPid, 0), { code: 'ESRCH' });
          } else if (mode === 'parent-death') {
            parent.kill();
            await parentExited;
          } else child.kill(mode);
          const exitDeadline = Date.now() + 3000;
          while (child.exitCode === null && child.signalCode === null && Date.now() < exitDeadline)
            await delay(25);
          assert.ok(
            child.exitCode !== null || child.signalCode !== null,
            `${mode} did not exit after cleanup`,
          );
          const [code, signal] = await exited;
          assert.equal(code, 0, stderr);
          assert.equal(signal, null);
        }
        if (mode !== 'readiness-timeout')
          assert.ok(existsSync(ready), 'Pi must reach the synthetic provider before interruption');
        const { piPid } = JSON.parse(readFileSync(spawned, 'utf8'));
        assert.throws(() => process.kill(piPid, 0), { code: 'ESRCH' });
      });
    }
    t.diagnostic(
      'pi local-provider turn and version/help, Git repository/hash operations, Node DNS/child spawning passed with only mDNSResponder allowed; syslog needs no exception; Chrome/CDP covered separately',
    );
  },
);

test(
  'worker shells start without operator startup files or their secrets',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true }));
    // Synthetic operator home: startup files are links into a dotfiles checkout
    // and source a secrets file, as on farm hosts. Fake values only.
    const home = path.join(root, 'home');
    const dotfiles = path.join(root, 'dotfiles');
    mkdirSync(path.join(home, '.config/secrets'), { recursive: true });
    mkdirSync(dotfiles);
    const secrets = path.join(home, '.config/secrets/env.zsh');
    writeFileSync(secrets, 'export FAKE_SECRET=fixture-value\n');
    const startup = `export FAKE_SECRET=fixture-value\n. ${q(secrets)}\n`;
    for (const name of ['zshenv', 'zshrc', 'zprofile']) {
      writeFileSync(path.join(dotfiles, name), startup);
      symlinkSync(path.join(dotfiles, name), path.join(home, `.${name}`));
    }
    for (const name of ['.bashrc', '.bash_profile', '.profile'])
      writeFileSync(path.join(home, name), startup);
    const launchEnv = {
      ...env,
      HOME: home,
      FAKE_SECRET: 'fixture-value',
      BASH_ENV: path.join(home, '.bashrc'),
      ENV: path.join(home, '.profile'),
    };
    profile(root, launchEnv);
    const shells = ['env', 'zsh -c env', 'bash -lc env', 'zsh -ic env', 'bash -ic env'];
    const script = [
      ...shells.map((shell) => `echo ${q(`== ${shell}`)}; ${shell} </dev/null 2>&1`),
      // Seatbelt alone: a worker that drops the boundary's ZDOTDIR still reads nothing.
      'echo "== unset ZDOTDIR"; (unset ZDOTDIR; zsh -lic env) </dev/null 2>&1',
      ...[path.join(home, '.zshenv'), path.join(dotfiles, 'zshenv'), secrets].map(
        (file) => `if cat ${q(file)} >/dev/null 2>&1; then echo READ; else echo DENIED; fi`,
      ),
    ].join('; ');
    const started = Date.now();
    const result = worker(root, script, launchEnv);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(output, /fixture-value|FAKE_SECRET/u);
    assert.equal(output.match(/^HOME=/gmu)?.length, shells.length + 1, 'each shell printed env');
    assert.deepEqual(output.match(/^(?:READ|DENIED)$/gmu), ['DENIED', 'DENIED', 'DENIED']);
    t.diagnostic(`six shells and three reads checked in ${Date.now() - started}ms`);
  },
);

test(
  'worker ps cannot print other processes environments while its own tools keep working',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = fixture();
    const secretEnv = { ...env, FAKE_SECRET: 'fixture-value' };
    // Same-uid stand-ins holding a fake secret: gateway, private tmux server and pane.
    const gateway = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: secretEnv,
      stdio: 'ignore',
    });
    const socketDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ps-tmux-')));
    const socket = path.join(socketDir, 's');
    t.after(() => {
      gateway.kill('SIGKILL');
      spawnSync('tmux', ['-S', socket, 'kill-server'], { env });
      rmSync(socketDir, { recursive: true, force: true });
      rmSync(root, { recursive: true });
    });
    execFileSync('tmux', ['-S', socket, '-f', '/dev/null', 'new-session', '-d', 'sleep 300'], {
      env: secretEnv,
    });
    const tmuxServer = execFileSync('tmux', ['-S', socket, 'display-message', '-p', '#{pid}'], {
      env,
      encoding: 'utf8',
    }).trim();
    const tmuxPane = execFileSync('tmux', ['-S', socket, 'display-message', '-p', '#{pane_pid}'], {
      env,
      encoding: 'utf8',
    }).trim();
    profile(root, env);
    const repo = path.join(root, 'tools-repo');
    const nodeTest = path.join(root, 'tiny.test.mjs');
    writeFileSync(nodeTest, "import test from 'node:test'; test('tiny', () => {});\n");
    const others = [String(gateway.pid), tmuxServer, tmuxPane];
    // $PPID is the launching shell, the stand-in for Pi's parent, which also holds the secret.
    const script = [
      'set -u',
      ...[...others, '$PPID'].flatMap((pid) => [
        `ps eww -p ${pid} 2>&1`,
        `ps -E -p ${pid} 2>&1`,
        `ps -ww e -p ${pid} 2>&1`,
        `/bin/ps eww -p ${pid} 2>&1`,
      ]),
      'ps eww -ax 2>&1',
      'ps -e 2>&1',
      'echo ==own',
      '/bin/sleep 30 & child=$!',
      'ps -o pid=,command= -p "$child"',
      'ps -ax -o pid=,ppid= | awk -v c="$child" -v p="$$" \'$1 == c && $2 == p { print "OWN-CHILD-LISTED" }\'',
      'ps -ww -p $$ -o lstart= >/dev/null && echo OWN-LSTART',
      'kill "$child"',
      `git init -q ${q(repo)} && git -C ${q(repo)} -c user.name=f -c user.email=f@example.invalid commit -q --allow-empty -m fixture && git -C ${q(repo)} rev-parse --verify -q HEAD >/dev/null && echo GIT-OK`,
      `${q(process.execPath)} --test ${q(nodeTest)} >/dev/null 2>&1 && echo NODE-TEST-OK`,
    ].join('\n');
    const started = Date.now();
    const result = spawnSync(
      '/bin/sh',
      [
        '-c',
        withBlindTrialBoundary(script, {
          capsule: fixtureCapsules.get(root) ?? root,
          baseSha: 'a'.repeat(40),
        }),
      ],
      { env: secretEnv, encoding: 'utf8', timeout: 45_000 },
    );
    const elapsed = Date.now() - started;
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.doesNotMatch(output, /fixture-value|FAKE_SECRET/u);
    const [denied = '', own = ''] = output.split('==own');
    assert.ok(denied.includes('environment output is unavailable'), denied);
    for (const marker of [
      '/bin/sleep 30',
      'OWN-CHILD-LISTED',
      'OWN-LSTART',
      'GIT-OK',
      'NODE-TEST-OK',
    ])
      assert.ok(own.includes(marker), `${marker}\n${own}`);
    // Residual, documented in blind-environment.md: Seatbelt cannot filter a raw
    // KERN_PROCARGS2 sysctl, so a deliberate read still sees same-uid environments.
    t.diagnostic(
      `ps forms refused for gateway, tmux server, pane and parent; own tools passed in ${elapsed}ms`,
    );
  },
);
