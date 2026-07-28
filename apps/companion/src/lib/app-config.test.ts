import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConfigContext, ExpoConfig } from 'expo/config';

import createExpoConfig from '../../app.config';

test('Expo config enables the Sherpa ONNX native plugin for on-device ASR builds', () => {
  const config = createExpoConfig({
    config: {
      name: 'FarmDev',
      slug: 'farmslot',
    },
  } as ConfigContext);
  const pluginNames = (config.plugins ?? []).map(getPluginName).filter(Boolean);

  assert.ok(
    pluginNames.includes('@siteed/sherpa-onnx.rn'),
    'Sherpa ONNX plugin must be present so Expo prebuild/EAS applies native packaging config',
  );
});

test('Expo config routes microphone permission through audio-studio for voice mode builds', () => {
  const config = createExpoConfig({
    config: {
      name: 'FarmDev',
      slug: 'farmslot',
    },
  } as ConfigContext);
  const pluginEntries = config.plugins ?? [];
  const audioStudioPlugin = pluginEntries.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === '@siteed/audio-studio',
  );

  assert.ok(
    config.ios?.infoPlist?.NSMicrophoneUsageDescription,
    'iOS builds must explain microphone use before voice recording can prompt',
  );
  assert.ok(
    !config.android?.permissions?.includes('android.permission.RECORD_AUDIO'),
    'Farmslot must let native audio plugins own RECORD_AUDIO instead of duplicating it in app permissions',
  );
  assert.ok(
    Array.isArray(audioStudioPlugin) &&
      typeof audioStudioPlugin[1] === 'object' &&
      audioStudioPlugin[1] != null &&
      'microphonePermission' in audioStudioPlugin[1],
    '@siteed/audio-studio must own RECORD_AUDIO and receive the microphone permission copy during prebuild',
  );
});

test('Expo config keeps audio-studio foreground-only for store builds', () => {
  const config = createExpoConfig({
    config: {
      name: 'FarmDev',
      slug: 'farmslot',
    },
  } as ConfigContext);
  const pluginEntries = config.plugins ?? [];
  const audioStudioPlugin = pluginEntries.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === '@siteed/audio-studio',
  );
  assert.ok(
    Array.isArray(audioStudioPlugin) &&
      typeof audioStudioPlugin[1] === 'object' &&
      audioStudioPlugin[1] != null,
    '@siteed/audio-studio must be configured explicitly',
  );
  assert.equal(audioStudioPlugin[1].enableBackgroundAudio, false);
  assert.equal(audioStudioPlugin[1].enableDeviceDetection, false);
  assert.equal(audioStudioPlugin[1].enableNotifications, false);
  assert.equal(audioStudioPlugin[1].enablePhoneStateHandling, false);
  assert.deepEqual(audioStudioPlugin[1].iosBackgroundModes, {
    useAudio: false,
    useExternalAccessory: false,
    useLocation: false,
    useProcessing: false,
    useVoIP: false,
  });
  assert.ok(
    !pluginEntries.some(
      (plugin) => typeof plugin === 'string' && plugin.includes('withForegroundOnlyAudioStudio'),
    ),
    '@siteed/audio-studio must own foreground-only Android manifest behavior directly',
  );
});

test('Expo config uses the linked EAS project slug', () => {
  const config = createExpoConfig({
    config: { name: 'FarmDev', slug: 'ignored' },
  } as ConfigContext);
  assert.equal(config.slug, 'farmslot-companion');
});

test('Expo config uses script-provided bundle id and scheme for local native launches', () => {
  const previousBundleId = process.env.BUNDLE_ID;
  const previousScheme = process.env.SCHEME;
  process.env.BUNDLE_ID = 'net.siteed.custom.dev';
  process.env.SCHEME = 'farmslot-custom';
  try {
    const config = createExpoConfig({
      config: {
        name: 'FarmDev',
        slug: 'farmslot',
      },
    } as ConfigContext);

    assert.equal(config.android?.package, 'net.siteed.custom.dev');
    assert.equal(config.ios?.bundleIdentifier, 'net.siteed.custom.dev');
    assert.equal(config.scheme, 'farmslot-custom');
  } finally {
    restoreEnv('BUNDLE_ID', previousBundleId);
    restoreEnv('SCHEME', previousScheme);
  }
});

test('Expo config lets isolated launcher gateway settings override local dotenv defaults', () => {
  const previousGatewayUrl = process.env.EXPO_PUBLIC_GATEWAY_URL;
  const previousGatewayToken = process.env.FARMSLOT_GATEWAY_TOKEN;
  process.env.EXPO_PUBLIC_GATEWAY_URL = 'ws://localhost:7801/ws';
  process.env.FARMSLOT_GATEWAY_TOKEN = 'isolated-token';
  try {
    const config = createExpoConfig({
      config: {
        name: 'FarmDev',
        slug: 'farmslot',
      },
    } as ConfigContext);

    assert.equal(config.extra?.gatewayUrl, 'ws://localhost:7801/ws');
    assert.equal(config.extra?.gatewayAuthToken, 'isolated-token');
  } finally {
    restoreEnv('EXPO_PUBLIC_GATEWAY_URL', previousGatewayUrl);
    restoreEnv('FARMSLOT_GATEWAY_TOKEN', previousGatewayToken);
  }
});

test('Expo config uses the Metro port supplied by slot or worktree configuration', () => {
  const previousMetroPort = process.env.METRO_PORT;
  process.env.METRO_PORT = '41234';
  try {
    const config = createExpoConfig({
      config: {
        name: 'FarmDev',
        slug: 'farmslot',
      },
    } as ConfigContext);
    const metroPlugin = (config.plugins ?? []).find(
      (plugin) => Array.isArray(plugin) && plugin[0] === './plugins/withMetroPort.cjs',
    );

    assert.ok(Array.isArray(metroPlugin));
    assert.equal(metroPlugin[1]?.port, 41234);
    assert.equal(config.extra?.metroPort, 41234);
  } finally {
    restoreEnv('METRO_PORT', previousMetroPort);
  }
});

test('Expo config rejects an invalid configured Metro port instead of falling back', () => {
  const previousMetroPort = process.env.METRO_PORT;
  process.env.METRO_PORT = 'not-a-port';
  try {
    assert.throws(
      () =>
        createExpoConfig({
          config: {
            name: 'FarmDev',
            slug: 'farmslot',
          },
        } as ConfigContext),
      /METRO_PORT must be a positive integer/,
    );
  } finally {
    restoreEnv('METRO_PORT', previousMetroPort);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function getPluginName(plugin: NonNullable<ExpoConfig['plugins']>[number]): string | null {
  if (typeof plugin === 'string') return plugin;
  if (Array.isArray(plugin) && typeof plugin[0] === 'string') return plugin[0];
  return null;
}
