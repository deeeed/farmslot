// Shared test utilities for adapter-rn tests.
import assert from 'node:assert/strict';

/** Poll predicate until it passes without throwing, or timeoutMs elapses. */
export async function waitFor(
  predicate: () => void | Promise<void>,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await predicate();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError ?? new Error('waitFor timed out');
}

/**
 * Deep partial match — like toMatchObject: verifies every key/value in
 * `expected` is present and equal in `actual`; extra keys are allowed.
 */
export function matchesObject(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') {
    return Object.is(actual, expected);
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((e, i) => matchesObject((actual as unknown[])[i], e));
  }
  if (actual === null || typeof actual !== 'object') return false;
  const rec = actual as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
    if (!matchesObject(rec[k], v)) return false;
  }
  return true;
}

export function assertMatchesObject(actual: unknown, expected: unknown, message?: string): void {
  assert.ok(
    matchesObject(actual, expected),
    message ?? `Expected ${JSON.stringify(actual)} to match ${JSON.stringify(expected)}`,
  );
}
