/**
 * Capability acquire-parameter identity.
 *
 * One rule, in one place, deliberately: the registry decides whether a held
 * lease already has the requested parameters, and the ADR-054 posture reconciler
 * decides whether a re-target has to release that lease first. If those two
 * answered differently, a device re-target would either loop forever or silently
 * run against the old device.
 */

/** Key-order-independent JSON, so `{a,b}` and `{b,a}` are one value. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sameCapabilityParameters(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return stableJson(a) === stableJson(b);
}
