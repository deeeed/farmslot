// Explicit roots select the owning gateway's store. No gateway connection,
// slot access or credential loading: the shared store lock fences capture during the copy.
import { pathToFileURL } from 'node:url';

import { migrateRunBundleStore } from '@farmslot/run-bundle';

import { assertHeavyWriteRoom, assertHeavyWriteRootPresent } from '../src/core/heavy-write-room.js';

export async function runBundleMigrationCommand(
  args: readonly string[],
  print: (line: string) => void = console.log,
): Promise<void> {
  if (
    args.length !== 6 ||
    args[0] !== '--home' ||
    !args[1] ||
    args[2] !== '--runs-dir' ||
    !args[3] ||
    args[4] !== '--target' ||
    !args[5]
  )
    throw new Error(
      'Usage: tsx --tsconfig services/gateway/tsconfig.json services/gateway/scripts/run-bundle-migrate.ts --home <home> --runs-dir <runs-dir> --target <absolute-root>',
    );

  const result = await migrateRunBundleStore({
    home: args[1],
    runsDir: args[3],
    targetRoot: args[5],
    assertWriteRoom: async (root, bytes) => {
      await assertHeavyWriteRootPresent(root, 'migration target');
      await assertHeavyWriteRoom(root, process.env, bytes);
    },
  });
  print(`Verified bundles: ${result.verifiedBundles}`);
  print(`Run bundle store: ${result.store.root}`);
  print(`Retained backup (not deleted): ${result.backupRoot}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runBundleMigrationCommand(process.argv.slice(2));
