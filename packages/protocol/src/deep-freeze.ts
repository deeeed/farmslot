/**
 * Freezes a value and everything it holds. Shared caches return frozen values so that a caller
 * mutating one throws instead of silently changing what every other caller reads.
 */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
