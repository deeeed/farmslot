import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertAgentDeviceNodeVersion } from './agent-device-ui-transport.js';
import {
  DEFAULT_EXPO_RECIPE_MANIFEST_PATH,
  DEFAULT_EXPO_RECIPE_PATH,
  installExpoRecipeScaffold,
  resolveExpoRecordingTarget,
  runExpoRecipeCli,
  runExpoRecipeDoctor,
  runExpoRecipeDocument,
} from './index.js';

test('native Agent Device transport reports its Node runtime requirement', () => {
  assert.doesNotThrow(() => assertAgentDeviceNodeVersion('22.12.0'));
  assert.doesNotThrow(() => assertAgentDeviceNodeVersion('23.0.0'));
  assert.throws(
    () => assertAgentDeviceNodeVersion('20.10.0'),
    /Native Agent Device recipe actions require Node >=22\.12/u,
  );
});

test('installs the Expo recipe scaffold idempotently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-expo-recipe-'));
  try {
    await writeJson(path.join(root, 'package.json'), { name: 'example-expo', scripts: {} });
    const first = await installExpoRecipeScaffold({ projectRoot: root });
    assert.deepEqual(first.skipped, []);
    assert.ok(first.written.includes(DEFAULT_EXPO_RECIPE_MANIFEST_PATH));
    assert.ok(first.written.includes(DEFAULT_EXPO_RECIPE_PATH));
    assert.equal(first.packageJsonUpdated, true);

    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    assert.equal(packageJson.scripts.recipe, 'farmslot-expo-recipe');
    assert.equal(packageJson.scripts['recipe:doctor'], 'farmslot-expo-recipe doctor');
    assert.equal(packageJson.scripts['recipe:validate'], 'farmslot-expo-recipe validate');
    assert.equal(packageJson.scripts['recipe:run'], 'farmslot-expo-recipe run');

    const doctor = await runExpoRecipeDoctor({ projectRoot: root });
    assert.equal(doctor.status, 'pass');
    assert.deepEqual(doctor.findings, []);

    const second = await installExpoRecipeScaffold({ projectRoot: root });
    assert.equal(second.written.length, 0);
    assert.ok(second.skipped.includes(DEFAULT_EXPO_RECIPE_MANIFEST_PATH));
    assert.equal(second.packageJsonUpdated, false);

    packageJson.scripts['recipe:run'] = 'custom-runner';
    await writeJson(path.join(root, 'package.json'), packageJson);
    assert.equal((await runExpoRecipeDoctor({ projectRoot: root })).status, 'fail');
    const forced = await installExpoRecipeScaffold({ projectRoot: root, force: true });
    assert.equal(forced.packageJsonUpdated, true);
    assert.equal((await runExpoRecipeDoctor({ projectRoot: root })).status, 'pass');

    const manifest = await readFile(path.join(root, DEFAULT_EXPO_RECIPE_MANIFEST_PATH), 'utf-8');
    assert.match(manifest, /"capability": "record\.video"/u);
    assert.match(manifest, /"modes": \["full_run"\]/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installs optional bridge files and validates the dev guard contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-expo-recipe-bridge-'));
  try {
    await writeJson(path.join(root, 'package.json'), { name: 'example-expo', scripts: {} });
    const result = await installExpoRecipeScaffold({ projectRoot: root, withBridge: true });
    assert.ok(result.written.includes('src/farmslot/RecipeBridgeProvider.tsx'));
    assert.ok(result.written.includes('src/farmslot/RecipeHud.tsx'));

    const manifest = await readFile(path.join(root, DEFAULT_EXPO_RECIPE_MANIFEST_PATH), 'utf-8');
    assert.match(manifest, /"app\.hud"/u);
    assert.match(manifest, /"capability": "record\.video"/u);

    const provider = await readFile(
      path.join(root, 'src/farmslot/RecipeBridgeProvider.tsx'),
      'utf-8',
    );
    assert.match(provider, /__DEV__/u);
    assert.match(provider, /EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE/u);
    assert.match(provider, /hud\?: RecipeHudOptions/u);
    assert.match(provider, /<RecipeHud state=\{hud\} \{...hudOptions\}/u);

    const hud = await readFile(path.join(root, 'src/farmslot/RecipeHud.tsx'), 'utf-8');
    assert.doesNotMatch(hud, /numberOfLines/u);
    assert.match(hud, /StyleProp/u);
    assert.match(hud, /formatBadge/u);

    const doctor = await runExpoRecipeDoctor({ projectRoot: root });
    assert.equal(doctor.status, 'pass');
    assert.deepEqual(doctor.findings, []);

    const providerPath = path.join(root, 'src/farmslot/RecipeBridgeProvider.tsx');
    await rm(providerPath);
    const missingProvider = await runExpoRecipeDoctor({ projectRoot: root });
    assert.equal(missingProvider.status, 'fail');
    assert.ok(
      missingProvider.findings.some((finding) => finding.code === 'bridge_missing_provider'),
    );

    await installExpoRecipeScaffold({ projectRoot: root, withBridge: true, force: true });
    await writeFile(providerPath, provider.replace('__DEV__ && ', ''));
    const missingDevGuard = await runExpoRecipeDoctor({ projectRoot: root });
    assert.equal(missingDevGuard.status, 'fail');
    assert.ok(
      missingDevGuard.findings.some((finding) => finding.code === 'bridge_missing_dev_guard'),
    );

    await writeFile(
      providerPath,
      provider.replace("process.env.EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE === '1'", 'true'),
    );
    const missingEnvGuard = await runExpoRecipeDoctor({ projectRoot: root });
    assert.equal(missingEnvGuard.status, 'fail');
    assert.ok(
      missingEnvGuard.findings.some((finding) => finding.code === 'bridge_missing_env_guard'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('redacts sensitive command output before writing trace artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-expo-recipe-redaction-'));
  try {
    await writeJson(path.join(root, 'package.json'), { name: 'example-expo', scripts: {} });
    await installExpoRecipeScaffold({ projectRoot: root });
    await writeJson(path.join(root, DEFAULT_EXPO_RECIPE_PATH), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      schema_version: 1,
      title: 'Redaction smoke',
      description: 'Verifies sensitive command output does not land in trace artifacts.',
      validate: {
        workflow: {
          entry: 'emit-config',
          nodes: {
            'emit-config': {
              action: 'command',
              intent: 'Emit an Expo-style config payload with sensitive values',
              cmd: `node -e "process.stdout.write(JSON.stringify({ slug: 'example', extra: { gatewayAuthToken: 'secret-token', credential: 'json-secret' } })); process.stderr.write('token=plain-secret authKey: hidden-secret')"`,
              next: 'assert-config',
            },
            'assert-config': {
              action: 'assert_output',
              intent: 'Confirm the emitted config still contains its public slug',
              source: 'emit-config',
              stream: 'stdout',
              contains: '"slug"',
              next: 'done',
            },
            done: {
              action: 'end',
              status: 'pass',
            },
          },
        },
      },
    });

    const artifactsDir = path.join(root, 'artifacts');
    const result = await runExpoRecipeDocument(DEFAULT_EXPO_RECIPE_PATH, {
      projectRoot: root,
      artifactsDir,
    });
    assert.equal(result.status, 'pass');

    const trace = await readFile(path.join(artifactsDir, 'trace.json'), 'utf-8');
    assert.doesNotMatch(trace, /secret-token|json-secret|plain-secret|hidden-secret/u);
    assert.match(trace, /<redacted>/u);
    assert.match(trace, /slug/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects missing option values before treating the next flag as a path', async () => {
  await assert.rejects(
    () => runExpoRecipeCli(['run', '--artifacts-dir', '--dry-run']),
    /--artifacts-dir requires a value/u,
  );
  await assert.rejects(
    () => runExpoRecipeCli(['validate', '--manifest', '--json']),
    /--manifest requires a value/u,
  );
  await assert.rejects(
    () => runExpoRecipeCli(['run', '--record-video=proof-window']),
    /proof-window is reserved for future focused clips/u,
  );
  await assert.rejects(
    () => runExpoRecipeCli(['run', '--record-video=proof_window']),
    /proof-window is reserved for future focused clips/u,
  );
  await assert.rejects(
    () => runExpoRecipeCli(['run', '--record-video', '--record-pid', 'abc']),
    /Expected a positive integer/u,
  );
});

test('resolves Expo recipe recording targets from flags or simulator defaults', () => {
  assert.deepEqual(resolveExpoRecordingTarget({ FARMSLOT_RECORD_PID: '123' }), {
    kind: 'pid',
    pid: 123,
  });
  assert.deepEqual(resolveExpoRecordingTarget({ FARMSLOT_RECORD_WINDOW_ID: '42' }), {
    kind: 'window-id',
    windowId: '42',
  });
  assert.deepEqual(resolveExpoRecordingTarget({ SIMULATOR: 'fs-2' }), {
    kind: 'simulator',
    device: 'fs-2',
  });
  assert.deepEqual(resolveExpoRecordingTarget({}), {
    kind: 'app-window',
    appName: 'Simulator',
    windowName: 'Simulator',
  });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
