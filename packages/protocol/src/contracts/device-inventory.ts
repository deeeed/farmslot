/**
 * The devices a slot's machine actually has (MANUAL-000124).
 *
 * ADR-054 item 3 shipped device re-targeting with no inventory: an identity was
 * validated only by the provider's own acquire action, which happens AFTER the
 * posture has released the device the run was holding. A typo therefore cost a
 * run its device and gave it nothing back. This contract is what lets a
 * re-target be refused first, and what feeds the operator a list to pick from
 * instead of a free-text field.
 *
 * Read-only and machine-scoped: a device name identifies a device on ONE
 * machine, so every entry here belongs to `machine` and nothing compares across
 * machines.
 */
import type { RuntimeCapabilityTargetKey } from './runtime-capabilities.js';

/** Which provider family an entry belongs to. */
export const DEVICE_INVENTORY_PLATFORMS = ['ios', 'android'] as const;
export type DeviceInventoryPlatform = (typeof DEVICE_INVENTORY_PLATFORMS)[number];

/**
 * The device-identity key an entry can be named by.
 *
 * A subset of the re-target keys: `platform` selects a provider rather than a
 * device, so it is never an inventory entry.
 */
export type DeviceInventoryKey = Exclude<RuntimeCapabilityTargetKey, 'platform'>;

/**
 * The tools an inventory is built from. Each answers for exactly the keys it
 * knows, which is what makes a partial read usable: `simctl` being absent says
 * nothing about whether an `avd` exists.
 */
export const DEVICE_INVENTORY_TOOLS = ['simctl', 'adb', 'emulator'] as const;
export type DeviceInventoryTool = (typeof DEVICE_INVENTORY_TOOLS)[number];

/** Which tool answers for a given identity key. */
export const DEVICE_INVENTORY_KEY_TOOL: Record<DeviceInventoryKey, DeviceInventoryTool> = {
  simulator: 'simctl',
  udid: 'simctl',
  avd: 'emulator',
  adb_serial: 'adb',
};

/**
 * Whether a tool's silence about an identity is evidence that it does not
 * EXIST, as opposed to evidence that it is not running right now.
 *
 * `simctl list devices` and `emulator -list-avds` enumerate what is installed,
 * whatever state it is in, so an identity they omit does not exist. `adb
 * devices -l` enumerates currently CONNECTED transports: an unplugged phone and
 * an unbooted emulator are both absent from it, and booting them is exactly
 * what the provider acquire would do. Treating that absence as nonexistence
 * refused every legitimate re-target to a device that was not already up.
 *
 * So `adb_serial` is never refused on absence. The provider's own `adb
 * get-state` remains the closed door behind it, as it was before this inventory
 * existed.
 */
export const DEVICE_INVENTORY_KEY_LISTS_EXISTENCE: Record<DeviceInventoryKey, boolean> = {
  simulator: true,
  udid: true,
  avd: true,
  adb_serial: false,
};

export interface DeviceInventoryEntry {
  platform: DeviceInventoryPlatform;
  /** The re-target key this identity may be sent as. */
  key: DeviceInventoryKey;
  /** The value a `target` would carry — a simulator name, a udid, an avd, a serial. */
  identity: string;
  /** Human name of the device, which for `simulator`/`avd` equals the identity. */
  name: string;
  /**
   * The tool's own word for the device's state, passed through unchanged
   * (`Booted`, `Shutdown`, `device`, `offline`, `available`). Not normalized:
   * every normalization we tried lost the distinction an operator needed.
   */
  state: string;
  /**
   * Every slot on this machine whose configured resources name this identity,
   * sorted.
   *
   * A list, not one slot: two slots legitimately share one physical device —
   * that is the contention fleet-scoped claims exist for — and naming only the
   * first would tell an operator the device is free on the slot it hides.
   * Absent when no slot configures it.
   */
  configuredForSlots?: string[];
}

/** Whether one tool answered, and why not when it did not. */
export interface DeviceInventorySource {
  tool: DeviceInventoryTool;
  ok: boolean;
  /** The tool's own failure text, when it failed. */
  detail?: string;
}

export interface DeviceInventoryResult {
  /** The machine the slot runs on; every entry belongs to it. */
  machine: string;
  slotId: string;
  devices: DeviceInventoryEntry[];
  sources: DeviceInventorySource[];
  /** When this inventory was collected. A cached read repeats the original time. */
  collectedAt: string;
  /** True when this result came from the per-machine cache rather than the tools. */
  cached: boolean;
}

/**
 * A re-target refused because the machine's inventory does not have the device.
 *
 * Typed rather than a bare string so a client can offer `nearest` as choices
 * instead of reprinting a sentence.
 */
export interface DeviceInventoryRefusal {
  code: 'device-not-in-inventory';
  machine: string;
  key: DeviceInventoryKey;
  identity: string;
  /** Identities of the same key the machine does have, nearest first. */
  nearest: string[];
  reason: string;
}

/**
 * Whether this inventory can say an identity of `key` does not exist.
 *
 * Two conditions, and both are load-bearing: the tool that answers for the key
 * actually answered, AND that tool enumerates existence rather than current
 * connectivity. Either one missing means silence proves nothing, and the caller
 * must not refuse.
 */
export function deviceInventoryCovers(
  sources: readonly DeviceInventorySource[],
  key: DeviceInventoryKey,
): boolean {
  if (!DEVICE_INVENTORY_KEY_LISTS_EXISTENCE[key]) return false;
  const tool = DEVICE_INVENTORY_KEY_TOOL[key];
  return sources.some((source) => source.tool === tool && source.ok);
}
