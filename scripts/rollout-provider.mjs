#!/usr/bin/env node
// Install every declared provider globally, then verify each shell's complete PATH.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { installProviderCli, poolProviderRoots } from '../packages/slot-config/src/provider-cli.ts';

export async function rolloutProvider(poolFile, prefix) {
  const roots = await poolProviderRoots(poolFile);
  const results = [];
  for (const root of roots) results.push(await installProviderCli(root, prefix));
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const pool = process.argv.indexOf('--pool');
  const prefix = process.argv.indexOf('--prefix');
  if (pool < 0 || !process.argv[pool + 1])
    throw new Error(
      'Usage: node --import tsx scripts/rollout-provider.mjs --pool <pool.json> [--prefix <npm-prefix>]',
    );
  console.log(
    JSON.stringify(
      await rolloutProvider(
        process.argv[pool + 1],
        prefix < 0 ? undefined : process.argv[prefix + 1],
      ),
      null,
      2,
    ),
  );
}
