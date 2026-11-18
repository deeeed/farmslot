// Field checks shared by the required-skill and review-rule-pack decoders, so a
// skill name, a skill-relative path and an object shape mean the same in both.
// Internal: not exported from the contracts index.

/** An installed skill directory, rule id, pack id or client name. */
export const SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** A relative path with no absolute root, backslash, empty, `.` or `..` segment. */
export function isRelativeSafePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\'))
    return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

export function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) throw new Error(`${field} has unsupported properties: ${extra.join(', ')}`);
}
