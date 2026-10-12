import { asOptionalString, asString, getJsonPathParts, isRecord } from './json.js';

export interface ParsedAssertion {
  path: string;
  operator: string;
  value: unknown;
}

export type AssertionNode =
  | ParsedAssertion
  | { all: AssertionNode[] }
  | { any: AssertionNode[] }
  | { none: AssertionNode[] };

function parseAssertion(value: unknown, label: string): ParsedAssertion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  return {
    path: asOptionalString(record.path, `${label}.path`) ?? '$',
    operator: asString(record.operator, `${label}.operator`),
    value: record.value,
  };
}

export function parseAssertionNode(value: unknown, label: string): AssertionNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const group = assertionGroup(record);
  if (group) {
    const { key, entries } = group;
    if (!Array.isArray(entries)) throw new Error(`${label}.${key} must be an array.`);
    const assertions = entries.map((entry, index) =>
      parseAssertionNode(entry, `${label}.${key}[${index}]`),
    );
    if (key === 'all') return { all: assertions };
    if (key === 'any') return { any: assertions };
    return { none: assertions };
  }
  return parseAssertion(value, label);
}

/** Check known paths before execution; output-dependent values stay deferred. */
export function validateAssertionPaths(value: unknown, label: string): void {
  if (!isRecord(value)) return;
  const group = assertionGroup(value);
  if (group) {
    if (Array.isArray(group.entries)) {
      group.entries.forEach((entry, index) =>
        validateAssertionPaths(entry, `${label}.${group.key}[${index}]`),
      );
    }
    return;
  }
  if (typeof value.path !== 'string' || value.path.includes('{{outputs.')) return;
  try {
    getJsonPathParts(value.path);
  } catch (error) {
    throw new Error(`${label}.path: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertionGroup(
  record: Record<string, unknown>,
): { key: 'all' | 'any' | 'none'; entries: unknown } | undefined {
  for (const key of ['all', 'any', 'none'] as const) {
    if (record[key] != null) return { key, entries: record[key] };
  }
  return undefined;
}
