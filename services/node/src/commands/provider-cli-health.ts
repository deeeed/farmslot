import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

import type { ProviderCliHealth } from '@farmslot/protocol';
import { inspectProviderCli, poolProviderRoots } from '@farmslot/slot-config';

import { resolveExecPoolDir } from './exec.js';

let cached: { source: string; at: number; health: ProviderCliHealth[] } | undefined;
let inFlight: Promise<ProviderCliHealth[]> | undefined;

export async function collectProviderCliHealth(): Promise<ProviderCliHealth[]> {
  if (inFlight) return inFlight;
  inFlight = sample().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function sample(): Promise<ProviderCliHealth[]> {
  const machine = process.env.MACHINE_NAME ?? hostname().replace(/\.local$/, '');
  const file = path.join(resolveExecPoolDir(), `${machine}.json`);
  try {
    const source = await readFile(file, 'utf8');
    if (cached?.source === source && Date.now() - cached.at < 60_000) return cached.health;
    const roots = await poolProviderRoots(file);
    const health: ProviderCliHealth[] = [];
    for (const root of roots) health.push(await inspectProviderCli(root));
    cached = { source, at: Date.now(), health };
    return health;
  } catch (error) {
    return [
      {
        root: file,
        packageName: 'pinned-provider',
        expectedVersion: 'unknown',
        ok: false,
        checkedAt: new Date().toISOString(),
        binaries: [],
        reason: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}
