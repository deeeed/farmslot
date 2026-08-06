import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { processIsAlive, withCredentialLock } from './credential-store-lock.js';

export interface GatewayPresence {
  pid: number;
  farmslotRoot: string;
  port: number;
}

export function gatewayPresenceDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(farmslotHome(env), 'gateways.live');
}

export function registerGatewayPresence(
  presence: GatewayPresence,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const entryPath = withCredentialLock(() => {
    const directory = gatewayPresenceDirectory(env);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const suffix = createHash('sha256')
      .update(`${presence.pid}\0${presence.farmslotRoot}\0${presence.port}`)
      .digest('hex')
      .slice(0, 16);
    const path = join(directory, `${presence.pid}-${suffix}.json`);
    writeFileSync(path, `${JSON.stringify(presence)}\n`, { mode: 0o600, flag: 'wx' });
    return path;
  }, env);

  return () => {
    withCredentialLock(() => {
      if (!existsSync(entryPath)) return;
      const parsed = readPresence(entryPath);
      if (parsed?.pid === process.pid) unlinkSync(entryPath);
      pruneEmptyPresenceDirectory(env);
    }, env);
  };
}

export function listLiveGateways(env: NodeJS.ProcessEnv = process.env): GatewayPresence[] {
  return withCredentialLock(() => listLiveGatewaysUnlocked(env), env);
}

export function assertNoLiveGatewaysUnlocked(env: NodeJS.ProcessEnv = process.env): void {
  const live = listLiveGatewaysUnlocked(env);
  if (live.length === 0) return;
  const locations = live.map((entry) => `${entry.farmslotRoot} on port ${entry.port}`).join(', ');
  throw new Error(
    `Cannot modify the credential store: ${live.length} ${live.length === 1 ? 'gateway is' : 'gateways are'} running (${locations}).\n` +
      'Next: stop them, then re-run this command.',
  );
}

function listLiveGatewaysUnlocked(env: NodeJS.ProcessEnv): GatewayPresence[] {
  const directory = gatewayPresenceDirectory(env);
  if (!existsSync(directory)) return [];
  const live: GatewayPresence[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const presence = readPresence(path);
    if (!presence || !processIsAlive(presence.pid)) {
      rmSync(path, { force: true });
      continue;
    }
    live.push(presence);
  }
  pruneEmptyPresenceDirectory(env);
  return live;
}

function readPresence(path: string): GatewayPresence | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as GatewayPresence).pid !== 'number' ||
      typeof (parsed as GatewayPresence).farmslotRoot !== 'string' ||
      typeof (parsed as GatewayPresence).port !== 'number'
    ) {
      return null;
    }
    return parsed as GatewayPresence;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function pruneEmptyPresenceDirectory(env: NodeJS.ProcessEnv): void {
  const directory = gatewayPresenceDirectory(env);
  if (!existsSync(directory) || readdirSync(directory).length > 0) return;
  try {
    rmdirSync(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
  }
}
