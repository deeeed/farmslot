import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  validateRecipeActionManifestDocument,
  validateRecipeDocument,
  validateRecipeWithManifest,
} from '@farmslot/protocol/recipe';
import { type RawProjectJson, validateRuntimeCapabilitiesConfig } from '@farmslot/slot-config';

import { validatePackDir } from './pack.js';

const pack = fileURLToPath(new URL('../../../../packs/siteed-web-farm/', import.meta.url));

test(
  'pack teardown treats a reaped server owner as stopped without signalling another process',
  { skip: process.platform === 'win32' },
  async (t) => {
    const listener = createServer();
    t.after(() => {
      if (listener.listening) listener.close();
    });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    assert(address && typeof address !== 'string');
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    const root = mkdtempSync(join(tmpdir(), 'web-pack-zombie-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const provider = join(root, '.agent/recipe-provider');
    const tools = provider;
    const bin = join(root, 'bin');
    for (const dir of [provider, tools, bin]) mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(provider, 'web-project.json'),
      JSON.stringify({ install: [], command: ['unused'] }),
    );
    writeFileSync(join(tools, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    symlinkSync(
      fileURLToPath(new URL('../../../../node_modules', import.meta.url)),
      join(tools, 'node_modules'),
      'dir',
    );
    const receipt = join(root, '.agent/siteed-server.json');
    writeFileSync(
      receipt,
      JSON.stringify({ pid: 2147000000, port, identity: 'the original live server identity' }),
    );
    writeFileSync(
      join(bin, 'ps'),
      '#!/bin/sh\ncase "$*" in\n  *2147000000*) echo "Z Wed Nov 4 12:00:00 2026 [node] <defunct>" ;;\n  *) exec /bin/ps "$@" ;;\nesac\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--conditions=development',
        join(pack, 'projects/siteed-web-farm/scripts/project.mjs'),
        'stop',
        root,
        String(port),
        String(port === 65535 ? port - 1 : port + 1),
      ],
      {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
        timeout: 4000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(receipt), false);
  },
);

test('the website pack passes real onboarding validation without operator pool configuration', () => {
  const result = validatePackDir(pack, join(tmpdir(), 'siteed-web-no-operator-pool'));
  assert.deepEqual(result.errors, []);
  assert.equal(result.pack?.projects[0].platform, 'cli');
});

test('the bundled website smoke is a valid proof recipe before any browser is acquired', () => {
  const recipe: unknown = JSON.parse(
    readFileSync(
      join(pack, 'projects/siteed-web-farm/fixtures/recipe-provider/recipes/web/smoke.recipe.json'),
      'utf8',
    ),
  );
  const result = validateRecipeDocument(recipe);
  assert.equal(result.status, 'valid', JSON.stringify(result));
});

test('the website action manifest examples pass the shared schema and intent checks', () => {
  const manifest: unknown = JSON.parse(
    readFileSync(
      join(pack, 'projects/siteed-web-farm/fixtures/recipe-provider/web.action-manifest.json'),
      'utf8',
    ),
  );
  const result = validateRecipeActionManifestDocument(manifest);
  assert.equal(result.status, 'valid', JSON.stringify(result));
});

test('the bundled proof plans against its actual action manifest and lifecycle resource references', () => {
  const projectRoot = join(pack, 'projects/siteed-web-farm');
  const project: RawProjectJson = JSON.parse(
    readFileSync(join(projectRoot, 'project.json'), 'utf8'),
  );
  assert.doesNotThrow(() =>
    validateRuntimeCapabilitiesConfig(project, 'siteed-web-farm/project.json'),
  );
  const recipe: unknown = JSON.parse(
    readFileSync(
      join(projectRoot, 'fixtures/recipe-provider/recipes/web/smoke.recipe.json'),
      'utf8',
    ),
  );
  const manifest = JSON.parse(
    readFileSync(join(projectRoot, 'fixtures/recipe-provider/web.action-manifest.json'), 'utf8'),
  );
  const result = validateRecipeWithManifest(recipe, manifest);
  assert.equal(result.status, 'valid', JSON.stringify(result));
});

test('prepared slot ports reach lifecycle commands without manual environment setup', async () => {
  const before = { cdp: process.env.RECIPE_CDP_PORT, application: process.env.RECIPE_WATCHER_PORT };
  try {
    delete process.env.RECIPE_CDP_PORT;
    delete process.env.RECIPE_WATCHER_PORT;
    const provider = await import(
      pathToFileURL(join(pack, 'projects/siteed-web-farm/fixtures/recipe-provider/provider.mjs'))
        .href
    );
    provider.createProvider({ slot: { ports: { port: 9315, metro_port: 9316 } } });
    assert.equal(process.env.RECIPE_WATCHER_PORT, '9315');
    assert.equal(process.env.RECIPE_CDP_PORT, '9316');
    provider.createProvider({
      ports: { watcher: { value: 19315 }, cdp: { value: 19316 } },
      slot: { ports: { port: 9315, metro_port: 9316 } },
    });
    assert.equal(process.env.RECIPE_WATCHER_PORT, '19315');
    assert.equal(process.env.RECIPE_CDP_PORT, '19316');
    provider.createProvider({
      options: { watcherPort: 29315, cdpPort: 29316 },
      slot: { ports: { port: 9315, metro_port: 9316 } },
    });
    assert.equal(process.env.RECIPE_WATCHER_PORT, '29315');
    assert.equal(process.env.RECIPE_CDP_PORT, '29316');
    provider.createProvider({ options: { watcherPort: 39315, cdpPort: 39316 } });
    assert.equal(process.env.RECIPE_WATCHER_PORT, '39315');
    assert.equal(process.env.RECIPE_CDP_PORT, '39316');
    provider.createProvider({ slot: { ports: { port: 9315, metro_port: 9316 } } });
    assert.equal(process.env.RECIPE_WATCHER_PORT, '39315');
    assert.equal(process.env.RECIPE_CDP_PORT, '39316');
  } finally {
    if (before.cdp === undefined) delete process.env.RECIPE_CDP_PORT;
    else process.env.RECIPE_CDP_PORT = before.cdp;
    if (before.application === undefined) delete process.env.RECIPE_WATCHER_PORT;
    else process.env.RECIPE_WATCHER_PORT = before.application;
  }
});
