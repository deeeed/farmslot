import type { RunGetParams, RunGetResult } from '@farmslot/protocol';

/** Show stored facts while the authoritative read checks live gate prerequisites. */
export async function readRunProgressively(
  runId: string,
  request: (params: RunGetParams) => Promise<RunGetResult>,
  showSnapshot: (result: RunGetResult) => void,
): Promise<RunGetResult> {
  let currentSucceeded = false;
  const snapshot = request({ runId, view: 'snapshot' }).then(
    (result) => {
      if (!currentSucceeded) showSnapshot(result);
      return { error: null };
    },
    // A failed optional snapshot falls back to the ordinary read. If both fail,
    // preserve both errors instead of reporting a successful display read.
    (error: unknown) => ({ error }),
  );
  try {
    const result = await request({ runId });
    currentSucceeded = true;
    return result;
  } catch (error) {
    const stored = await snapshot;
    if (stored.error)
      throw new AggregateError(
        [error, stored.error],
        error instanceof Error ? error.message : String(error),
      );
    throw error;
  }
}
