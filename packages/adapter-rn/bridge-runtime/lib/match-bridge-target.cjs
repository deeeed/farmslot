'use strict';

// Boundary-safe matcher for CDP bridge targets, shared by wait-for-bridge and the
// launch ready-path confirm. A launch (or its confirm) may only accept a target
// belonging to the REQUESTED platform — and the requested device when one is pinned.
//
// The requested platform is authoritative and is passed explicitly
// (WAIT_FOR_BRIDGE_PLATFORM), so it wins over env inference. On a dual-platform slot
// the other platform's device identity is ambiently injected (a slot-context
// IOS_SIMULATOR while launching android, or vice versa); without an explicit platform
// the matcher would fall back to that ambient identity and confirm against the wrong
// platform's target. Binding the platform up front closes that corner.

// Metro names a physical device by its model ("Pixel 6a - 17 - API 37"), but the
// in-app bridge snapshot can prefix the manufacturer ("Google Pixel 6a"). Accept that
// form only for a physical device (not an emulator- serial) and only with the model as
// whole trailing words, so "Pixel 6" never matches "Google Pixel 6a".
function manufacturerNameMatches(deviceName, androidName, adbSerial) {
  if (!adbSerial || adbSerial.startsWith('emulator-')) return false;
  if (deviceName === androidName || deviceName.startsWith(`${androidName} -`)) return false;
  return deviceName.endsWith(` ${androidName}`) || deviceName.includes(` ${androidName} -`);
}

function matchesBridgeTarget(target, env) {
  const e = env || process.env;
  if (!target || typeof target !== 'object') return false;

  const requirePlatform = e.WAIT_FOR_BRIDGE_PLATFORM || '';
  // Requested platform is authoritative: never accept the other platform's target,
  // whatever device env is ambiently present.
  if (requirePlatform && target.platform !== requirePlatform) return false;

  const androidName = e.ANDROID_TARGET_DEVICE_NAME || e.ANDROID_DEVICE || '';
  const adbSerial = e.ADB_SERIAL || e.ANDROID_SERIAL || '';
  const iosSimulator = e.IOS_SIMULATOR || '';

  // Android device pin applies only when android is requested (or nothing constrains
  // the platform); it must never redirect a platform-bound iOS confirm — a slot-context
  // ADB_SERIAL while launching iOS must not reject every iOS target. Symmetric with the
  // iOS-simulator branch below.
  if ((adbSerial || androidName) && (!requirePlatform || requirePlatform === 'android')) {
    // Require android + boundary-safe device-name match.
    if (target.platform !== 'android') return false;
    if (!androidName) return true;
    const deviceName = String(target.deviceName || '');
    if (deviceName === androidName || deviceName.startsWith(`${androidName} -`)) return true;
    return manufacturerNameMatches(deviceName, androidName, adbSerial);
  }

  // iOS simulator pin applies only when iOS is requested (or nothing constrains the
  // platform); it must never redirect a platform-bound android confirm.
  if (iosSimulator && (!requirePlatform || requirePlatform === 'ios')) {
    return target.platform !== 'android' && target.deviceName === iosSimulator;
  }

  // No device pin: the platform gate above is the only constraint.
  return true;
}

// True when at least one answering target matches the request AND carries a route
// (an in-app agentic bridge is live), not merely a registered debug target.
// Two phones of the same model on one Metro both report "Google Pixel 6a"; the
// snapshot cannot tell which one is pinned, so a manufacturer-form match counts only
// when it is the sole one. The count includes entries that have not reported a
// platform yet: the pinned phone may still be starting while the other one answers.
function hasMatchingRoute(value, env) {
  const e = env || process.env;
  const entries = (Array.isArray(value) ? value : [value]).filter(
    (t) => t && typeof t === 'object',
  );
  const androidName = e.ANDROID_TARGET_DEVICE_NAME || e.ANDROID_DEVICE || '';
  const adbSerial = e.ADB_SERIAL || e.ANDROID_SERIAL || '';
  const manufacturerForm = (t) =>
    Boolean(androidName) &&
    (!t.platform || t.platform === 'android') &&
    manufacturerNameMatches(String(t.deviceName || ''), androidName, adbSerial);
  const ambiguous = entries.filter(manufacturerForm).length > 1;
  return entries.some(
    (t) =>
      matchesBridgeTarget(t, e) &&
      !(ambiguous && manufacturerForm(t)) &&
      t.agenticPresent === true &&
      Boolean(t.route),
  );
}

// Human summary of the targets that answered (platform / deviceName), for teaching on
// a timeout — e.g. an iOS target answering an android launch.
function describeTargets(value) {
  const targets = (Array.isArray(value) ? value : [value]).filter(
    (t) => t && typeof t === 'object',
  );
  if (!targets.length) return 'none';
  return targets
    .map(
      (t) =>
        `${t.platform || '?'}${t.deviceName ? `/'${t.deviceName}'` : ''}${t.route ? '' : ' (no route)'}`,
    )
    .join(', ');
}

// Human summary of what the run is pinned to, for the same teaching line.
function describeRequested(env) {
  const e = env || process.env;
  const platform = e.WAIT_FOR_BRIDGE_PLATFORM || '';
  const androidName = e.ANDROID_TARGET_DEVICE_NAME || e.ANDROID_DEVICE || '';
  const adbSerial = e.ADB_SERIAL || e.ANDROID_SERIAL || '';
  const iosSimulator = e.IOS_SIMULATOR || '';
  // Explicit requested platform wins over device-env inference: an iOS-bound confirm
  // with an ambient ADB_SERIAL is still iOS.
  if (platform === 'android') return `android${androidName ? ` / ${androidName}` : ''}`;
  if (platform === 'ios') return `ios${iosSimulator ? ` / ${iosSimulator}` : ''}`;
  if (adbSerial || androidName) return `android${androidName ? ` / ${androidName}` : ''}`;
  if (iosSimulator) return `ios${iosSimulator ? ` / ${iosSimulator}` : ''}`;
  return 'any platform';
}

module.exports = {
  matchesBridgeTarget,
  manufacturerNameMatches,
  hasMatchingRoute,
  describeTargets,
  describeRequested,
};
