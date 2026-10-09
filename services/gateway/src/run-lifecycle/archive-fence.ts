/**
 * Blocked runs whose archive is releasing their slot in THIS process. Replay
 * (operator Resume, automatic resume, step replay) refuses a fenced run, so it
 * cannot reclaim the slot under the same run id while the release tears it down.
 *
 * In memory like the terminal-teardown registry: a restart ends the archive,
 * and a durable marker would fence the run from replay forever.
 */
const archiving = new Set<string>();

export function beginRunArchive(runId: string): void {
  archiving.add(runId);
}

export function endRunArchive(runId: string): void {
  archiving.delete(runId);
}

export function isRunArchiving(runId: string): boolean {
  return archiving.has(runId);
}
