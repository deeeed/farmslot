import { existsSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedTestPaths = new Set<string>();

function removeIsolatedTestPaths(): void {
  const byDir = new Map<string, string[]>();
  for (const isolated of isolatedTestPaths) {
    rmSync(isolated, { recursive: true, force: true });
    const dir = path.dirname(isolated);
    byDir.set(dir, [...(byDir.get(dir) ?? []), `${path.basename(isolated)}.`]);
  }
  // Sidecars written next to a test-mode file (`<file>.provenance-v1`): one
  // listing per directory, which may already be gone.
  for (const [dir, prefixes] of byDir) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (prefixes.some((prefix) => entry.startsWith(prefix))) {
        rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
    }
  }
}

/**
 * A per-process path under os.tmpdir() for a test process's gateway state
 * (runs, analytics, queues, stores), removed with its sidecars when that
 * process exits so test runs do not pile up in TMPDIR.
 */
export function isolatedTestPath(name: string, suffix = ''): string {
  const isolated = path.join(os.tmpdir(), `${name}-${process.pid}${suffix}`);
  if (isolatedTestPaths.size === 0) process.once('exit', removeIsolatedTestPaths);
  isolatedTestPaths.add(isolated);
  return isolated;
}
