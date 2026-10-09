/**
 * Blocked runs whose archive is releasing their slot in THIS process. Anything
 * that would put a worker back on the run (step replay, resume, adoption,
 * worker restore) refuses a fenced run, so it cannot reclaim the slot under the
 * same run id while the release tears it down.
 *
 * In memory like the terminal-teardown registry: a restart ends the archive,
 * and a durable marker would fence the run forever. A release a restart cut
 * short is reclaimed by the orphan reconciler instead.
 */
const archiving = new Set<string>();

const ARCHIVING_REFUSAL = 'is being archived and its slot released';

export function beginRunArchive(runId: string): void {
  archiving.add(runId);
}

export function endRunArchive(runId: string): void {
  archiving.delete(runId);
}

export function isRunArchiving(runId: string): boolean {
  return archiving.has(runId);
}

/** The one admission check for every path that would put a worker back on a run. */
export function assertRunNotArchiving(runId: string): void {
  if (archiving.has(runId)) throw new Error(`Run ${runId} ${ARCHIVING_REFUSAL}`);
}

export function isRunArchivingRefusal(err: unknown): boolean {
  return err instanceof Error && err.message.includes(ARCHIVING_REFUSAL);
}
