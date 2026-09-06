/**
 * Device re-targeting for runtime capability providers (ADR-054 item 3).
 *
 * A slot binds one device at config load. These helpers let a validation or a
 * recipe rerun name a different device WITHOUT migrating the run to another
 * slot: the device identity travels as capability acquire parameters, which the
 * provider's own hooks read through `{{simulator}}`, `{{avd}}`, `{{adb_serial}}`
 * and `{{platform}}`.
 *
 * Everything here is pure so the rules — which parameters may reach a shell
 * template, which proof requirement a target rewrites, and when a target would
 * double-boot a device another slot is holding — are testable without a slot,
 * a fleet, or a provider.
 */
import {
  isRuntimeCapabilityTargetValue,
  RUNTIME_CAPABILITY_TARGET_KEYS,
  RUNTIME_CAPABILITY_TARGET_VALUE_PATTERN,
  type RuntimeCapabilityCatalogEntry,
  type RuntimeCapabilityProofRequirement,
  type RuntimeCapabilityTarget,
  type RuntimeCapabilityTargetKey,
} from '@farmslot/protocol';

export type DeviceTargetOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Device identity keys that name an actual device. `platform` selects which
 * provider is meant, not which device, so two slots sharing a platform is not a
 * conflict.
 */
const DEVICE_KEYS = RUNTIME_CAPABILITY_TARGET_KEYS.filter(
  (key): key is Exclude<RuntimeCapabilityTargetKey, 'platform'> => key !== 'platform',
);

/**
 * Which physical thing a key names. `udid` and `simulator` are two spellings of
 * one iOS simulator identity, so a target that says `udid` still conflicts with
 * a slot configured through `simulator`.
 */
const IDENTITY_GROUP: Record<Exclude<RuntimeCapabilityTargetKey, 'platform'>, string> = {
  udid: 'ios-simulator',
  simulator: 'ios-simulator',
  avd: 'android-avd',
  adb_serial: 'android-serial',
};

/**
 * Acquire parameters, reduced to the hook template variables they stand for.
 *
 * This is the ONLY conversion from request data to shell template input, so it
 * is where the charset is enforced. A value that could carry shell meaning is
 * refused outright rather than escaped: the templates are project-authored and
 * we cannot know how each one quotes its placeholder.
 *
 * Parameters outside the device allowlist are deliberately left alone. They stay
 * data on the lease for the provider's own actions and never become a template
 * variable.
 */
export function deviceTargetExtraVars(
  parameters: Record<string, unknown> | undefined,
): DeviceTargetOutcome<Record<string, string> | undefined> {
  if (!parameters) return { ok: true, value: undefined };
  const extraVars: Record<string, string> = {};
  for (const key of RUNTIME_CAPABILITY_TARGET_KEYS) {
    const value = parameters[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !RUNTIME_CAPABILITY_TARGET_VALUE_PATTERN.test(value)) {
      return {
        ok: false,
        reason:
          `Device parameter '${key}' must be a string matching ` +
          `${RUNTIME_CAPABILITY_TARGET_VALUE_PATTERN.source}; it is substituted into a project ` +
          `hook command and is refused rather than escaped`,
      };
    }
    extraVars[key] = value;
  }
  // A simulator IS its udid. Projects template `{{simulator}}`, so a target that
  // named only `udid` would otherwise expand to the slot's configured device and
  // silently boot the wrong one.
  if (extraVars.udid !== undefined && extraVars.simulator === undefined) {
    extraVars.simulator = extraVars.udid;
  } else if (
    extraVars.udid !== undefined &&
    extraVars.simulator !== undefined &&
    extraVars.udid !== extraVars.simulator
  ) {
    return {
      ok: false,
      reason: `Device parameters name two different iOS simulators: udid='${extraVars.udid}' and simulator='${extraVars.simulator}'`,
    };
  }
  return { ok: true, value: Object.keys(extraVars).length > 0 ? extraVars : undefined };
}

/** Device identities a record names, grouped so `udid` and `simulator` compare equal. */
function identityGroups(record: Record<string, unknown>): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  for (const key of DEVICE_KEYS) {
    const value = record[key];
    if (!isRuntimeCapabilityTargetValue(value)) continue;
    const group = IDENTITY_GROUP[key];
    const bucket = groups.get(group) ?? new Set<string>();
    bucket.add(value);
    groups.set(group, bucket);
  }
  return groups;
}

/** One slot, elsewhere on the fleet, that currently holds a capability lease. */
export interface DeviceHolder {
  slotId: string;
  capabilityId: string;
  runId: string;
  /**
   * Device identities that slot is using: its configured slot resources, and
   * the acquire parameters of the lease it holds when that lease was itself
   * re-targeted.
   */
  identities: Array<Record<string, unknown>>;
}

/**
 * Refuse a target that names a device another slot's live lease is already
 * using. Leases are slot-scoped today, so nothing else stops two slots booting
 * the same simulator; fleet-scoped arbitration with a wait queue is the separate
 * `fleet-scoped-device-claims` item.
 *
 * Returns the refusal reason, or null when the target is free.
 */
export function crossSlotTargetConflict(
  target: Record<string, unknown>,
  holders: readonly DeviceHolder[],
): string | null {
  const wanted = identityGroups(target);
  if (wanted.size === 0) return null;
  for (const holder of holders) {
    for (const identity of holder.identities) {
      for (const [group, values] of identityGroups(identity)) {
        const clash = [...(wanted.get(group) ?? [])].find((value) => values.has(value));
        if (clash) {
          return (
            `Device '${clash}' is the ${group} of slot '${holder.slotId}', which holds an active ` +
            `'${holder.capabilityId}' lease for run '${holder.runId}'. Capability leases are ` +
            `slot-scoped, so re-targeting onto it would boot the same device twice`
          );
        }
      }
    }
  }
  return null;
}

/** Whether a provider schema says this platform is one it serves. */
function schemaAllowsPlatform(
  entry: RuntimeCapabilityCatalogEntry | undefined,
  platform: string,
): boolean | undefined {
  const properties = (entry?.parameters as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  const schema = properties?.platform;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const record = schema as { const?: unknown; enum?: unknown };
  if (typeof record.const === 'string') return record.const === platform;
  if (Array.isArray(record.enum)) return record.enum.includes(platform);
  return undefined;
}

/** Whether a provider declares any of the device parameters this target names. */
function declaresTargetedParameters(
  entry: RuntimeCapabilityCatalogEntry | undefined,
  target: Record<string, unknown>,
): boolean {
  const properties = (entry?.parameters as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  if (!properties) return false;
  return RUNTIME_CAPABILITY_TARGET_KEYS.some(
    (key) => target[key] !== undefined && key in properties,
  );
}

/**
 * Rewrite the one device requirement in a stored proof plan so a rerun acquires
 * the named device instead of the slot's configured one.
 *
 * Fails closed rather than guessing: no candidate, or more than one after the
 * platform narrows the field, is a refusal. Silently re-targeting the wrong
 * capability would boot a device nobody asked for.
 */
export function retargetProofRequirements(
  requirements: readonly RuntimeCapabilityProofRequirement[],
  catalog: readonly RuntimeCapabilityCatalogEntry[],
  target: RuntimeCapabilityTarget,
): DeviceTargetOutcome<RuntimeCapabilityProofRequirement[]> {
  const validated = deviceTargetExtraVars(target);
  if (!validated.ok) return validated;
  if (!validated.value) {
    return { ok: false, reason: 'target names no device parameter' };
  }
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  let candidates = requirements.filter((requirement) =>
    declaresTargetedParameters(byId.get(requirement.capabilityId), target),
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `no capability in this run's proof plan (${
        requirements.map((requirement) => requirement.capabilityId).join(', ') || 'empty'
      }) declares the device parameters this target names`,
    };
  }
  if (target.platform) {
    const platform = target.platform;
    const allowed = candidates.filter(
      (requirement) => schemaAllowsPlatform(byId.get(requirement.capabilityId), platform) === true,
    );
    const undecided = candidates.filter(
      (requirement) =>
        schemaAllowsPlatform(byId.get(requirement.capabilityId), platform) === undefined,
    );
    candidates = allowed.length > 0 ? allowed : undecided;
    if (candidates.length === 0) {
      return {
        ok: false,
        reason: `no capability in this run's proof plan serves platform '${platform}'`,
      };
    }
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: `target is ambiguous: ${candidates
        .map((requirement) => requirement.capabilityId)
        .join(', ')} all accept it. Name a platform to choose one`,
    };
  }
  const chosen = candidates[0]!;
  return {
    ok: true,
    value: requirements.map((requirement) =>
      requirement === chosen
        ? { ...requirement, parameters: { ...requirement.parameters, ...target } }
        : requirement,
    ),
  };
}
