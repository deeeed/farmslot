import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const plugin = fileURLToPath(new URL('../yarn-hardlink-store.cjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'yarn-hardlink-store-'));
  const controller = new AbortController();
  const pending = [];
  t.after(async () => {
    controller.abort();
    await Promise.allSettled(pending);
    rmSync(root, { recursive: true, force: true });
  });
  const command = (cwd, args, environment = {}) => {
    const request = run('yarn', args, {
      cwd,
      env: { ...process.env, YARN_ENABLE_TELEMETRY: 'false', ...environment },
      signal: controller.signal,
      timeout: 4000,
    });
    pending.push(request);
    return request;
  };
  return {
    root,
    command,
    install(project, globalFolder, cacheFolder, environment = {}) {
      return command(project.cwd, ['install'], {
        YARN_GLOBAL_FOLDER: globalFolder,
        YARN_CACHE_FOLDER: cacheFolder,
        YARN_NM_MODE: 'hardlinks-global',
        YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
        YARN_ENABLE_SCRIPTS: 'false',
        YARN_ENABLE_TELEMETRY: 'false',
        ...environment,
      });
    },
  };
}

function projectAt(root, name, guarded = true) {
  const cwd = path.join(root, name);
  mkdirSync(path.join(cwd, name), { recursive: true });
  writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({
      private: true,
      packageManager: 'yarn@4.5.3',
      dependencies: { [name]: `file:./${name}` },
    }),
  );
  writeFileSync(
    path.join(cwd, '.yarnrc.yml'),
    'nodeLinker: node-modules\nnmMode: hardlinks-global\n' +
      (guarded
        ? `enableGlobalCache: false\nenableMirror: false\nplugins:\n  - path: ${JSON.stringify(plugin)}\n`
        : ''),
  );
  writeFileSync(path.join(cwd, name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  writeFileSync(path.join(cwd, name, 'index.js'), 'module.exports = 42;\n');
  return { cwd, name };
}

function assertInstalled({ cwd, name }) {
  assert.equal(
    readFileSync(path.join(cwd, 'node_modules', name, 'index.js'), 'utf8'),
    'module.exports = 42;\n',
  );
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(cwd, 'node_modules', name, 'package.json'), 'utf8')),
    { name, version: '1.0.0' },
  );
  assert.ok(statSync(path.join(cwd, 'node_modules', name, 'index.js')).nlink > 1);
}

function assertSucceeded(outcome) {
  assert.equal(
    outcome.status,
    'fulfilled',
    outcome.status === 'rejected' ? outcome.reason.stdout || outcome.reason.message : undefined,
  );
}

test('concurrent guarded cold-store installs retain every dependency file', async (t) => {
  const context = fixture(t);
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = path.join(context.root, String(attempt));
    const projects = ['dep-a', 'dep-b'].map((name) => projectAt(base, name));
    const outcomes = await Promise.allSettled(
      projects.map((project) =>
        context.install(project, path.join(base, 'berry/farmslot'), path.join(base, 'berry/cache')),
      ),
    );
    outcomes.forEach(assertSucceeded);
    projects.forEach(assertInstalled);
  }
});

test('a stock client paused after observing no store resumes after a guarded install', async (t) => {
  const context = fixture(t);
  const stock = projectAt(context.root, 'stock-dep', false);
  const guarded = projectAt(context.root, 'guarded-dep');
  const [guardedFolder, stockFolder, guardedCache, stockCache] = await Promise.all([
    context.command(repoRoot, ['config', 'get', 'globalFolder']),
    context.command(stock.cwd, ['config', 'get', 'globalFolder']),
    context.command(repoRoot, ['config', 'get', 'cacheFolder']),
    context.command(stock.cwd, ['config', 'get', 'cacheFolder']),
  ]);
  assert.notEqual(guardedFolder.stdout.trim(), stockFolder.stdout.trim());
  assert.equal(guardedCache.stdout.trim(), stockCache.stdout.trim());
  const berry = path.join(context.root, 'berry');
  const store = path.join(berry, 'store/v1');
  const paused = path.join(context.root, 'paused');
  const resume = path.join(context.root, 'resume');
  const preload = path.join(context.root, 'pause-stock.cjs');
  writeFileSync(
    preload,
    `
const fs = require('node:fs');
const original = fs.exists;
let held = false;
fs.exists = (file, callback) => original(file, exists => {
  if (String(file) !== process.env.STOCK_STORE || exists || held) return callback(exists);
  held = true;
  fs.writeFileSync(process.env.STOCK_PAUSED, 'paused');
  const poll = () => fs.existsSync(process.env.STOCK_RESUME) ? callback(exists) : setTimeout(poll, 10);
  poll();
});
`,
  );
  const stockOutcome = context
    .install(stock, berry, path.join(berry, 'cache'), {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`.trim(),
      STOCK_STORE: store,
      STOCK_PAUSED: paused,
      STOCK_RESUME: resume,
    })
    .then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    );
  const deadline = Date.now() + 2000;
  while (!existsSync(paused) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(paused), 'the real stock client must reach its absent-store check');
  await context.install(guarded, path.join(berry, 'farmslot'), path.join(berry, 'cache'));
  assert.equal(
    existsSync(store),
    false,
    'guarded clients must not publish into the stock namespace',
  );
  assert.ok(existsSync(path.join(berry, 'farmslot/store/v1/ff')));
  writeFileSync(resume, 'resume');
  assertSucceeded(await stockOutcome);
  [stock, guarded].forEach(assertInstalled);
});
