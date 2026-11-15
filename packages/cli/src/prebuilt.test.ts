import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL('..', import.meta.url));

/**
 * A two-package snapshot shaped like an installed CLI: packages/cli imports a workspace package
 * through the tsconfig `paths`, a relative module, and TypeScript from outside the packages.
 */
async function snapshot(t: TestContext, revision = 'rev-1') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'farmslot-prebuilt-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'packages/cli');
  const lib = path.join(root, 'packages/lib');
  for (const dir of [path.join(cli, 'bin'), path.join(cli, 'src'), path.join(lib, 'src')])
    await mkdir(dir, { recursive: true });
  for (const name of ['farmslot.mjs', 'prebuilt-resolve.mjs', 'build-prebuilt.mjs'])
    await copyFile(path.join(packageDir, 'bin', name), path.join(cli, 'bin', name));
  await symlink(path.resolve(packageDir, '../../node_modules'), path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'DEPLOYED-REVISION.json'), JSON.stringify({ sha: revision }));
  for (const dir of [cli, lib])
    await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  await writeFile(
    path.join(cli, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        experimentalDecorators: true,
        paths: { '@farmslot/lib': ['../lib/src/index.ts'], '@farmslot/lib/*': ['../lib/src/*'] },
      },
    }),
  );
  await writeFile(path.join(lib, 'src/index.ts'), 'export const value: number = 42;');
  await writeFile(
    path.join(lib, 'src/extra.ts'),
    'export const extra = (n: number): number => n + 1;',
  );
  await writeFile(path.join(cli, 'src/local.ts'), 'export const local: string = "local";');
  // An enum: Node's own type stripping cannot load it, so this proves the outside file reached TSX.
  await writeFile(
    path.join(root, 'outside.ts'),
    'enum Where { Outside = "outside" }\nexport const outside: string = Where.Outside;',
  );
  await writeFile(
    path.join(cli, 'src/entry.ts'),
    `import { value } from '@farmslot/lib';
     import { extra } from '@farmslot/lib/extra';
     import { local } from './local.js';
     const { outside } = await import(new URL('../../../outside.ts', import.meta.url).href);
     const report: Record<string, unknown> = { entry: import.meta.url, value, extra: extra(1), local, outside };
     console.log(JSON.stringify(report));`,
  );
  return { root, cli };
}

async function call(cli: string, env: NodeJS.ProcessEnv = {}) {
  const { stdout, stderr } = await run(process.execPath, [path.join(cli, 'bin/farmslot.mjs')], {
    env: { ...process.env, FARMSLOT_HOME: path.join(cli, 'home'), ...env },
  });
  assert.equal(stderr, '', 'no warnings on stderr');
  return JSON.parse(stdout) as { entry: string; value: number; extra: number; local: string };
}

const expected = { value: 42, extra: 2, local: 'local', outside: 'outside' };

test('an unbuilt snapshot runs its TypeScript sources', async (t) => {
  const { cli } = await snapshot(t);
  const result = await call(cli);
  assert.match(result.entry, /src\/entry\.ts$/);
  assert.deepEqual({ ...result, entry: undefined }, { ...expected, entry: undefined });
});

/** Node versions where TSX registers in-thread hooks: the prebuilt hooks chain only with those. */
const [major, minor, patch] = process.versions.node.split('.').map(Number) as [
  number,
  number,
  number,
];
const inThreadTsx =
  major >= 26 ||
  (major === 25 && (minor > 1 || (minor === 1 && patch >= 0))) ||
  (major === 24 && (minor > 11 || (minor === 11 && patch >= 1)));

test('a built snapshot runs the prebuilt modules and still loads TypeScript from outside', async (t) => {
  const { cli } = await snapshot(t);
  await run(process.execPath, [path.join(cli, 'bin/build-prebuilt.mjs'), 'rev-1']);
  const result = await call(cli);
  // Older Node keeps the sources: TSX's loader-thread hooks would drop the outside named exports.
  assert.match(result.entry, inThreadTsx ? /src\/entry\.js$/ : /src\/entry\.ts$/);
  assert.deepEqual({ ...result, entry: undefined }, { ...expected, entry: undefined });
  // An operator can still force the sources.
  assert.match((await call(cli, { FARMSLOT_CLI_FROM_SOURCE: '1' })).entry, /src\/entry\.ts$/);
});

test('a build for another revision is not used', async (t) => {
  const { cli } = await snapshot(t, 'rev-2');
  await run(process.execPath, [path.join(cli, 'bin/build-prebuilt.mjs'), 'rev-1']);
  assert.match((await call(cli)).entry, /src\/entry\.ts$/);
});

test('the build refuses to overwrite a JavaScript source of the same name', async (t) => {
  const { cli } = await snapshot(t);
  await writeFile(path.join(cli, 'src/local.js'), 'export const local = "hand-written";');
  await assert.rejects(
    run(process.execPath, [path.join(cli, 'bin/build-prebuilt.mjs'), 'rev-1']),
    /refusing to overwrite .*local\.js/,
  );
});

test('the build refuses a git checkout, whose sources change under it', async (t) => {
  const { root, cli } = await snapshot(t);
  await mkdir(path.join(root, '.git'));
  await assert.rejects(
    run(process.execPath, [path.join(cli, 'bin/build-prebuilt.mjs'), 'rev-1']),
    /refusing to prebuild .*git checkout/,
  );
});
