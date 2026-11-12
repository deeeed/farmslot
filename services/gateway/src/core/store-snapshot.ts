/**
 * Freezes a store's committed state in place, so internal readers can share it instead of copying
 * it on every read (copy on write: a reader that needs a changed value copies what it changes).
 * A reader that writes to the shared state throws, in strict mode, at the write.
 */
export function freezeStoreState<Data>(data: Data): Data {
  const pending: unknown[] = [data];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) continue;
    Object.freeze(value);
    for (const child of Object.values(value)) pending.push(child);
  }
  return data;
}
