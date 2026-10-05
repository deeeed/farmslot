import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { workspaceTsconfig, workspaceTsconfigEnv } from '../src/index.js';

function checkout(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-node-ws-'));
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '');
  }
  return root;
}

const PACKAGES = {
  '@acme/unbuilt': 'packages/unbuilt',
  '@acme/built': 'packages/built',
  '@acme/no-src': 'packages/no-src',
};

test('maps only unbuilt packages that have src/index.ts', () => {
  const root = checkout([
    'packages/unbuilt/src/index.ts',
    'packages/built/src/index.ts',
    'packages/built/dist/index.cjs',
    'packages/no-src/package.json',
  ]);
  const src = path.join(root, 'packages/unbuilt/src');
  assert.deepEqual(workspaceTsconfig(root, PACKAGES), {
    compilerOptions: {
      baseUrl: root,
      paths: {
        '@acme/unbuilt': [path.join(src, 'index.ts')],
        '@acme/unbuilt/*': [path.join(src, '*')],
      },
    },
  });
  assert.equal(workspaceTsconfig(root, { '@acme/built': 'packages/built' }), null);
});

test('workspaceTsconfigEnv writes the tsconfig and points tsx at it', async () => {
  const root = checkout(['packages/unbuilt/src/index.ts']);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-node-ws-tmp-'));
  const env = await workspaceTsconfigEnv(root, temp, { packages: PACKAGES, fileName: 'x.json' });
  const tsconfigPath = path.join(temp, 'x.json');
  assert.deepEqual(env, {
    TSX_TSCONFIG_PATH: tsconfigPath,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
  });
  assert.equal(
    fs.readFileSync(tsconfigPath, 'utf8'),
    `${JSON.stringify(workspaceTsconfig(root, PACKAGES), null, 2)}\n`,
  );

  const defaults = await workspaceTsconfigEnv(root, temp, { packages: PACKAGES });
  assert.equal(defaults.TSX_TSCONFIG_PATH, path.join(temp, 'node-adapter.tsconfig.json'));
});

test('workspaceTsconfigEnv adds the PnP loader and is empty when nothing maps', async () => {
  const root = checkout(['packages/unbuilt/src/index.ts', '.pnp.cjs']);
  fs.writeFileSync(path.join(root, '.yarnrc.yml'), 'nodeLinker: pnp\n');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-node-ws-tmp-'));
  const env = await workspaceTsconfigEnv(root, temp, { packages: PACKAGES });
  assert.ok(env.NODE_OPTIONS?.endsWith(`--require ${path.join(root, '.pnp.cjs')}`));

  assert.deepEqual(await workspaceTsconfigEnv(checkout([]), temp, { packages: PACKAGES }), {});
});
