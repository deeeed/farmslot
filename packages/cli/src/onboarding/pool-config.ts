// onboarding/pool-config.ts — pool file generation, structural validation, and
// slot registration for onboarding. Full JSON-schema validation stays in
// scripts/validate-config.sh (dev tooling, needs python3-jsonschema); doctor and
// project add use this dependency-free structural check instead.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const POOL_SCHEMA_VERSION = 1;

/** First port handed out for slot dev servers — high block clear of common dev defaults. */
export const PORT_BLOCK_START = 9300;

export interface PoolSlot {
  id: string;
  project?: string;
  platform?: string;
  enabled?: boolean;
  mode?: string;
  repo: string;
  session: string;
  branch?: string;
  app?: string;
  lifecycle?: string;
  agent?: string;
  task?: string | null;
  resources?: Record<string, Record<string, unknown>>;
}

export interface PoolConfig {
  $schema?: string;
  schema_version?: number;
  machine: string;
  project?: string;
  platform?: string;
  os?: string;
  host: string;
  ssh_user: string;
  claude_path?: string;
  codex_path?: string;
  opencode_path?: string;
  cursor_path?: string;
  grok_path?: string;
  android_home?: string;
  dispatch_cmd?: string;
  recycle_cmd?: string;
  repo_url?: string;
  notes?: string;
  tmux_workers?: unknown;
  slots: PoolSlot[];
}

/** Structural validation of a pool config. Returns actionable error strings; empty = valid. */
export function validatePoolConfig(pool: unknown): string[] {
  const errors: string[] = [];
  if (typeof pool !== 'object' || pool === null || Array.isArray(pool)) {
    return ['pool config must be a JSON object'];
  }
  const p = pool as Record<string, unknown>;
  for (const field of ['machine', 'host', 'ssh_user']) {
    if (typeof p[field] !== 'string' || (p[field] as string).length === 0) {
      errors.push(`'${field}' must be a non-empty string`);
    }
  }
  if (p.schema_version !== undefined && typeof p.schema_version !== 'number') {
    errors.push(`'schema_version' must be a number`);
  }
  if (!Array.isArray(p.slots)) {
    errors.push(`'slots' must be an array`);
    return errors;
  }
  const seen = new Set<string>();
  const slots: unknown[] = p.slots;
  slots.forEach((slot, i) => {
    if (typeof slot !== 'object' || slot === null) {
      errors.push(`slots[${i}] must be an object`);
      return;
    }
    const s = slot as Record<string, unknown>;
    for (const field of ['id', 'repo', 'session']) {
      if (typeof s[field] !== 'string' || (s[field] as string).length === 0) {
        errors.push(`slots[${i}]: '${field}' must be a non-empty string`);
      }
    }
    if (typeof s.id === 'string') {
      if (seen.has(s.id)) errors.push(`slots[${i}]: duplicate slot id '${s.id}'`);
      seen.add(s.id);
    }
  });
  return errors;
}

export interface GeneratePoolOptions {
  machine: string;
  os: 'darwin' | 'linux';
  sshUser: string;
  runnerPaths: Partial<Record<'claude' | 'codex' | 'cursor' | 'grok', string>>;
}

/**
 * Generate a fresh pool config for this machine. Starts with zero slots —
 * `farmslot project add` registers slots as packs declare them.
 */
export function generatePool(opts: GeneratePoolOptions): PoolConfig {
  const pool: PoolConfig = {
    $schema: '../schemas/pool.schema.json',
    schema_version: POOL_SCHEMA_VERSION,
    machine: opts.machine,
    os: opts.os,
    host: 'localhost',
    ssh_user: opts.sshUser,
    slots: [],
  };
  if (opts.runnerPaths.claude) pool.claude_path = opts.runnerPaths.claude;
  if (opts.runnerPaths.codex) pool.codex_path = opts.runnerPaths.codex;
  if (opts.runnerPaths.cursor) pool.cursor_path = opts.runnerPaths.cursor;
  if (opts.runnerPaths.grok) pool.grok_path = opts.runnerPaths.grok;
  return pool;
}

/** Collect every numeric port already used by any slot resource in the pool. */
export function usedPorts(pool: PoolConfig): Set<number> {
  const ports = new Set<number>();
  for (const slot of pool.slots) {
    for (const resource of Object.values(slot.resources ?? {})) {
      for (const [key, value] of Object.entries(resource)) {
        if (/(^|_)port$/.test(key) && typeof value === 'number') ports.add(value);
      }
    }
  }
  return ports;
}

/** Allocate the next free port from the onboarding block (9300+). */
export function allocatePort(pool: PoolConfig, from: number = PORT_BLOCK_START): number {
  const taken = usedPorts(pool);
  let port = from;
  while (taken.has(port)) port++;
  return port;
}

/** First CDP port handed out for browser slots — separate block from dev servers. */
export const CDP_PORT_BLOCK_START = 9500;

/** Resource type each platform's slots require beyond the dev server. */
const PLATFORM_RESOURCE_TYPE: Record<string, string> = {
  ios: 'ios-sim',
  android: 'android-emu',
  'chrome-extension': 'browser',
  browser: 'browser',
};

/** Resource keys a slot of this platform must carry (single source for checks). */
export function platformResourceKeys(platform: string): string[] {
  const type = PLATFORM_RESOURCE_TYPE[platform];
  return type ? [type] : [];
}

/**
 * Platform-default slot resources beyond the dev-server port. Without these,
 * pack-created non-cli slots fail setup/preflight ({{simulator}} etc. expand
 * empty). Names follow the operator convention: device per slot, named
 * <short>-<n>. cli/unknown platforms need nothing extra. Android gets the AVD
 * name only — adb serial pinning is machine-specific and stays an operator edit.
 */
export function defaultResources(
  platform: string,
  short: string,
  n: number,
  pool: PoolConfig,
): Record<string, Record<string, unknown>> {
  const type = PLATFORM_RESOURCE_TYPE[platform];
  if (type === 'ios-sim') {
    return { 'ios-sim': { simulator: `${short}-${n}`, headless: true } };
  }
  if (type === 'android-emu') {
    return { 'android-emu': { avd: `${short}-${n}` } };
  }
  if (type === 'browser') {
    return { browser: { cdp_port: allocatePort(pool, CDP_PORT_BLOCK_START) } };
  }
  return {};
}

/**
 * Register a slot in the pool, preserving user edits: an existing slot with the
 * same id is left untouched. Returns true when the slot was added.
 */
export function registerSlot(pool: PoolConfig, slot: PoolSlot): boolean {
  if (pool.slots.some((s) => s.id === slot.id)) return false;
  pool.slots.push(slot);
  return true;
}

export function readPool(path: string): PoolConfig {
  const pool: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  const errors = validatePoolConfig(pool);
  if (errors.length > 0) {
    throw new Error(`Invalid pool config ${path}:\n  ${errors.join('\n  ')}`);
  }
  return pool as PoolConfig;
}

export function writePool(path: string, pool: PoolConfig): void {
  writeFileSync(path, JSON.stringify(pool, null, 2) + '\n');
}

/**
 * Choose the pool filename for this machine. When the source checkout already
 * defines pool/<hostname>.json (an operator machine), the workspace uses
 * <hostname>-onboard to avoid colliding with the live machine config.
 */
export function poolFileName(hostname: string, sourcePoolDir: string | null): string {
  if (sourcePoolDir && existsSync(`${sourcePoolDir}/${hostname}.json`)) {
    return `${hostname}-onboard.json`;
  }
  return `${hostname}.json`;
}
