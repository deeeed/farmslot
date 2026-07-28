// onboarding/migrations.ts — versioned pool-config migrations for `farmslot update`.
//
// Steps live in <repo>/migrations/pool/*.mjs, each exporting:
//   export const id = '001-some-step';
//   export const toVersion = 1;
//   export const description = '...';
//   export function migrate(pool) { ...mutate or return a new pool... }
//
// Pool files without schema_version are treated as version 0. Migrations add
// new defaults while preserving user edits — they never regenerate a file.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PoolConfig } from './pool-config.js';
import { repoRoot } from './workspace.js';

export interface MigrationStep {
  id: string;
  toVersion: number;
  description: string;
  repairsInvariant?: boolean;
  migrate: (pool: PoolConfig) => PoolConfig | void;
}

export function poolMigrationsDir(root: string = repoRoot): string {
  return join(root, 'migrations', 'pool');
}

export async function loadMigrations(dir: string = poolMigrationsDir()): Promise<MigrationStep[]> {
  if (!existsSync(dir)) return [];
  const steps: MigrationStep[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.mjs')) continue;
    const mod = (await import(pathToFileURL(join(dir, entry)).href)) as Partial<MigrationStep>;
    if (
      typeof mod.id !== 'string' ||
      typeof mod.toVersion !== 'number' ||
      typeof mod.migrate !== 'function'
    ) {
      throw new Error(`Invalid migration step ${entry}: must export id, toVersion, migrate()`);
    }
    steps.push({
      id: mod.id,
      toVersion: mod.toVersion,
      description: mod.description ?? '',
      repairsInvariant: mod.repairsInvariant === true,
      migrate: mod.migrate,
    });
  }
  steps.sort((a, b) => a.toVersion - b.toVersion);
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].toVersion === steps[i - 1].toVersion) {
      throw new Error(
        `Migration steps '${steps[i - 1].id}' and '${steps[i].id}' both declare toVersion ${steps[i].toVersion}`,
      );
    }
  }
  return steps;
}

export function pendingMigrations(pool: PoolConfig, steps: MigrationStep[]): MigrationStep[] {
  const current = pool.schema_version ?? 0;
  return steps.filter((step) => step.toVersion > current);
}

export interface MigrationResult {
  pool: PoolConfig;
  applied: string[];
}

/** Apply all pending steps in order, stamping schema_version after each. */
export function applyMigrations(pool: PoolConfig, steps: MigrationStep[]): MigrationResult {
  let current = pool;
  const applied: string[] = [];
  const pending = pendingMigrations(pool, steps);
  for (const step of pending) {
    current = step.migrate(current) ?? current;
    current.schema_version = step.toVersion;
    applied.push(step.id);
  }
  for (const step of steps) {
    if (!step.repairsInvariant || pending.includes(step)) continue;
    const before = JSON.stringify(current);
    current = step.migrate(current) ?? current;
    if (JSON.stringify(current) !== before) applied.push(`${step.id}-repair`);
  }
  return { pool: current, applied };
}
