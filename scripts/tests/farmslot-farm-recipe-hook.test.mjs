import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wrapperPath = path.join(repoRoot, 'projects/farmslot-farm/setup/validate-recipe.sh');
const projectJsonPath = path.join(repoRoot, 'projects/farmslot-farm/project.json');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function dryRun(args) {
  const result = await execFileAsync('bash', [wrapperPath, ...args, '--dry-run'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      FARMSLOT_SLOT_REPO: repoRoot,
    },
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function withTempDir(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-farm-recipe-hook-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('farmslot-farm recipe_run hook declares the Recipe v1 gateway contract', async () => {
  const projectJson = JSON.parse(await readFile(projectJsonPath, 'utf-8'));
  const hook = projectJson.hooks?.recipe_run;

  assert.equal(typeof hook, 'string');
  assert.match(hook, /validate-recipe\.sh/);
  for (const required of [
    '--recipe {{recipe_path}}',
    '--artifacts-dir {{artifacts_dir}}',
    '--runtime-dir {{runtime_dir}}',
    '--platform {{platform}}',
    '--cdp-port {{cdp_port}}',
    '--gateway-port {{port}}',
    '--slot-id {{slot_id}}',
  ]) {
    assert.ok(hook.includes(required), `hook should include ${required}`);
  }
  assert.equal(projectJson.recipe_run_supports_playback_slow, true);
  assert.equal(projectJson.recipe_run_supports_video_recording, true);
});

test('farmslot-farm cli recipe route targets the Command Center harness with a typed artifact directory', async () => {
  await withTempDir(async (root) => {
    const recipePath = path.join(root, 'recipe.json');
    const artifactsDir = path.join(root, 'recipe-run');
    const output = await dryRun([
      '--recipe',
      recipePath,
      '--artifacts-dir',
      artifactsDir,
      '--runtime-dir',
      path.join(root, 'runtime'),
      '--platform',
      'cli',
      '--cdp-port',
      '9323',
      '--gateway-port',
      '7777',
      '--slot-id',
      'macwork-ff-1',
      '--slow',
      '2000',
      '--record-video=full-run',
    ]);

    assert.match(output, /^node /);
    assert.match(output, /apps\/command-center\/scripts\/agentic\/run-recipe\.mjs/);
    assert.match(output, /--artifacts-dir /);
    assert.match(output, new RegExp(escapeRegExp(artifactsDir)));
    assert.match(output, /--action-manifest /);
    assert.match(output, /docs\/examples\/recipes\/farmslot-v1\.action-manifest\.json/);
    assert.match(output, /--project-root /);
    assert.match(output, /--input=farmslot_dir=/);
    assert.match(output, /--input=primary_repo=/);
    assert.match(output, /--cdp-port 9323/);
    assert.match(output, /--gateway-port 7777/);
    assert.match(output, /--slot-id macwork-ff-1/);
    assert.match(output, /--slow 2000/);
    assert.match(output, /--record-video=full-run/);
    assert.match(output, /--record-max-fps 15/);
    assert.match(output, /--record-max-size 1080/);
  });
});

test('farmslot-farm mobile recipe route targets Companion expo recipe with the same artifacts dir', async () => {
  await withTempDir(async (root) => {
    const recipePath = path.join(root, 'recipe.json');
    const artifactsDir = path.join(root, 'recipe-run');
    const output = await dryRun([
      '--recipe',
      recipePath,
      '--artifacts-dir',
      artifactsDir,
      '--runtime-dir',
      path.join(root, 'runtime'),
      '--platform',
      'ios',
      '--metro-port',
      '8081',
      '--simulator',
      'iPhone 15',
      '--record-video=full-run',
    ]);

    assert.match(output, /^bash /);
    assert.match(output, /apps\/companion\/scripts\/agentic\/validate-recipe\.sh/);
    assert.doesNotMatch(output, /apps\/command-center\/scripts\/agentic\/run-recipe\.mjs/);
    assert.match(output, /--artifacts-dir /);
    assert.match(output, new RegExp(escapeRegExp(artifactsDir)));
    assert.match(output, /--platform ios/);
    assert.match(output, /--metro-port 8081/);
    assert.match(output, /--runtime-dir /);
    assert.match(output, /--simulator iPhone\\ 15/);
    assert.match(output, /--record-video=full-run/);
  });
});

test('first-party farmslot-farm routes resolve to harness-backed Recipe v1 producers', async () => {
  const commandCenterRunner = await readFile(
    path.join(repoRoot, 'apps/command-center/scripts/agentic/run-recipe.mjs'),
    'utf-8',
  );
  const companionWrapper = await readFile(
    path.join(repoRoot, 'apps/companion/scripts/agentic/validate-recipe.sh'),
    'utf-8',
  );
  const expoRunner = await readFile(
    path.join(repoRoot, 'packages/expo-recipe/src/runner.ts'),
    'utf-8',
  );

  assert.match(commandCenterRunner, /createRecipeRunner/);
  assert.match(commandCenterRunner, /@farmslot\/recipe-harness/);
  assert.match(companionWrapper, /farmslot-expo-recipe run/);
  assert.match(companionWrapper, /--artifacts-dir/);
  assert.match(expoRunner, /createRecipeRunner/);
  assert.match(expoRunner, /@farmslot\/recipe-harness/);
});
