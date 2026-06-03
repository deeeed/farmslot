import { isDeepStrictEqual } from 'node:util';

import { isRecord } from './json.js';

export function evaluateNodeGate(
  node: Record<string, unknown>,
  outputs: ReadonlyMap<string, unknown>,
): { run: boolean; reason?: string } {
  const root = Object.fromEntries(outputs);
  if (node.when != null && !evaluatePredicate(root, node.when)) {
    return { run: false, reason: 'when predicate was false' };
  }
  if (node.unless != null && evaluatePredicate(root, node.unless)) {
    return { run: false, reason: 'unless predicate was true' };
  }
  return { run: true };
}

export function evaluatePredicate(root: unknown, predicate: unknown): boolean {
  if (!isRecord(predicate)) throw new Error('Predicate must be an assertion object.');
  if (Array.isArray(predicate.all))
    return predicate.all.every((entry) => evaluatePredicate(root, entry));
  if (Array.isArray(predicate.any))
    return predicate.any.some((entry) => evaluatePredicate(root, entry));
  if (Array.isArray(predicate.none))
    return !predicate.none.some((entry) => evaluatePredicate(root, entry));

  const pathValue = typeof predicate.path === 'string' ? predicate.path : '$';
  const actual = pathValue === '$' ? root : getPathValue(root, pathValue.replace(/^\$\./, ''));
  const operator = typeof predicate.operator === 'string' ? predicate.operator : 'truthy';
  const expected = predicate.value;
  switch (operator) {
    case 'exists':
      return actual !== undefined;
    case 'not_null':
      return actual != null;
    case 'truthy':
      return Boolean(actual);
    case 'falsy':
      return !actual;
    case 'eq':
      return actual === expected;
    case 'ne':
    case 'neq':
      return actual !== expected;
    case 'deep_eq':
      return isDeepStrictEqual(actual, expected);
    case 'contains':
      return containsValue(actual, expected);
    case 'not_contains':
      return !containsValue(actual, expected);
    case 'matches':
      return typeof expected === 'string' && new RegExp(expected).test(String(actual ?? ''));
    case 'one_of':
      return Array.isArray(expected) && expected.some((entry) => isDeepStrictEqual(entry, actual));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compareNumbers(actual, expected, operator);
    case 'length_eq':
    case 'length_gt':
    case 'length_gte':
    case 'length_lt':
    case 'length_lte':
      return compareNumbers(lengthOf(actual), expected, operator.replace('length_', ''));
    default:
      throw new Error(`Unsupported predicate operator ${operator}.`);
  }
}

export function getPathValue(root: unknown, dottedPath: string): unknown {
  return dottedPath
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (!isRecord(current) && !Array.isArray(current)) return undefined;
      if (Array.isArray(current)) return current[Number(segment)];
      return current[segment];
    }, root);
}

function containsValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string') return actual.includes(String(expected));
  if (Array.isArray(actual)) return actual.some((entry) => isDeepStrictEqual(entry, expected));
  return false;
}

function lengthOf(actual: unknown): number {
  if (typeof actual === 'string' || Array.isArray(actual)) return actual.length;
  if (isRecord(actual)) return Object.keys(actual).length;
  return Number.NaN;
}

function compareNumbers(actual: unknown, expected: unknown, operator: string): boolean {
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  if (operator === 'gt') return actual > expected;
  if (operator === 'gte') return actual >= expected;
  if (operator === 'lt') return actual < expected;
  return actual <= expected;
}
