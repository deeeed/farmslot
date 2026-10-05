// Shared connected-device enumeration for first-class `--device` targeting and the
// `status` devices section. Every probe shells the platform tool via execFile with
// an argv array (NEVER a string-interpolated shell) so a device id can never inject.

import { execFileSync } from 'node:child_process';

import { resolveMobileToolPath } from './tool-paths.js';

const IOS_DEVICE_DISCOVERY_TIMEOUT_MS = 30_000;

export type DevicePlatform = 'ios' | 'android';

export interface ConnectedDevice {
  platform: DevicePlatform;
  id: string;
  name?: string;
  state: string;
}

export interface DeviceDiscoveryError {
  platform: DevicePlatform;
  message: string;
  userAction: string;
  probeCode?: string | number;
}

function reportProbeFailure(
  errors: DeviceDiscoveryError[],
  platform: DevicePlatform,
  error: unknown,
): void {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return;
  const timeoutSeconds = platform === 'ios' ? IOS_DEVICE_DISCOVERY_TIMEOUT_MS / 1000 : 5;
  const reason = code === 'ETIMEDOUT' ? `timed out after ${timeoutSeconds} seconds` : 'failed';
  const probeCode = code ?? (error as { status?: number })?.status;
  errors.push({
    platform,
    message: `${platform} device discovery ${reason}; device availability is unknown.`,
    userAction: platform === 'ios' ? 'xcrun simctl list devices booted -j' : 'adb devices -l',
    ...(probeCode !== undefined ? { probeCode } : {}),
  });
}

// Enumerate the connected devices for one platform (or both when unspecified).
// Advisory by contract: a missing tool (no `adb`, non-macOS with no `xcrun`) yields
// [] for that platform rather than throwing — see listAndroidDevices/listIosSimulators.
export function listConnectedDevices(
  platform?: DevicePlatform,
  errors: DeviceDiscoveryError[] = [],
): ConnectedDevice[] {
  const devices: ConnectedDevice[] = [];
  if (!platform || platform === 'android') devices.push(...listAndroidDevices(errors));
  if (!platform || platform === 'ios') devices.push(...listIosSimulators('booted', errors));
  return devices;
}

// Launch may need to resolve a simulator before it is booted. Keep the normal
// connected-device inventory booted-only, but expose the same parsed identity
// shape for the launch target resolver.
export function findAvailableIosSimulatorById(
  id: string,
  errors: DeviceDiscoveryError[] = [],
): ConnectedDevice | undefined {
  for (const simulator of listIosSimulators('available', errors)) {
    if (simulator.id === id) return simulator;
  }
  return undefined;
}

function listAndroidDevices(errors: DeviceDiscoveryError[]): ConnectedDevice[] {
  const adbPath = resolveMobileToolPath('adb');
  if (!adbPath) return [];
  let output: string;
  try {
    output = execFileSync(adbPath, ['devices', '-l'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    reportProbeFailure(errors, 'android', error);
    return [];
  }
  if (!output.trimStart().startsWith('List of devices attached')) {
    errors.push({
      platform: 'android',
      message:
        'Android device discovery returned an invalid response; device availability is unknown.',
      userAction: 'adb devices -l',
    });
    return [];
  }
  const devices: ConnectedDevice[] = [];
  // First line is the "List of devices attached" header; each remaining non-empty
  // line is "<serial> <state> [key:value ...]" (e.g. model:Pixel_7).
  for (const line of output.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(/\s+/u);
    const id = fields[0];
    const state = fields[1] ?? 'unknown';
    if (!id) continue;
    const modelField = fields.find((f) => f.startsWith('model:'));
    const name = modelField ? modelField.slice('model:'.length) : undefined;
    devices.push({ platform: 'android', id, state, ...(name ? { name } : {}) });
  }
  return devices;
}

interface SimctlDevice {
  udid?: string;
  name?: string;
  state?: string;
}

function listIosSimulators(
  scope: 'booted' | 'available',
  errors: DeviceDiscoveryError[],
): ConnectedDevice[] {
  let output: string;
  try {
    output = execFileSync('xcrun', ['simctl', 'list', 'devices', scope, '-j'], {
      encoding: 'utf8',
      timeout: IOS_DEVICE_DISCOVERY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    reportProbeFailure(errors, 'ios', error);
    return [];
  }
  let parsed: { devices?: Record<string, SimctlDevice[]> };
  try {
    parsed = JSON.parse(output) as { devices?: Record<string, SimctlDevice[]> };
    if (
      !parsed?.devices ||
      typeof parsed.devices !== 'object' ||
      Array.isArray(parsed.devices) ||
      Object.values(parsed.devices).some(
        (devices) =>
          !Array.isArray(devices) ||
          devices.some((device) => !device || typeof device.udid !== 'string'),
      )
    ) {
      throw new Error('Invalid simctl device inventory');
    }
  } catch {
    errors.push({
      platform: 'ios',
      message: 'iOS device discovery returned an invalid response; device availability is unknown.',
      userAction: `xcrun simctl list devices ${scope} -j`,
    });
    return [];
  }
  const devices: ConnectedDevice[] = [];
  for (const runtimeDevices of Object.values(parsed.devices ?? {})) {
    for (const device of runtimeDevices) {
      if (!device.udid) continue;
      devices.push({
        platform: 'ios',
        id: device.udid,
        state: device.state ?? 'unknown',
        ...(device.name ? { name: device.name } : {}),
      });
    }
  }
  return devices;
}
