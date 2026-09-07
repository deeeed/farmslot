/**
 * The `target` a re-targeted recipe rerun sends (ADR-054 item 3).
 *
 * The identity is normally PICKED from the machine's device inventory
 * (MANUAL-000124), which is why `deviceTargetChoices` lives here too. The
 * free-text field stays as the fallback for a machine whose inventory is empty
 * or could not be read, and a typed identity is still validated against the
 * protocol's charset before it reaches a Gateway that substitutes it into a
 * project hook command. An empty value means "use the slot's configured device".
 *
 * Kept out of the Lit element so it is testable without a DOM.
 */
import {
  type DeviceInventoryEntry,
  type DeviceInventoryKey,
  isRuntimeCapabilityTargetKey,
  isRuntimeCapabilityTargetValue,
  RUNTIME_CAPABILITY_TARGET_VALUE_PATTERN,
  type RuntimeCapabilityTarget,
} from '@farmslot/protocol';

/** The sentinel the identity picker uses for "type it myself". */
export const RECIPE_TARGET_OTHER = '__other__';

export function recipeRerunTarget(
  key: string,
  value: string,
  /** `''` leaves the provider selection to the Gateway, which is the default. */
  platform = '',
): { target?: RuntimeCapabilityTarget; error?: string } {
  const identity = value.trim();
  if (!identity) {
    // A platform alone changes no device — the Gateway refuses exactly this,
    // after the request has crossed the wire. Saying so here means the operator
    // finds out while the field is still in front of them.
    if (platform) {
      return {
        error: `Platform '${platform}' selects which provider a device belongs to; choose a device too`,
      };
    }
    return {};
  }
  if (!isRuntimeCapabilityTargetKey(key)) {
    return { error: `'${key}' is not a device identity parameter` };
  }
  if (!isRuntimeCapabilityTargetValue(identity)) {
    return {
      error: `Device identity must match ${RUNTIME_CAPABILITY_TARGET_VALUE_PATTERN.source}`,
    };
  }
  return { target: { [key]: identity, ...(platform ? { platform } : {}) } };
}

export interface DeviceTargetChoice {
  identity: string;
  /** What the option reads as: the identity, its device, its state, its slot. */
  label: string;
}

/**
 * The inventory entries an operator can pick for one identity key.
 *
 * Deduplicated by identity and sorted by identity, so the list is stable
 * between polls — a picker that reorders under the cursor is worse than a text
 * field. Returns empty when the machine reported nothing for this key, which is
 * the caller's signal to fall back to free text.
 */
export function deviceTargetChoices(
  devices: readonly DeviceInventoryEntry[],
  key: string,
): DeviceTargetChoice[] {
  const seen = new Set<string>();
  return devices
    .filter((device) => device.key === (key as DeviceInventoryKey))
    .filter((device) => (seen.has(device.identity) ? false : seen.add(device.identity)))
    .sort((a, b) => a.identity.localeCompare(b.identity))
    .map((device) => ({
      identity: device.identity,
      label: [
        device.identity,
        device.name !== device.identity ? `(${device.name})` : '',
        `· ${device.state}`,
        device.configuredForSlots?.length ? `· ${device.configuredForSlots.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    }));
}
