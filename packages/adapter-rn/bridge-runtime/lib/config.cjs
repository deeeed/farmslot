'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Read a value from .js.env */
function loadEnvValue(key, appRoot = process.env.APP_ROOT || process.cwd()) {
  try {
    const envPath = path.resolve(appRoot, '.js.env');
    const content = fs.readFileSync(envPath, 'utf8');
    // .js.env uses `export KEY="value"` (shell-sourceable format),
    // so we handle the optional `export` prefix and strip surrounding quotes.
    const match = content.match(new RegExp(String.raw`^(?:export\s+)?${key}=(.+)$`, 'm'));
    if (match) return match[1].trim().replace(/^["']/, '').replace(/["']$/, '');
  } catch {
    // .js.env may not exist — fall through to undefined
  }
  return undefined;
}

function resolvePort(env = process.env, appRoot = env.APP_ROOT || process.cwd()) {
  return (
    env.WATCHER_PORT ||
    env.METRO_PORT ||
    loadEnvValue('WATCHER_PORT', appRoot) ||
    loadEnvValue('METRO_PORT', appRoot) ||
    '8081'
  );
}

/** Read WATCHER_PORT from .js.env or env (default: 8081) */
function loadPort() {
  return Number.parseInt(resolvePort(), 10);
}

/** Read IOS_SIMULATOR name from .js.env or env (default: none — accept any device) */
function loadSimulatorName() {
  // Explicit empty string in env means "no simulator" — don't fall through to .js.env
  if ('IOS_SIMULATOR' in process.env) return process.env.IOS_SIMULATOR;
  return loadEnvValue('IOS_SIMULATOR') || '';
}

/** Read ANDROID_DEVICE from .js.env or env (default: none — accept any device) */
function loadAndroidDevice() {
  if ('ANDROID_DEVICE' in process.env) return process.env.ANDROID_DEVICE;
  return loadEnvValue('ANDROID_DEVICE') || '';
}

/**
 * Read ANDROID_TARGET_DEVICE_NAME from env — the Metro-compatible model prefix
 * resolved from an adb serial by bridge.mjs. Used by target-discovery to select
 * the correct Metro CDP target when multiple devices are connected.
 *
 * Set automatically by the bridge when --device <serial> is used. Users never
 * need to set this; pass --device <adb-serial> and the harness maps it internally.
 */
function loadAndroidTargetDeviceName() {
  return process.env.ANDROID_TARGET_DEVICE_NAME || '';
}

module.exports = {
  loadEnvValue,
  loadPort,
  resolvePort,
  loadSimulatorName,
  loadAndroidDevice,
  loadAndroidTargetDeviceName,
};
