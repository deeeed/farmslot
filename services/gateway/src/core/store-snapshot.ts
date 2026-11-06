/** Select before cloning so internal readers don't copy unrelated store history. */
export function cloneStoreSnapshot<Data>(data: Data): Data;
export function cloneStoreSnapshot<Data, Result>(
  data: Data,
  select: (data: Readonly<Data>) => Result,
): Result;
export function cloneStoreSnapshot<Data, Result>(
  data: Data,
  select?: (data: Readonly<Data>) => Result,
): Data | Result;
export function cloneStoreSnapshot<Data, Result>(
  data: Data,
  select?: (data: Readonly<Data>) => Result,
): Data | Result {
  return structuredClone(select ? select(data) : data);
}
