import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  await adapter.execute({ command: 'launch' }, context());

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
        "'expo-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8063'",
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

test('app.lifecycle foregrounds Android without reopening its launch URL', async () => {
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
      args: [
        '-s',
        'serial-1',
        'shell',
        'monkey',
        '-p',
        "'com.example.app'",
        '-c',
        'android.intent.category.LAUNCHER',
        '1',
      ],
    },
  ]);
});

test('app.lifecycle foregrounds iOS without reopening its launch URL', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const adapter = createAppLifecycleAdapter({
    targetProvider: {
      resolveTarget() {
        return {
          platform: 'ios-simulator',
          deviceId: 'SIM-UDID',
          appId: 'io.example.App',
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
    { file: 'xcrun', args: ['simctl', 'launch', 'SIM-UDID', 'io.example.App'] },
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

for (const alreadyStoppedMessage of [
  'simctl terminate failed: com.example.app is not running',
  'Simulator device failed to terminate com.example.app. found nothing to terminate',
]) {
  test(`app.lifecycle restart tolerates iOS simulator error: ${alreadyStoppedMessage}`, async () => {
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
            throw new Error(alreadyStoppedMessage);
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
}

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
      args: ['-s', 'serial-1', 'shell', 'am', 'force-stop', "'com.example.app'"],
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
        "'com.example.app'",
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

// adb joins the words after `shell` into one command line for the device's
// shell. Run that line through a POSIX sh where `am` and `monkey` print their
// arguments NUL-terminated (so empty fields and newlines survive), to see the
// exact argv the device would receive.
function deviceShellArgs(adbArgs: string[]): string[] {
  const commandLine = adbArgs.slice(adbArgs.indexOf('shell') + 1).join(' ');
  const printArgs = `for arg in "$@"; do printf '%s\\000' "$arg"; done`;
  const result = spawnSync(
    'sh',
    ['-c', `am() { ${printArgs}; }; monkey() { ${printArgs}; }; ${commandLine}; wait`],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `device shell failed: ${result.stderr}`);
  return result.stdout.split('\0').slice(0, -1);
}

function androidAdapter(target: { appId: string; launchUrl?: string }, calls: string[][]) {
  return createAppLifecycleAdapter({
    targetProvider: {
      resolveTarget() {
        return { platform: 'android', deviceId: 'serial-1', ...target };
      },
    },
    commandRunner: {
      async execFile(_file, args) {
        calls.push(args);
        return {};
      },
    },
  });
}

test('app.lifecycle passes an Expo launch URL with & to the device shell whole', async () => {
  const launchUrl =
    'expo-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8063&disableOnboarding=1';
  const calls: string[][] = [];
  await androidAdapter({ appId: 'com.example.app', launchUrl }, calls).execute(
    { command: 'launch' },
    context(),
  );
  const start = calls.find((args) => args.includes('start'));
  assert.ok(start);
  assert.deepEqual(deviceShellArgs(start), [
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    launchUrl,
  ]);
});

test('app.lifecycle keeps a launch URL with ; from running a second device command', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'app-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = path.join(dir, 'ran');
  const launchUrl = `expo-example://x/?a=1; touch ${sentinel}`;
  const calls: string[][] = [];
  await androidAdapter({ appId: 'com.example.app', launchUrl }, calls).execute(
    { command: 'launch' },
    context(),
  );
  const start = calls.find((args) => args.includes('start'));
  assert.ok(start);
  assert.deepEqual(deviceShellArgs(start).slice(-2), ['-d', launchUrl]);
  assert.equal(existsSync(sentinel), false, 'the launch URL ran a second command on the device');
});

// Values the device shell would otherwise interpret: each must arrive verbatim.
const awkwardValues: Record<string, string> = {
  apostrophe: "it's",
  backslash: 'back\\slash',
  home: '$HOME',
  subshell: '$(id)',
  backticks: '`id`',
  unicode: 'h\u00e9llo \u2713',
  newline: 'line1\nline2',
};

test('app.lifecycle passes awkward launch URLs to the device shell verbatim', async () => {
  for (const [name, value] of Object.entries(awkwardValues)) {
    const launchUrl = `expo-example://x/?q=${value}`;
    const calls: string[][] = [];
    await androidAdapter({ appId: 'com.example.app', launchUrl }, calls).execute(
      { command: 'launch' },
      context(),
    );
    const start = calls.find((args) => args.includes('start'));
    assert.ok(start, name);
    assert.deepEqual(
      deviceShellArgs(start),
      ['start', '-a', 'android.intent.action.VIEW', '-d', launchUrl],
      name,
    );
  }
});

test('app.lifecycle passes awkward app ids to the device shell verbatim', async () => {
  const appIds: Record<string, string> = {
    // No quote: on an unquoted shell line this splits into a second command.
    split: 'com.example.app; echo SECOND',
    splitWithQuote: "com.example.app; echo it's",
    ...Object.fromEntries(
      Object.entries(awkwardValues).map(([name, value]) => [name, `com.example.${value}`]),
    ),
  };
  for (const [name, appId] of Object.entries(appIds)) {
    const terminate: string[][] = [];
    await androidAdapter({ appId }, terminate).execute({ command: 'terminate' }, context());
    assert.deepEqual(deviceShellArgs(terminate.at(-1) ?? []), ['force-stop', appId], name);
    const foreground: string[][] = [];
    await androidAdapter({ appId }, foreground).execute({ command: 'foreground' }, context());
    assert.deepEqual(
      deviceShellArgs(foreground.at(-1) ?? []),
      ['-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'],
      name,
    );
  }
});

test('app.lifecycle launches through monkey for an empty launch URL', async () => {
  const calls: string[][] = [];
  await androidAdapter({ appId: 'com.example.app', launchUrl: '' }, calls).execute(
    { command: 'launch' },
    context(),
  );
  assert.deepEqual(deviceShellArgs(calls.at(-1) ?? []), [
    '-p',
    'com.example.app',
    '-c',
    'android.intent.category.LAUNCHER',
    '1',
  ]);
});
