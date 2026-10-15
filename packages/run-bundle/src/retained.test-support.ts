import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Run, RunBundleEntryMeta } from '@farmslot/protocol';

import { registerDirectoryEntries } from './copy-tree.js';
import { sha256Text } from './hashing.js';
import { materializeRunBundle, openRunBundleStore, type RunBundleStore } from './retained.js';

export function fixtureBundleStore(root: string) {
  return openRunBundleStore({
    runsDir: path.join(root, '.runs'),
    home: path.join(root, 'bundle-home'),
    create: true,
  });
}

/** Existing archive fixtures retain their declared task tree before exercising export. */
export async function retainFixtureTask(
  root: string,
  run: Run,
  targetStore?: RunBundleStore,
): Promise<void> {
  if (!run.taskFile) return;
  const taskDir = path.dirname(run.taskFile);
  const prefix = path.relative(root, taskDir).replaceAll('\\', '/');
  const entries: Record<string, RunBundleEntryMeta> = {};
  registerDirectoryEntries(root, prefix, entries);
  const artifacts = Object.entries(entries).map(([key, entry]) => ({
    path: key.slice(prefix ? prefix.length + 1 : 0),
    purpose: 'fixture',
    sha256: entry.sha256,
    sizeBytes: entry.bytes,
  }));
  const store = targetStore ?? (await fixtureBundleStore(root));
  await materializeRunBundle({
    store,
    farmslotRoot: root,
    run,
    taskDir,
    artifacts,
    manifestDigest: sha256Text(JSON.stringify(artifacts)),
    captureKey: sha256Text(JSON.stringify(artifacts)),
    commit: async (ref) => {
      run.artifactBundle = ref;
      mkdirSync(store.runsDir, { recursive: true });
      writeFileSync(path.join(store.runsDir, `${run.id}.json`), JSON.stringify(run));
    },
  });
}
