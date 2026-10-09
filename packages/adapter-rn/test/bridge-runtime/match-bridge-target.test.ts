import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);

type Env = Record<string, string>;
type Target = { platform?: string; deviceName?: string; route?: string; agenticPresent?: boolean };

const { matchesBridgeTarget, hasMatchingRoute } =
  require('../../bridge-runtime/lib/match-bridge-target.cjs') as {
    matchesBridgeTarget(target: Target, env: Env): boolean;
    hasMatchingRoute(value: Target | Target[], env: Env): boolean;
  };

const phone: Env = {
  WAIT_FOR_BRIDGE_PLATFORM: 'android',
  ADB_SERIAL: '29071JEGR20638',
  ANDROID_TARGET_DEVICE_NAME: 'Pixel 6a',
};
const emulator: Env = {
  WAIT_FOR_BRIDGE_PLATFORM: 'android',
  ADB_SERIAL: 'emulator-5554',
  ANDROID_TARGET_DEVICE_NAME: 'Pixel 6a',
};
const live = (deviceName: string): Target => ({
  platform: 'android',
  deviceName,
  route: 'Login',
  agenticPresent: true,
});

describe('matchesBridgeTarget android device name', () => {
  it('keeps the Metro model forms', () => {
    assert.equal(matchesBridgeTarget(live('Pixel 6a'), emulator), true);
    assert.equal(matchesBridgeTarget(live('Pixel 6a - 17 - API 37'), emulator), true);
  });

  it('accepts the manufacturer-prefixed name of a physical device', () => {
    assert.equal(matchesBridgeTarget(live('Google Pixel 6a'), phone), true);
    assert.equal(matchesBridgeTarget(live('Google Pixel 6a - 17 - API 37'), phone), true);
    assert.equal(hasMatchingRoute([live('Google Pixel 6a')], phone), true);
  });

  it('matches the model as whole words only', () => {
    const pixel6 = { ...phone, ANDROID_TARGET_DEVICE_NAME: 'Pixel 6' };
    assert.equal(matchesBridgeTarget(live('Google Pixel 6a'), pixel6), false);
    assert.equal(matchesBridgeTarget(live('GooglePixel 6a'), phone), false);
  });

  it('never gives an emulator the manufacturer-prefixed name', () => {
    assert.equal(matchesBridgeTarget(live('Google Pixel 6a'), emulator), false);
    const noSerial = {
      WAIT_FOR_BRIDGE_PLATFORM: 'android',
      ANDROID_TARGET_DEVICE_NAME: 'Pixel 6a',
    };
    assert.equal(matchesBridgeTarget(live('Google Pixel 6a'), noSerial), false);
  });

  it('refuses two manufacturer-prefixed matches as ambiguous', () => {
    const second = { ...live('Google Pixel 6a'), route: 'WalletView' };
    assert.equal(hasMatchingRoute([live('Google Pixel 6a'), second], phone), false);
    assert.equal(
      hasMatchingRoute([live('Google Pixel 6a'), live('Pixel 6a - 17 - API 37')], phone),
      true,
    );
  });

  it('refuses a second phone while the pinned one has not reported a platform', () => {
    const starting = { deviceName: 'Google Pixel 6a', platform: '' };
    assert.equal(hasMatchingRoute([starting, live('Google Pixel 6a')], phone), false);
  });

  it('keeps an android launch on the phone with an ambient iOS simulator', () => {
    const ambientSim = { ...phone, IOS_SIMULATOR: 'mmdev-3' };
    const ios = { platform: 'ios', deviceName: 'mmdev-3', route: 'Home', agenticPresent: true };
    assert.equal(hasMatchingRoute([ios, live('Google Pixel 6a')], ambientSim), true);
    assert.equal(hasMatchingRoute([ios], ambientSim), false);
  });

  it('keeps an iOS confirm on iOS with an ambient physical Android pin', () => {
    const iosReq = { ...phone, WAIT_FOR_BRIDGE_PLATFORM: 'ios' };
    const ios = { platform: 'ios', deviceName: 'iPhone 15', route: 'Home', agenticPresent: true };
    assert.equal(hasMatchingRoute([ios, { ...ios, deviceName: 'iPhone 16' }], iosReq), true);
    assert.equal(hasMatchingRoute([live('Google Pixel 6a')], iosReq), false);
  });
});
