import { rm } from 'node:fs/promises';

export async function removeStaleArtifactDirectory(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    // A concurrent artifact refresh can remove the stale directory before this
    // cleanup runs; ENOENT means the desired no-debug-spool state is already
    // true. Other filesystem failures still abort the evidence copy.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}
