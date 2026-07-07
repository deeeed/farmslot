import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppLifecycleAdapter } from '../src/adapters/app-lifecycle.js';
import type { ActionExecutionContext } from '../src/core/types.js';

function context(): ActionExecutionContext {
  return {
    nodeId: 'node',
    recipe: {},
    projectRoot: '/tmp/project',
    artifactsDir: '/tmp/artifacts',
    env: {},
    outputs: new Map(),
    getOutput() {
      return undefined;
    },
    resolveProjectPath(relativePath) {
      return relativePath;
    },
    resolveArtifactPath(relativePath) {
      return relativePath;
    },
    registerArtifact() {
      return undefined;
    },
    logger: console,
  };
}

test('app.lifecycle backgrounds Android through adb home', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const adapter = createAppLifecycleAdapter({
    targetProvider: {
      resolveTarget() {
        return { platform: 'android', deviceId: 'serial-1', appId: 'com.example.app' };
      },
    },
    commandRunner: {
      async execFile(file, args) {
        calls.push({ file, args });
        return {};
      },
    },
  });

  const result = await adapter.execute({ command: 'background' }, context());

  assert.deepEqual(calls, [
    {
      file: 'adb',
      args: ['-s', 'serial-1', 'shell', 'input', 'keyevent', 'HOME'],
    },
  ]);
  assert.equal((result.output as { command: string }).command, 'background');
});

test('app.lifecycle launches Android with an Expo deep link when provided', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const adapter = createAppLifecycleAdapter({
    targetProvider: {
      resolveTarget() {
        return {
          platform: 'android',
          deviceId: 'serial-1',
          appId: 'com.example.app',
          metroPort: 8063,
          launchUrl: 'expo-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8063',
        };
      },
    },
    commandRunner: {
      async execFile(file, args) {
        calls.push({ file, args });
        return {};
      },
    },
  });

  await adapter.execute({ command: 'foreground' }, context());

  assert.deepEqual(calls, [
    {
      file: 'adb',
      args: ['-s', 'serial-1', 'reverse', 'tcp:8063', 'tcp:8063'],
    },
    {
      file: 'adb',
      args: [
        '-s',
        'serial-1',
        'shell',
        'am',
        'start',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        'expo-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8063',
      ],
    },
  ]);
});

test('app.lifecycle requires an explicit command', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const adapter = createAppLifecycleAdapter({
    targetProvider: {
      resolveTarget() {
        return { platform: 'android', deviceId: 'serial-1', appId: 'com.example.app' };
      },
    },
    commandRunner: {
      async execFile(file, args) {
        calls.push({ file, args });
        return {};
      },
    },
  });

  await assert.rejects(adapter.execute({}, context()), /app\.lifecycle\.command must be explicit/);
  assert.deepEqual(calls, []);
});

test('app.lifecycle validates timing knobs before side effects', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const adapter = createAppLifecycleAdapter({
    targetProvider: {
      resolveTarget() {
        return { platform: 'android', deviceId: 'serial-1', appId: 'com.example.app' };
      },
    },
    commandRunner: {
      async execFile(file, args) {
        calls.push({ file, args });
        return {};
      },
    },
  });

  await assert.rejects(
    adapter.execute({ command: 'background', settle_ms: -1 }, context()),
    /app\.lifecycle\.settle_ms must be an integer from 0 through 60000/,
  );
  await assert.rejects(
    adapter.execute({ command: 'background', timeout_ms: 1.5 }, context()),
    /app\.lifecycle\.timeout_ms must be an integer/,
  );
  assert.deepEqual(calls, []);
});

test('app.lifecycle runs prelaunch calls before foreground launch calls', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const adapter = createAppLifecycleAdapter({
    targetProvider: {
      resolveTarget() {
        return {
          platform: 'android',
          deviceId: 'serial-1',
          appId: 'com.example.app',
          metroPort: 8063,
          launchUrl: 'expo-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8063',
          prelaunchCalls: [
            {
              file: 'curl',
              args: ['-fsS', '-o', '/dev/null', 'http://localhost:8063/index.bundle'],
            },
          ],
        };
      },
    },
    commandRunner: {
      async execFile(file, args) {
        calls.push({ file, args });
        return {};
      },
    },
  });

  await adapter.execute({ command: 'foreground' }, context());

  assert.deepEqual(calls, [
    { file: 'curl', args: ['-fsS', '-o', '/dev/null', 'http://localhost:8063/index.bundle'] },
    {
      file: 'adb',
      args: ['-s', 'serial-1', 'reverse', 'tcp:8063', 'tcp:8063'],
    },
    {
      file: 'adb',
      args: [
        '-s',
        'serial-1',
        'shell',
        'am',
        'start',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        'expo-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8063',
      ],
    },
  ]);
});

test('app.lifecycle restarts iOS simulator by terminate then openurl', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const adapter = createAppLifecycleAdapter({
    targetProvider: {
      resolveTarget() {
        return {
          platform: 'ios-simulator',
          deviceId: 'booted',
          appId: 'com.example.app',
          launchUrl: 'expo-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8063',
        };
      },
    },
    commandRunner: {
      async execFile(file, args) {
        calls.push({ file, args });
        return {};
      },
    },
  });

  await adapter.execute({ command: 'restart' }, context());

  assert.deepEqual(calls, [
    { file: 'xcrun', args: ['simctl', 'terminate', 'booted', 'com.example.app'] },
    {
      file: 'xcrun',
      args: [
        'simctl',
        'openurl',
        'booted',
        'expo-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8063',
      ],
    },
  ]);
});

test('app.lifecycle restart tolerates iOS simulator app already stopped', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const adapter = createAppLifecycleAdapter({
    targetProvider: {
      resolveTarget() {
        return {
          platform: 'ios-simulator',
          deviceId: 'booted',
          appId: 'com.example.app',
          launchUrl: 'expo-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8063',
        };
      },
    },
    commandRunner: {
      async execFile(file, args) {
        calls.push({ file, args });
        if (args.includes('terminate')) {
          throw new Error('simctl terminate failed: com.example.app is not running');
        }
        return {};
      },
    },
  });

  const result = await adapter.execute({ command: 'restart' }, context());

  assert.deepEqual(calls, [
    { file: 'xcrun', args: ['simctl', 'terminate', 'booted', 'com.example.app'] },
    {
      file: 'xcrun',
      args: [
        'simctl',
        'openurl',
        'booted',
        'expo-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8063',
      ],
    },
  ]);
  assert.equal(
    (result.output as { calls: Array<{ ignoredFailure?: boolean }> }).calls[0].ignoredFailure,
    true,
  );
});

test('app.lifecycle backgrounds iOS simulator by foregrounding Settings', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const adapter = createAppLifecycleAdapter({
    targetProvider: {
      resolveTarget() {
        return {
          platform: 'ios-simulator',
          deviceId: 'booted',
          appId: 'com.example.app',
        };
      },
    },
    commandRunner: {
      async execFile(file, args) {
        calls.push({ file, args });
        return {};
      },
    },
  });

  await adapter.execute({ command: 'background' }, context());

  assert.deepEqual(calls, [
    { file: 'xcrun', args: ['simctl', 'launch', 'booted', 'com.apple.Preferences'] },
  ]);
});

test('app.lifecycle terminates Android through am force-stop', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const adapter = createAppLifecycleAdapter({
    targetProvider: {
      resolveTarget() {
        return { platform: 'android', deviceId: 'serial-1', appId: 'com.example.app' };
      },
    },
    commandRunner: {
      async execFile(file, args) {
        calls.push({ file, args });
        return {};
      },
    },
  });

  const result = await adapter.execute({ command: 'terminate' }, context());

  assert.deepEqual(calls, [
    {
      file: 'adb',
      args: ['-s', 'serial-1', 'shell', 'am', 'force-stop', 'com.example.app'],
    },
  ]);
  assert.equal((result.output as { command: string }).command, 'terminate');
});

test('app.lifecycle launches Android via monkey when no deep link is provided', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const adapter = createAppLifecycleAdapter({
    targetProvider: {
      resolveTarget() {
        return { platform: 'android', deviceId: 'serial-1', appId: 'com.example.app' };
      },
    },
    commandRunner: {
      async execFile(file, args) {
        calls.push({ file, args });
        return {};
      },
    },
  });

  await adapter.execute({ command: 'launch' }, context());

  assert.deepEqual(calls, [
    {
      file: 'adb',
      args: [
        '-s',
        'serial-1',
        'shell',
        'monkey',
        '-p',
        'com.example.app',
        '-c',
        'android.intent.category.LAUNCHER',
        '1',
      ],
    },
  ]);
});

test('app.lifecycle launches iOS simulator app directly when no deep link is provided', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const adapter = createAppLifecycleAdapter({
    targetProvider: {
      resolveTarget() {
        return { platform: 'ios-simulator', deviceId: 'SIM-UDID', appId: 'io.example.App' };
      },
    },
    commandRunner: {
      async execFile(file, args) {
        calls.push({ file, args });
        return {};
      },
    },
  });

  await adapter.execute({ command: 'launch' }, context());

  assert.deepEqual(calls, [
    {
      file: 'xcrun',
      args: ['simctl', 'launch', 'SIM-UDID', 'io.example.App'],
    },
  ]);
});
