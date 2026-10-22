import type { Run } from '@farmslot/protocol';

/** A policy refusal can still commit revised findings. Read them back before showing the error. */
export async function refreshReviewGateView(
  refresh: () => Promise<{ run: Run }>,
  read: () => Promise<{ run: Run }>,
): Promise<{ run: Run | null; error: string | null }> {
  try {
    return { run: (await refresh()).run, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      return { run: (await read()).run, error: message };
    } catch (readError) {
      return {
        run: null,
        error: `${message}. Current gate unavailable: ${readError instanceof Error ? readError.message : String(readError)}`,
      };
    }
  }
}
