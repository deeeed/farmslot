import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  checkoutWorkspacePackages,
  workspaceTsconfig,
  workspaceTsconfigEnv,
} from '../src/index.js';

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

test('maps every package that has src/index.ts, built or not', () => {
  // `built` holds a dist from an older build layout (core-6: dist/index.cjs while
  // its exports name dist/index.js); a script must still run its current src.
  const root = checkout([
    'packages/unbuilt/src/index.ts',
    'packages/built/src/index.ts',
    'packages/built/dist/index.cjs',
    'packages/no-src/package.json',
  ]);
  const unbuilt = path.join(root, 'packages/unbuilt/src');
  const built = path.join(root, 'packages/built/src');
  assert.deepEqual(workspaceTsconfig(root, PACKAGES), {
    compilerOptions: {
      baseUrl: root,
      paths: {
        '@acme/unbuilt': [path.join(unbuilt, 'index.ts')],
        '@acme/unbuilt/*': [path.join(unbuilt, '*')],
        '@acme/built': [path.join(built, 'index.ts')],
        '@acme/built/*': [path.join(built, '*')],
      },
    },
  });
  assert.equal(workspaceTsconfig(root, { '@acme/no-src': 'packages/no-src' }), null);
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

test('checkoutWorkspacePackages reads the workspaces the checkout declares', () => {
  const root = checkout([
    'packages/utils/src/index.ts',
    'tools/lint/x',
    'packages/no-manifest/src/index.ts',
  ]);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ workspaces: ['packages/*', 'tools/lint', 'packages/missing-parent/*'] }),
  );
  fs.writeFileSync(path.join(root, 'packages/utils/package.json'), '{"name":"@acme/utils"}');
  fs.writeFileSync(path.join(root, 'tools/lint/package.json'), '{"name":"@acme/lint"}');
  assert.deepEqual(checkoutWorkspacePackages(root), {
    '@acme/utils': 'packages/utils',
    '@acme/lint': 'tools/lint',
  });
  // A host passes the reader itself; the map is read from the checkout at run time.
  assert.deepEqual(
    Object.keys(workspaceTsconfig(root, checkoutWorkspacePackages)!.compilerOptions.paths),
    ['@acme/utils', '@acme/utils/*'],
  );

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ workspaces: { packages: ['tools/lint'] } }),
  );
  assert.deepEqual(checkoutWorkspacePackages(root), { '@acme/lint': 'tools/lint' });

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ workspaces: ['packages/**'] }),
  );
  assert.throws(
    () => checkoutWorkspacePackages(root),
    /workspace pattern "packages\/\*\*" is not supported/u,
  );
});

test('checkoutWorkspacePackages finds none in a target without a root package.json', () => {
  const root = checkout(['temp/recipe/runtime/wallet-fixture.json']);
  assert.deepEqual(checkoutWorkspacePackages(root), {});
  assert.equal(workspaceTsconfig(root, checkoutWorkspacePackages), null);
});
