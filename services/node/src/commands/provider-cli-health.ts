import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ProviderCliHealth } from '@farmslot/protocol';
import { isIgnoredPoolFile } from '@farmslot/protocol/node/slot-by-repo';
import { inspectProviderCli, poolProviderRoots } from '@farmslot/slot-config/provider-cli';

import { resolveExecPoolDir } from './exec.js';

let cached:
  | { machine: string; source: string; at: number; health: ProviderCliHealth[] }
  | undefined;
let inFlight: Promise<ProviderCliHealth[]> | undefined;

// Metrics never wait for shell startup; a single background sample supplies the next event.
export function getProviderCliHealth(machine: string): ProviderCliHealth[] | undefined {
  void collectProviderCliHealth(machine);
  return cached?.machine === machine ? cached.health : undefined;
}

export async function collectProviderCliHealth(
  machine: string,
  probe = inspectProviderCli,
): Promise<ProviderCliHealth[]> {
  if (inFlight) return inFlight;
  inFlight = sample(machine, probe).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

function retryReady(health: ProviderCliHealth): boolean {
  return (
    health.status === 'probe-timeout' &&
    !health.retryAttempted &&
    os.loadavg()[0] < Math.max(os.availableParallelism(), (health.loadAvg1 ?? 0) / 2)
  );
}

async function sample(
  machine: string,
  probe: typeof inspectProviderCli,
): Promise<ProviderCliHealth[]> {
  let directory = '';
  try {
    directory = resolveExecPoolDir();
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      files = []; // A fresh node has no pool until a project is added.
    }
    let selected: { file: string; source: string } | undefined;
    for (const name of files.sort().filter((name) => !isIgnoredPoolFile(name))) {
      const file = path.join(directory, name);
      const source = await readFile(file, 'utf8');
      let pool: unknown;
      try {
        pool = JSON.parse(source);
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`Invalid pool JSON: ${file}`);
        throw error;
      }
      if (pool && typeof pool === 'object' && 'machine' in pool && pool.machine === machine) {
        selected = { file, source };
        break;
      }
    }
    const source = selected?.source ?? '';
    const previous = cached?.machine === machine && cached.source === source ? cached : undefined;
    if (previous && Date.now() - previous.at < 60_000 && !previous.health.some(retryReady))
      return previous.health;
    const health: ProviderCliHealth[] = [];
    if (selected) {
      const roots = await poolProviderRoots(selected.file);
      for (const root of roots) {
        const prior = previous?.health.find((item) => item.root === root);
        if (prior?.status === 'probe-timeout' && !retryReady(prior)) {
          health.push(prior);
          continue;
        }
        const result = await probe(root);
        if (!result.ok && result.status !== 'version-mismatch' && prior) {
          result.confirmedMismatch =
            prior.status === 'version-mismatch'
              ? { checkedAt: prior.checkedAt, reason: prior.reason ?? 'Measured version mismatch' }
              : prior.confirmedMismatch;
        }
        if (prior?.status === 'probe-timeout') result.retryAttempted = true;
        health.push(result);
      }
    }
    cached = { machine, source, at: Date.now(), health };
    return health;
  } catch (error) {
    const health: ProviderCliHealth[] = [
      {
        root: directory,
        packageName: 'pinned-provider',
        expectedVersion: 'unknown',
        ok: false,
        status: 'probe-error',
        checkedAt: new Date().toISOString(),
        binaries: [],
        reason: error instanceof Error ? error.message : String(error),
      },
    ];
    cached = { machine, source: '<failed>', at: Date.now(), health };
    return health;
  }
}
