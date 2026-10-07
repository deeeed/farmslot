import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { nodeDependencyBlock, pnpNodeOptions, yarnInstallCommand } from '../src/index.js';

// Temp directories this file makes, removed when its tests end.
const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function checkout(files: Record<string, string> = {}): string {
  const root = tempDir('adapter-node-deps-');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const TSX = { 'node_modules/.bin/tsx': '' };
const RUNTIME_DEP = {
  'node_modules/fixture-runtime-dep/package.json':
    '{"name":"fixture-runtime-dep","main":"index.js"}',
  'node_modules/fixture-runtime-dep/index.js': '',
};

test('missing node_modules is a missing install', () => {
  const root = checkout();
  assert.deepEqual(nodeDependencyBlock(root, { label: 'core' }), {
    code: 'CORE_DEPS_MISSING',
    message: 'core dependencies are not installed (node_modules is missing).',
    userAction: yarnInstallCommand(root),
  });
  const linked = checkout({ '.yarnrc.yml': 'nodeLinker: node-modules\n' });
  assert.equal(
    nodeDependencyBlock(linked, { label: 'core' })?.message,
    'core dependencies are not installed (nodeLinker requires node_modules, but node_modules is missing).',
  );
});

test('Yarn PnP needs only .pnp.cjs', () => {
  const root = checkout({ '.yarnrc.yml': 'nodeLinker: "pnp"\n' });
  assert.deepEqual(nodeDependencyBlock(root, { runtimeDeps: ['fixture-runtime-dep'] }), {
    code: 'NODE_DEPS_MISSING',
    message: 'node dependencies are not installed for Yarn PnP (.pnp.cjs is missing).',
    userAction: yarnInstallCommand(root),
  });
  fs.writeFileSync(path.join(root, '.pnp.cjs'), '');
  assert.equal(nodeDependencyBlock(root, { runtimeDeps: ['fixture-runtime-dep'] }), null);
});

test('a missing bin or runtime dependency is an incomplete install', () => {
  const noTsx = checkout({ 'node_modules/.keep': '' });
  // No bins required by default: a checkout needs no repo-local runner.
  assert.equal(nodeDependencyBlock(noTsx, { label: 'core' }), null);
  assert.deepEqual(nodeDependencyBlock(noTsx, { label: 'core', bins: ['tsx'] }), {
    code: 'CORE_DEPS_INCOMPLETE',
    message: 'core dependencies are incomplete (node_modules/.bin/tsx is missing).',
    userAction: yarnInstallCommand(noTsx),
  });

  const noDep = checkout(TSX);
  assert.deepEqual(nodeDependencyBlock(noDep, { label: 'core', runtimeDeps: ['immer-absent'] }), {
    code: 'CORE_DEPS_INCOMPLETE',
    message:
      'core dependencies are incomplete (cannot resolve immer-absent from the target checkout).',
    userAction: yarnInstallCommand(noDep),
  });
});

test('resolveBin decides where a bin may come from', () => {
  // Core after core#10564: no node_modules/.bin/tsx, but the harness ships one.
  const root = checkout({ 'node_modules/.keep': '' });
  const asked: string[] = [];
  const resolveBin = (target: string, bin: string) => {
    asked.push(`${target}:${bin}`);
    return bin === 'tsx' ? '/harness/node_modules/.bin/tsx' : null;
  };
  assert.equal(nodeDependencyBlock(root, { label: 'core', bins: ['tsx'], resolveBin }), null);
  assert.deepEqual(asked, [`${root}:tsx`]);
  assert.deepEqual(
    nodeDependencyBlock(root, { label: 'core', bins: ['tsx'], resolveBin: () => null }),
    {
      code: 'CORE_DEPS_INCOMPLETE',
      message: 'core dependencies are incomplete (no tsx runtime found for the checkout).',
      userAction: yarnInstallCommand(root),
    },
  );
  // A host whose runner lives outside the checkout says how to provide it.
  assert.equal(
    nodeDependencyBlock(root, {
      bins: ['tsx'],
      resolveBin: () => null,
      missingBinAction: (_target, bin) => `set ${bin.toUpperCase()}_BIN`,
    })?.userAction,
    'set TSX_BIN',
  );
});

test('all present is no block; options shape codes, bins and the next step', () => {
  const root = checkout({ ...TSX, ...RUNTIME_DEP });
  assert.equal(nodeDependencyBlock(root, { runtimeDeps: ['fixture-runtime-dep'] }), null);
  const block = nodeDependencyBlock(root, {
    label: 'my-app',
    bins: ['vitest'],
    installCommand: () => 'pnpm install',
  });
  assert.deepEqual(block, {
    code: 'MY_APP_DEPS_INCOMPLETE',
    message: 'my-app dependencies are incomplete (node_modules/.bin/vitest is missing).',
    userAction: 'pnpm install',
  });
  assert.equal(
    nodeDependencyBlock(root, { label: 'my-app', codePrefix: 'APP', bins: ['x'] })?.code,
    'APP_DEPS_INCOMPLETE',
  );
});

test('an ESM-only runtime dependency counts as installed', () => {
  const root = checkout({
    ...TSX,
    'node_modules/fixture-esm-only/package.json':
      '{"name":"fixture-esm-only","exports":{".":{"import":"./index.mjs"}}}',
    'node_modules/fixture-esm-only/index.mjs': '',
  });
  assert.equal(nodeDependencyBlock(root, { runtimeDeps: ['fixture-esm-only'] }), null);
});

test('an unexpected resolver error propagates instead of reading as missing', () => {
  const root = checkout({
    ...TSX,
    'node_modules/fixture-broken/package.json': '{ not json',
  });
  assert.throws(
    () => nodeDependencyBlock(root, { runtimeDeps: ['fixture-broken'] }),
    (error: NodeJS.ErrnoException) => error.code !== 'MODULE_NOT_FOUND',
  );
});

test('yarnInstallCommand quotes the resolved target', () => {
  assert.equal(
    yarnInstallCommand("/tmp/it's here"),
    `cd '/tmp/it'\\''s here' && yarn install --immutable`,
  );
});

test('pnpNodeOptions adds the PnP loader only for a PnP install', () => {
  const plain = checkout();
  assert.equal(pnpNodeOptions(plain, '--max-old-space-size=4096'), '--max-old-space-size=4096');
  const pnp = checkout({ '.yarnrc.yml': 'nodeLinker: pnp\n' });
  assert.equal(pnpNodeOptions(pnp, undefined), undefined);
  fs.writeFileSync(path.join(pnp, '.pnp.cjs'), '');
  const loader = `--require ${path.join(pnp, '.pnp.cjs')}`;
  assert.equal(pnpNodeOptions(pnp, undefined), loader);
  assert.equal(pnpNodeOptions(pnp, '--inspect'), `--inspect ${loader}`);
});
