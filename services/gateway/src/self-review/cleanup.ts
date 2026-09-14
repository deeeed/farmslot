/** Attempt every cleanup and retain the original review failure alongside later failures. */
export async function finishReviewCleanup(
  primaryFailure: unknown,
  actions: ReadonlyArray<() => unknown | Promise<unknown>>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (!failures.length) return;
  const errors = primaryFailure === undefined ? failures : [primaryFailure, ...failures];
  throw new AggregateError(
    errors,
    errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; '),
    { cause: primaryFailure === undefined ? failures[0] : primaryFailure },
  );
}
