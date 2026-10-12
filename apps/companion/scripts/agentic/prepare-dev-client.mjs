import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { openAndroidDevClient, openSimulatorDevClient } from './simulator-dev-client.mjs';

const androidPreferences = 'shared_prefs/expo.modules.devmenu.sharedpreferences.xml';
const preferences = [
  { android: 'isOnboardingFinished', ios: 'EXDevMenuIsOnboardingFinished', value: true },
  { android: 'showsAtLaunch', ios: 'EXDevMenuShowsAtLaunch', value: false },
  { android: 'showFab', ios: 'EXDevMenuShowFloatingActionButton', value: false },
];

export function preparedDevMenuPreferences(
  xml = '<?xml version="1.0" encoding="utf-8"?><map></map>',
) {
  xml = xml.replace(/<map\s*\/>/, '<map></map>');
  assert(xml.includes('</map>'), 'The installed dev-menu preferences are not an XML map');
  for (const { android: name, value } of preferences) {
    const entry = `<boolean name="${name}" value="${value}" />`;
    const existing = new RegExp(`<boolean\\s+name="${name}"\\s+value="(?:true|false)"\\s*/>`);
    xml = existing.test(xml)
      ? xml.replace(existing, entry)
      : xml.replace('</map>', `${entry}</map>`);
  }
  return xml;
}

export async function prepareDevClient(platform, target, bundleId) {
  assert(['ios', 'android'].includes(platform), 'Select ios or android');
  assert(target, 'Select the prepare profile device');
  assert(/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+$/.test(bundleId), 'Select an app bundle ID');
  if (platform === 'ios') {
    for (const { ios: name, value } of preferences) {
      execFileSync('xcrun', [
        'simctl',
        'spawn',
        target,
        'defaults',
        'write',
        bundleId,
        name,
        '-bool',
        String(value),
      ]);
    }
    execFileSync('xcrun', ['simctl', 'launch', '--terminate-running-process', target, bundleId]);
    await openSimulatorDevClient(target, { waitForBridge: false });
    return;
  }
  execFileSync('adb', ['-s', target, 'shell', 'am', 'force-stop', bundleId]);
  const exists = spawnSync('adb', [
    '-s',
    target,
    'shell',
    'run-as',
    bundleId,
    'test',
    '-f',
    androidPreferences,
  ]);
  const xml =
    exists.status === 0
      ? execFileSync(
          'adb',
          ['-s', target, 'exec-out', 'run-as', bundleId, 'cat', androidPreferences],
          { encoding: 'utf8' },
        )
      : undefined;
  execFileSync('adb', ['-s', target, 'shell', 'run-as', bundleId, 'mkdir', '-p', 'shared_prefs']);
  execFileSync(
    'adb',
    ['-s', target, 'exec-in', 'run-as', bundleId, 'dd', `of=${androidPreferences}`, 'bs=65536'],
    {
      input: preparedDevMenuPreferences(xml),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  // A fresh installation can be prepared before its Gateway is paired. The
  // farm recipe bridge mounts only after a farm connection is authorized.
  await openAndroidDevClient(target, bundleId, { waitForBridge: false });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await prepareDevClient(process.argv[2], process.argv[3], process.argv[4]);
}
