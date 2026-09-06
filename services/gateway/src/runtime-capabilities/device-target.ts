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
  /**
   * The parameter names the provider's own schema declares. Supplied at the
   * action layer, where the provider is known; omitted by the pure callers that
   * are only validating a target's shape. The device allowlist is global, so
   * without this a provider that names a parameter `platform` or `simulator`
   * for its own purposes would have it substituted into its hook command — and
   * `platform` is auto-injected from the slot, so it would be shadowed.
   */
  declaredParameters?: readonly string[],
): DeviceTargetOutcome<Record<string, string> | undefined> {
  if (!parameters) return { ok: true, value: undefined };
  const declared = declaredParameters ? new Set(declaredParameters) : undefined;
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
    // Validated whatever the provider declares — a value that could carry shell
    // meaning is refused even when it will not be substituted, because the
    // refusal is what tells the operator the identity is wrong.
    if (declared && !declared.has(key)) continue;
    extraVars[key] = value;
  }
  // The contradiction check reads the REQUEST, not the substitution set: a
  // provider that declares only `simulator` still must not be handed a `udid`
  // naming a different device.
  const udid = parameters.udid;
  const simulator = parameters.simulator;
  if (typeof udid === 'string' && typeof simulator === 'string' && udid !== simulator) {
    return {
      ok: false,
      reason: `Device parameters name two different iOS simulators: udid='${udid}' and simulator='${simulator}'`,
    };
  }
  // A simulator IS its udid. Projects template `{{simulator}}`, so a target that
  // named only `udid` would otherwise expand to the slot's configured device and
  // silently boot the wrong one. Only when the provider declares `simulator`.
  if (
    extraVars.udid !== undefined &&
    extraVars.simulator === undefined &&
    (!declared || declared.has('simulator'))
  ) {
    extraVars.simulator = extraVars.udid;
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

/**
 * Whether a provider's declared cost claims a DEVICE.
 *
 * Only such a lease makes its slot's configured device off-limits. Treating any
 * lease as a holder made a slot running only a browser or Metro block its own
 * simulator, and reported that unrelated capability as the reason.
 */
export function claimsDevice(entry: Pick<RuntimeCapabilityCatalogEntry, 'cost'>): boolean {
  return entry.cost.resources.some((claim) => claim.kind === 'device');
}

/**
 * The device-identity keys of a record, or undefined when it names no device.
 * `platform` is dropped: it selects a provider, not a device, so a parameter set
 * carrying only `platform` can never conflict with anything.
 */
export function deviceIdentityOnly(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const identity: Record<string, unknown> = {};
  for (const key of DEVICE_KEYS) {
    if (isRuntimeCapabilityTargetValue(record[key])) identity[key] = record[key];
  }
  return Object.keys(identity).length > 0 ? identity : undefined;
}

/**
 * A slot's configured identity, with the lease's own identity taking over any
 * group the lease actually names.
 *
 * A slot whose lease was re-targeted away from its configured simulator is not
 * using that simulator, so counting the slot field as in-use would refuse a
 * legal target. Groups the lease says nothing about keep the slot's value,
 * because that is still what a future acquire there would resolve to.
 */
export function displaceIdentity(
  configured: Record<string, unknown>,
  leaseParameters: Record<string, unknown>,
): Record<string, unknown> {
  const leaseGroups = new Set(identityGroups(leaseParameters).keys());
  const merged: Record<string, unknown> = {};
  for (const key of DEVICE_KEYS) {
    if (leaseGroups.has(IDENTITY_GROUP[key])) continue;
    if (isRuntimeCapabilityTargetValue(configured[key])) merged[key] = configured[key];
  }
  for (const key of DEVICE_KEYS) {
    if (isRuntimeCapabilityTargetValue(leaseParameters[key])) merged[key] = leaseParameters[key];
  }
  return merged;
}

/** One slot, elsewhere on the fleet, that currently holds a capability lease. */
export interface DeviceHolder {
  slotId: string;
  /**
   * The machine the slot runs on. A device name identifies a device on its own
   * machine only, and the pool deliberately reuses names across machines, so a
   * caller must not offer holders from another machine.
   */
  machine: string;
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
  /**
   * The machine the acquiring slot runs on. A device name identifies a device on
   * ONE machine, and the pool reuses `fs-1`, `emulator-5554` and avd names
   * across machines, so a holder elsewhere names a physically different device.
   * The scoping lives here rather than at the call site so a caller cannot
   * forget it.
   */
  machine: string,
): string | null {
  const wanted = identityGroups(target);
  if (wanted.size === 0) return null;
  for (const holder of holders) {
    if (holder.machine !== machine) continue;
    for (const identity of holder.identities) {
      for (const [group, values] of identityGroups(identity)) {
        const clash = [...(wanted.get(group) ?? [])].find((value) => values.has(value));
        if (clash) {
          return (
            `Device '${clash}' is the ${group} of slot '${holder.slotId}' on ${holder.machine}, ` +
            `which holds an active '${holder.capabilityId}' lease for run '${holder.runId}'. ` +
            `Capability leases are slot-scoped, so re-targeting onto it would boot the same ` +
            `device twice`
          );
        }
      }
    }
  }
  return null;
}

/**
 * Split capability ids into dependency-connected groups. Edges are the catalog's
 * own `dependencies`, followed in both directions and only between ids in the
 * set, so `ios-simulator` and the client that depends on it land together while
 * an unrelated device provider forms its own group.
 */
function dependencyGroups(
  ids: readonly string[],
  byId: ReadonlyMap<string, RuntimeCapabilityCatalogEntry>,
): Array<Set<string>> {
  const members = new Set(ids);
  const neighbours = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  const link = (a: string, b: string) => {
    neighbours.get(a)?.add(b);
    neighbours.get(b)?.add(a);
  };
  // Transitive: a dependency outside the set still connects two ids inside it.
  const reaches = (from: string, seen = new Set<string>()): Set<string> => {
    for (const dependency of byId.get(from)?.dependencies ?? []) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      reaches(dependency, seen);
    }
    return seen;
  };
  for (const id of ids) {
    for (const reachable of reaches(id)) {
      if (members.has(reachable)) link(id, reachable);
    }
  }
  const groups: Array<Set<string>> = [];
  const placed = new Set<string>();
  for (const id of ids) {
    if (placed.has(id)) continue;
    const group = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (group.has(current)) continue;
      group.add(current);
      placed.add(current);
      for (const neighbour of neighbours.get(current) ?? []) queue.push(neighbour);
    }
    groups.push(group);
  }
  return groups;
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
  // Declaring the parameter is what makes the identity reach a provider's hooks;
  // claiming a device is what makes it DRIVE the device. Both are required. A
  // provider that merely takes a simulator name — a report, a lint step — is not
  // part of the physical device this target names and is left alone.
  let candidates = requirements.filter((requirement) => {
    const entry = byId.get(requirement.capabilityId);
    return Boolean(entry) && declaresTargetedParameters(entry, target) && claimsDevice(entry!);
  });
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
  // THE INVARIANT, stated rather than left incidental: every rewritten
  // requirement drives the SAME physical device. Two capabilities do that only
  // when one transitively depends on the other — on farmslot-farm the simulator
  // and the dev client installed onto it. So the rewrite set is one
  // dependency-connected group; re-targeting only part of it would leave the
  // rest running against the device the run just left, and re-targeting two
  // unconnected groups would move two devices for one target.
  const groups = dependencyGroups(
    candidates.map((requirement) => requirement.capabilityId),
    byId,
  );
  if (groups.length > 1) {
    return {
      ok: false,
      reason: `target is ambiguous: ${groups
        .map((group) => [...group].sort().join('+'))
        .join(' and ')} are unconnected device groups, so one target cannot mean both`,
    };
  }
  const chosenIds = groups[0]!;
  // `platform` selects WHICH provider the target meant; it is not a device, so
  // it is never stored. Storing it would make a target that merely restates the
  // platform of the provider already holding the device differ from the held
  // lease, and the posture would release and reboot that same device for
  // nothing.
  const { platform: _selector, ...deviceKeys } = target;
  // A platform-only target changes no device. Returning ok with the plan
  // untouched gave the caller a rerun and no signal that the target did
  // nothing — the same refusal the whole-target check above gives applies here.
  if (Object.keys(deviceKeys).length === 0) {
    return { ok: false, reason: 'target names only a platform, no device parameter' };
  }
  // REPLACE the stored device identity, never union with it. The plan carries
  // the last re-target, so `{udid: A}` followed by `{simulator: B}` would
  // otherwise merge into a requirement naming two different simulators — one of
  // which the operator never sent — and the contradiction would surface only at
  // acquire, after the posture had already released the device. Because every
  // device key is cleared here and `deviceKeys` was validated as a whole above,
  // the merged result cannot contradict itself.
  const rewrite = (requirement: RuntimeCapabilityProofRequirement) => {
    const kept: Record<string, unknown> = { ...requirement.parameters };
    // Only the DEVICE identity is replaced. A stored `platform` is not part of
    // that identity, and a provider that declares it may need it in its hooks,
    // so dropping it would silently change what the provider is told.
    for (const key of DEVICE_KEYS) delete kept[key];
    return { ...requirement, parameters: { ...kept, ...deviceKeys } };
  };
  return {
    ok: true,
    value: requirements.map((requirement) =>
      chosenIds.has(requirement.capabilityId) ? rewrite(requirement) : requirement,
    ),
  };
}
