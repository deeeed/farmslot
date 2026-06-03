// stream-resolve.ts — resolve slot to stream source identifiers per platform

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadProjectVars } from '../core/config.js';
import { getCachedFleet, loadPoolConfigs } from '../fleet/state.js';

export interface SlotStreamInfo {
  iosWindowName: string;
  androidSerial: string;
  browserPid: number | null;
}

let poolCache: Awaited<ReturnType<typeof loadPoolConfigs>> | null = null;

async function getPoolSlot(slotId: string) {
  if (!poolCache) poolCache = await loadPoolConfigs();
  for (const pool of poolCache) {
    const slot = pool.slots.find((s) => s.id === slotId);
    if (slot) return { poolSlot: slot, pool };
  }
  return null;
}

export async function resolveSlotStreamAsync(slotId: string): Promise<SlotStreamInfo> {
  const fleet = getCachedFleet();
  const slot = fleet?.slots.find((s) => s.slot === slotId);
  const poolResult = await getPoolSlot(slotId);

  // Default: derive from slot ID
  let iosWindowName = slotId;
  let androidSerial = '';

  if (slot) {
    const parts = slotId.split('-');
    if (parts.length >= 3) {
      iosWindowName = parts.slice(1).join('-');
    }

    if (slot.deviceName && !slot.deviceName.match(/^[A-Z0-9]{10,}$/)) {
      iosWindowName = slot.deviceName;
    }

    if (slot.deviceName && slot.deviceName.match(/^(emulator-\d+|[A-Z0-9]{10,})$/)) {
      androidSerial = slot.deviceName;
    }
  }

  // Pool resources are the source of truth for device identifiers
  if (poolResult) {
    const resources = poolResult.poolSlot.resources ?? {};
    const iosSim = (resources['ios-sim']?.simulator as string) || '';
    if (iosSim) iosWindowName = iosSim;

    const adbSerial = (resources['android-emu']?.adb_serial as string) || '';
    if (adbSerial) androidSerial = adbSerial;
  }

  return { iosWindowName, androidSerial, browserPid: null };
}

// Sync version for backward compat (uses fleet cache only)
export function resolveSlotStream(slotId: string): SlotStreamInfo {
  const fleet = getCachedFleet();
  const slot = fleet?.slots.find((s) => s.slot === slotId);

  let iosWindowName = slotId;
  let androidSerial = slotId;

  if (slot) {
    const parts = slotId.split('-');
    if (parts.length >= 3) {
      iosWindowName = parts.slice(1).join('-');
    }
    if (slot.deviceName && !slot.deviceName.match(/^[A-Z0-9]{10,}$/)) {
      iosWindowName = slot.deviceName;
    }
    if (slot.deviceName && slot.deviceName.match(/^(emulator-\d+|[A-Z0-9]{10,})$/)) {
      androidSerial = slot.deviceName;
    }
  }

  return { iosWindowName, androidSerial, browserPid: null };
}

/** Resolve the actual browser (Chromium) PID for a slot.
 *  Prefers chromium.pid (written by launch-browser.sh), falls back to browser.pid + child-walk.
 */
export async function resolveBrowserPid(slotId: string): Promise<number | null> {
  const result = await getPoolSlot(slotId);
  if (!result) return null;
  const projectName = result.poolSlot.project ?? result.pool.project;
  const projectVars = await loadProjectVars(projectName);
  const runtimeDir = join(result.poolSlot.repo, projectVars.runtimeDir);
  try {
    // Fast path: chromium.pid has the actual browser PID
    const chromiumPidFile = join(runtimeDir, 'chromium.pid');
    if (existsSync(chromiumPidFile)) {
      const pid = parseInt(readFileSync(chromiumPidFile, 'utf-8').trim(), 10);
      if (!isNaN(pid)) return pid;
    }
    // Fallback: browser.pid may be the launcher — walk children to find browser
    const browserPidFile = join(runtimeDir, 'browser.pid');
    if (!existsSync(browserPidFile)) return null;
    const pid = parseInt(readFileSync(browserPidFile, 'utf-8').trim(), 10);
    if (isNaN(pid)) return null;
    return resolveBrowserChildPid(pid);
  } catch {
    return null;
  }
}

/** If pid is a node/playwright wrapper, find the actual browser child process. */
function resolveBrowserChildPid(pid: number): number {
  try {
    const comm = execSync(`ps -p ${pid} -o comm=`, { timeout: 2000 }).toString().trim();
    // If it's already a browser process, return as-is
    if (/[Cc]hrom|[Ff]irefox|[Ss]afari/.test(comm)) return pid;
    // Look for a browser child process
    const children = execSync(`pgrep -P ${pid}`, { timeout: 2000 }).toString().trim().split('\n');
    for (const childStr of children) {
      const childPid = parseInt(childStr, 10);
      if (isNaN(childPid)) continue;
      const childComm = execSync(`ps -p ${childPid} -o comm=`, { timeout: 2000 }).toString().trim();
      if (/[Cc]hrom|[Ff]irefox|[Ss]afari/.test(childComm)) return childPid;
    }
  } catch {
    /* pgrep/ps failed — fall through */
  }
  return pid;
}

// Backward compat
export function resolveSlotSimulator(slotId: string): string {
  return resolveSlotStream(slotId).iosWindowName;
}
