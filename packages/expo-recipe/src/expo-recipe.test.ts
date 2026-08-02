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
  validateExpoRecipeDocument,
} from './index.js';
import { closeUiTransportQuietly } from './runner.js';

test('production Expo validation rejects gestures unsupported by the active adapter', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-expo-recipe-adapter-'));
  const previousPlatform = process.env.PLATFORM;
  try {
    process.env.PLATFORM = 'android';
    await writeJson(path.join(root, 'package.json'), { name: 'example-expo', scripts: {} });
    await installExpoRecipeScaffold({ projectRoot: root });
    const manifestPath = path.join(root, DEFAULT_EXPO_RECIPE_MANIFEST_PATH);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      actions: Record<
        string,
        { adapters?: string[]; adapter_schemas?: Record<string, Record<string, unknown>> }
      >;
    };
    manifest.actions['ui.pan']!.adapters = ['ios'];
    delete manifest.actions['ui.pan']!.adapter_schemas?.android;
    await writeJson(manifestPath, manifest);
    await writeJson(path.join(root, DEFAULT_EXPO_RECIPE_PATH), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Reject an unsupported continuous gesture before execution.',
      workflow: {
        entry: 'gesture',
        nodes: {
          gesture: {
            action: 'ui.pan',
            intent: 'Move the requested surface.',
            target: 'gesture-surface',
            delta: { x: 20, y: 0 },
            duration_ms: 300,
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    });

    const validation = await validateExpoRecipeDocument(DEFAULT_EXPO_RECIPE_PATH, {
      projectRoot: root,
    });
    assert.equal(validation.status, 'invalid');
    assert.match(
      validation.findings[0]?.message ?? '',
      /Adapter android does not support recipe action ui\.pan\. Supporting adapters: ios\./u,
    );
    await assert.rejects(
      () =>
        runExpoRecipeDocument(DEFAULT_EXPO_RECIPE_PATH, {
          projectRoot: root,
          artifactsDir: path.join(root, 'artifacts'),
          dryRun: true,
        }),
      /recipe\.action_not_supported_by_adapter.*Supporting adapters: ios\./u,
    );

    process.env.PLATFORM = 'web';
    await assert.rejects(
      () =>
        runExpoRecipeDocument(DEFAULT_EXPO_RECIPE_PATH, {
          projectRoot: root,
          artifactsDir: path.join(root, 'web-artifacts'),
        }),
      /Adapter web does not support recipe action ui\.pan\. Supporting adapters: ios\./u,
    );
  } finally {
    if (previousPlatform === undefined) delete process.env.PLATFORM;
    else process.env.PLATFORM = previousPlatform;
    await rm(root, { recursive: true, force: true });
  }
});

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

    const manifest = JSON.parse(
      await readFile(path.join(root, DEFAULT_EXPO_RECIPE_MANIFEST_PATH), 'utf-8'),
    );
    assert.deepEqual(Object.keys(manifest).sort(), ['$schema', 'actions', 'observers']);
    assert.ok(manifest.actions['ui.screenshot']);
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

    const manifest = JSON.parse(
      await readFile(path.join(root, DEFAULT_EXPO_RECIPE_MANIFEST_PATH), 'utf-8'),
    );
    assert.ok(manifest.actions['app.hud']);

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

test('doctor warns when the native provider environment is partially configured', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-expo-recipe-native-env-'));
  const nativeEnvKeys = [
    'PLATFORM',
    'IOS_SIMULATOR',
    'SIMULATOR',
    'ADB_SERIAL',
    'ANDROID_SERIAL',
    'ANDROID_DEVICE',
    'FARMSLOT_RECIPE_APP_ID',
  ] as const;
  const savedEnv = Object.fromEntries(nativeEnvKeys.map((key) => [key, process.env[key]]));
  const resetNativeEnv = () => {
    for (const key of nativeEnvKeys) delete process.env[key];
  };
  try {
    await writeJson(path.join(root, 'package.json'), { name: 'example-expo', scripts: {} });
    await installExpoRecipeScaffold({ projectRoot: root });

    resetNativeEnv();
    const local = await runExpoRecipeDoctor({ projectRoot: root });
    assert.equal(local.status, 'pass');
    assert.deepEqual(local.findings, []);

    process.env.PLATFORM = 'ios';
    const partial = await runExpoRecipeDoctor({ projectRoot: root });
    assert.equal(partial.status, 'pass');
    assert.ok(
      partial.findings.some(
        (finding) =>
          finding.code === 'native_provider_incomplete' && finding.severity === 'warning',
      ),
    );

    process.env.IOS_SIMULATOR = 'fs-3';
    process.env.FARMSLOT_RECIPE_APP_ID = 'net.siteed.example';
    const complete = await runExpoRecipeDoctor({ projectRoot: root });
    assert.equal(complete.status, 'pass');
    assert.deepEqual(complete.findings, []);
  } finally {
    resetNativeEnv();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('transport cleanup failures never mask the run result', async () => {
  await assert.doesNotReject(() =>
    closeUiTransportQuietly({
      async close() {
        throw new Error('sessions.close exploded');
      },
    }),
  );
  await assert.doesNotReject(() => closeUiTransportQuietly({}));
});

test('defers Metro port validation until a bridge-backed action runs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-expo-recipe-metro-port-'));
  const envNames = ['FARMSLOT_RECIPE_METRO_PORT', 'METRO_PORT'] as const;
  const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of envNames) delete process.env[name];
    await writeJson(path.join(root, 'package.json'), { name: 'example-expo', scripts: {} });
    await installExpoRecipeScaffold({ projectRoot: root, withBridge: true });
    await writeJson(path.join(root, DEFAULT_EXPO_RECIPE_PATH), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Runs without a Metro-backed action.',
      workflow: {
        entry: 'command',
        nodes: {
          command: { action: 'command', intent: 'Run headless proof.', cmd: 'true', next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
    });

    const headless = await runExpoRecipeDocument(DEFAULT_EXPO_RECIPE_PATH, {
      projectRoot: root,
      artifactsDir: path.join(root, 'artifacts', 'headless'),
    });
    assert.equal(headless.status, 'pass');

    await writeJson(path.join(root, DEFAULT_EXPO_RECIPE_PATH), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Requires the Metro bridge.',
      workflow: {
        entry: 'status',
        nodes: {
          status: { action: 'app.status', intent: 'Read bridge status.', next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
    });

    const bridgeArtifacts = path.join(root, 'artifacts', 'bridge');
    const bridge = await runExpoRecipeDocument(DEFAULT_EXPO_RECIPE_PATH, {
      projectRoot: root,
      artifactsDir: bridgeArtifacts,
    });
    assert.equal(bridge.status, 'fail');
    assert.match(
      await readFile(path.join(bridgeArtifacts, 'trace.json'), 'utf8'),
      /Metro recipe bridge port is missing/u,
    );
  } finally {
    for (const name of envNames) {
      const value = savedEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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
      title: 'Redaction smoke',
      description: 'Verifies sensitive command output does not land in trace artifacts.',
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

test('inherited untrusted provenance blocks Expo recipe actions before side effects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-expo-recipe-trust-'));
  const envNames = [
    'FARMSLOT_RECIPE_SOURCE_TRUST',
    'FARMSLOT_RECIPE_SOURCE_KIND',
    'FARMSLOT_RECIPE_SOURCE_NAME',
    'FARMSLOT_RECIPE_APPROVE_PLAN',
  ] as const;
  const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  try {
    await writeJson(path.join(root, 'package.json'), { name: 'example-expo', scripts: {} });
    await installExpoRecipeScaffold({ projectRoot: root });
    await writeJson(path.join(root, DEFAULT_EXPO_RECIPE_PATH), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Trust boundary',
      description: 'Verifies inherited task provenance reaches the Expo wrapper.',
      workflow: {
        entry: 'command',
        nodes: {
          command: {
            action: 'command',
            intent: 'Attempt a restricted host action',
            cmd: 'touch blocked.txt',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    });
    process.env.FARMSLOT_RECIPE_SOURCE_TRUST = 'untrusted';
    process.env.FARMSLOT_RECIPE_SOURCE_KIND = 'task';
    process.env.FARMSLOT_RECIPE_SOURCE_NAME = 'pr-body';
    delete process.env.FARMSLOT_RECIPE_APPROVE_PLAN;

    await assert.rejects(
      runExpoRecipeDocument(DEFAULT_EXPO_RECIPE_PATH, {
        projectRoot: root,
        artifactsDir: path.join(root, 'artifacts'),
      }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'RECIPE_TRUST_REQUIRED',
    );
    await assert.rejects(readFile(path.join(root, 'blocked.txt')));
    await assert.rejects(readFile(path.join(root, 'artifacts', 'summary.json')));
  } finally {
    for (const name of envNames) {
      const value = savedEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('runs composed recipes from the configured library', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-expo-recipe-library-'));
  const libraryRoot = path.join(root, 'library');
  const previousLibraryPath = process.env.RECIPE_LIBRARY_PATH;
  try {
    await writeJson(path.join(root, 'package.json'), { name: 'example-expo', scripts: {} });
    await installExpoRecipeScaffold({ projectRoot: root });
    await writeJson(path.join(libraryRoot, 'recipes', 'shared', 'wait-ready.recipe.json'), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Provides a reusable composed recipe boundary.',
      workflow: {
        entry: 'done',
        nodes: {
          done: { action: 'end', status: 'pass' },
        },
      },
    });
    await writeJson(path.join(root, DEFAULT_EXPO_RECIPE_PATH), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Delegates proof setup to a configured library recipe.',
      workflow: {
        entry: 'reuse',
        nodes: {
          reuse: {
            action: 'call',
            intent: 'Reuse the shared readiness boundary.',
            ref: 'shared.wait-ready',
            params: {},
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    });
    process.env.RECIPE_LIBRARY_PATH = `test=${libraryRoot}`;

    const result = await runExpoRecipeDocument(DEFAULT_EXPO_RECIPE_PATH, {
      projectRoot: root,
      artifactsDir: path.join(root, 'artifacts'),
    });
    const trace = await readFile(path.join(root, 'artifacts', 'trace.json'), 'utf8');
    assert.equal(result.status, 'pass', trace);
    assert.match(
      await readFile(path.join(root, 'artifacts', 'recipe-resolution.json'), 'utf8'),
      /shared\.wait-ready/u,
    );
  } finally {
    if (previousLibraryPath === undefined) delete process.env.RECIPE_LIBRARY_PATH;
    else process.env.RECIPE_LIBRARY_PATH = previousLibraryPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI passes typed root params and resolves the adjacent task recipe library', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-expo-task-recipe-'));
  try {
    await writeJson(path.join(root, 'package.json'), { name: 'example-expo', scripts: {} });
    await installExpoRecipeScaffold({ projectRoot: root });
    const taskDir = path.join(root, 'artifacts');
    const libraryRoot = path.join(taskDir, 'recipe-library');
    await writeJson(path.join(libraryRoot, 'recipes', 'task', 'write.recipe.json'), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Writes the caller-provided marker.',
      paramsSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['marker'],
        properties: { marker: { type: 'string' } },
      },
      workflow: {
        entry: 'write',
        nodes: {
          write: {
            action: 'command',
            intent: 'Write the requested proof marker.',
            cmd: 'touch {{params.marker}}',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    });
    await writeJson(path.join(taskDir, 'recipe.json'), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Calls the task-local proof recipe.',
      paramsSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['marker'],
        properties: { marker: { type: 'string' } },
      },
      workflow: {
        entry: 'reuse',
        nodes: {
          reuse: {
            action: 'call',
            intent: 'Reuse the task-local proof boundary.',
            ref: 'task.write',
            params: { marker: '{{params.marker}}' },
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    });

    await runExpoRecipeCli([
      'run',
      'artifacts/recipe.json',
      '--project-root',
      root,
      '--artifacts-dir',
      'artifacts/run',
      '--param',
      'marker=task-local-proof.txt',
    ]);

    assert.equal(await readFile(path.join(root, 'task-local-proof.txt'), 'utf8'), '');
    assert.match(
      await readFile(path.join(root, 'artifacts/run/recipe-resolution.json'), 'utf8'),
      /task\.write/u,
    );

    await writeJson(path.join(libraryRoot, 'recipes', 'task', 'write.recipe.json'), {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Uses native UI through a composed task recipe.',
      paramsSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['marker'],
        properties: { marker: { type: 'string' } },
      },
      workflow: {
        entry: 'press',
        nodes: {
          press: {
            action: 'ui.press',
            intent: 'Open the requested control.',
            selector: '{{params.marker}}',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    });
    const previousPlatform = process.env.PLATFORM;
    delete process.env.PLATFORM;
    try {
      await assert.rejects(
        () =>
          runExpoRecipeDocument('artifacts/recipe.json', {
            projectRoot: root,
            artifactsDir: 'artifacts/native-run',
            params: { marker: '#control' },
          }),
        /Native recipe actions require PLATFORM=ios or android/u,
      );
    } finally {
      if (previousPlatform === undefined) delete process.env.PLATFORM;
      else process.env.PLATFORM = previousPlatform;
    }
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
