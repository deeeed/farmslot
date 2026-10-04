import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { RecipeActionManifestDocument } from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { runRecipeRunnerCli } from '../src/cli/index.js';
import { createRecipeRunner } from '../src/core/runner.js';
import { RecipeTrustError } from '../src/core/trust-error.js';

const HELLO = fileURLToPath(new URL('../../../examples/recipe-library-hello', import.meta.url));
const MANIFEST = path.join(HELLO, 'manifests', 'shared.action-manifest.json');

async function helloRunner(lines: string[] = []) {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as RecipeActionManifestDocument;
  return createRecipeRunner({
    actionManifest: manifest,
    adapters: createStandardCoreAdapters({ actions: Object.keys(manifest.actions) }),
    logger: {
      info: (line) => void lines.push(line),
      warn: (line) => void lines.push(line),
      error: (line) => void lines.push(line),
    },
  });
}

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a run that fails manifest validation still logs its libraries', async (t) => {
  const lines: string[] = [];
  const runner = await helloRunner(lines);
  await assert.rejects(
    runner.run({
      artifactsDir: await tempDir(t, 'recipe-early-failure-'),
      librarySources: [{ name: 'hello', root: HELLO }],
      recipeDocument: {
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        title: 'Undeclared',
        description: 'Uses an action the manifest does not declare.',
        workflow: {
          entry: 'wait',
          nodes: {
            wait: { action: 'wait', intent: 'Wait', duration_ms: 1, next: 'done' },
            done: { action: 'end', status: 'pass' },
          },
        },
      },
    }),
    /not declared/u,
  );
  assert.ok(
    lines.some((line) => line.startsWith('Recipe libraries: hello=')),
    `expected the sources line, got ${JSON.stringify(lines)}`,
  );
});

/** The plan digest a library run asks to approve under one environment. */
async function planDigest(
  t: TestContext,
  artifactsDir: string,
  env: Record<string, string>,
): Promise<string> {
  const runner = await helloRunner();
  try {
    await runner.run({
      recipePath: path.join(HELLO, 'recipes', 'greet.recipe.json'),
      artifactsDir,
      projectRoot: artifactsDir,
      librarySources: [{ name: 'hello', root: HELLO }],
      source: { kind: 'library', trust: 'unknown', name: 'hello' },
      inheritProcessEnv: false,
      env,
    });
  } catch (error) {
    if (!(error instanceof RecipeTrustError)) throw error;
    assert.equal(error.code, 'RECIPE_TRUST_REQUIRED');
    return error.failure.recipeDigest ?? '';
  }
  t.diagnostic('run unexpectedly passed without approval');
  return '';
}

test('volatile package-manager values do not change the plan digest; user settings do', async (t) => {
  const artifactsDir = await tempDir(t, 'recipe-plan-env-');
  const yarnEnv = (shim: string) => ({
    PATH: [shim, '/usr/bin', '/bin'].join(path.delimiter),
    HOME: '/home/user',
    BERRY_BIN_FOLDER: shim,
    npm_execpath: `${shim}/yarn`,
    npm_node_execpath: `${shim}/node`,
    npm_config_user_agent: 'yarn/4.9.2 npm/? node/v22.12.0 darwin arm64',
    npm_package_name: '@farmslot/cli',
    npm_package_version: '0.3.0',
    INIT_CWD: '/repo/packages/cli',
    PROJECT_CWD: '/repo',
    COREPACK_ROOT: '/corepack',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  });
  // Two `yarn <script>` invocations differ only in the per-invocation shim folder.
  const first = await planDigest(t, artifactsDir, yarnEnv('/tmp/xfs-1111'));
  const second = await planDigest(t, artifactsDir, yarnEnv('/tmp/xfs-2222'));
  assert.match(first, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(second, first);

  // Settings that can change what the run does still bind the approval.
  for (const [name, value] of [
    ['HOME', '/x'],
    ['npm_config_registry', 'https://registry.example.test/'],
    ['npm_config_ignore_scripts', 'true'],
    ['npm_config__authToken', 'token'],
    ['COREPACK_NPM_REGISTRY', 'https://registry.example.test/'],
    ['COREPACK_INTEGRITY_KEYS', '0'],
  ] as const) {
    const changed = await planDigest(t, artifactsDir, {
      ...yarnEnv('/tmp/xfs-1111'),
      [name]: value,
    });
    assert.notEqual(changed, first, name);
  }
  const extraPath = await planDigest(t, artifactsDir, {
    ...yarnEnv('/tmp/xfs-1111'),
    PATH: ['/tmp/xfs-1111', '/opt/bin', '/usr/bin', '/bin'].join(path.delimiter),
  });
  assert.notEqual(extraPath, first);
  // Only the shim entry at the front of PATH is dropped; the same folder later on PATH binds.
  const laterShim = await planDigest(t, artifactsDir, {
    ...yarnEnv('/tmp/xfs-1111'),
    PATH: ['/usr/bin', '/tmp/xfs-1111', '/bin'].join(path.delimiter),
  });
  assert.notEqual(laterShim, first);
});

test('run and validate exit 2 for a malformed library entry', async (t) => {
  const previousExit = process.exitCode;
  const previousEnv = process.env.RECIPE_LIBRARY_PATH;
  const error = console.error;
  t.after(() => {
    process.exitCode = previousExit;
    process.env.RECIPE_LIBRARY_PATH = previousEnv;
    console.error = error;
  });
  console.error = () => undefined;
  const recipe = path.join(HELLO, 'recipes', 'greet.recipe.json');
  for (const argv of [
    ['run', 'greet', '--library', 'hello=', '--describe'],
    ['validate', recipe, '--library', '=path'],
  ]) {
    process.exitCode = 0;
    await runRecipeRunnerCli(argv);
    assert.equal(process.exitCode, 2, argv.join(' '));
  }
  process.exitCode = 0;
  process.env.RECIPE_LIBRARY_PATH = 'hello=';
  await runRecipeRunnerCli(['run', 'greet', '--describe']);
  assert.equal(process.exitCode, 2);
});

test('a library root that does not exist is a usage error', async (t) => {
  const previousExit = process.exitCode;
  const error = console.error;
  t.after(() => {
    process.exitCode = previousExit;
    console.error = error;
  });
  const lines: string[] = [];
  console.error = (line: unknown) => void lines.push(String(line));
  process.exitCode = 0;
  await runRecipeRunnerCli([
    'run',
    'greet',
    '--library',
    'gone=/nonexistent/library',
    '--describe',
  ]);
  assert.equal(process.exitCode, 2);
  assert.match(lines.join('\n'), /RECIPE_LIBRARY_PATH_INVALID.*does not exist/u);
});
