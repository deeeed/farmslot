/**
 * A copy of a store's committed state for an internal reader. Select before cloning so readers
 * don't copy unrelated store history; a whole-store copy parses the committed JSON text, which
 * is several times faster than structuredClone on a large store.
 */
export function cloneStoreSnapshot<Data>(data: Data, text: string): Data;
export function cloneStoreSnapshot<Data, Result>(
  data: Data,
  text: string,
  select: (data: Readonly<Data>) => Result,
): Result;
export function cloneStoreSnapshot<Data, Result>(
  data: Data,
  text: string,
  select?: (data: Readonly<Data>) => Result,
): Data | Result;
export function cloneStoreSnapshot<Data, Result>(
  data: Data,
  text: string,
  select?: (data: Readonly<Data>) => Result,
): Data | Result {
  return select ? structuredClone(select(data)) : JSON.parse(text);
}
