import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { NativeProfileAddParams, NativeProfileInfo } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { nativeRunnerDefinitions } from './registry.js';
import { durableWrite } from './storage.js';

interface AccountConfig {
  version: 1;
  accounts: Record<string, unknown>;
  nativeProfiles?: Record<string, NativeProfileInfo>;
  [key: string]: unknown;
}

function profileId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || id === 'ambient')
    throw new Error('Profile label must use lowercase letters, digits, dashes or underscores');
}
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function canonicalDirectory(directory: string): string {
  const suffix: string[] = [];
  let existing = directory;
  while (!existsSync(existing)) {
    suffix.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...suffix);
}
export function providerAccountsConfigPath(home = farmslotHome()): string {
  return join(home, 'provider-accounts.json');
}
function readConfig(home: string): AccountConfig {
  const file = providerAccountsConfigPath(home);
  if (!existsSync(file)) return { version: 1, accounts: {} };
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !object(value) ||
    value.version !== 1 ||
    !object(value.accounts) ||
    (value.nativeProfiles !== undefined && !object(value.nativeProfiles))
  )
    throw new Error('Invalid provider account configuration');
  for (const [id, entry] of Object.entries(value.nativeProfiles ?? {})) {
    profileId(id);
    if (
      !object(entry) ||
      entry.id !== id ||
      typeof entry.runner !== 'string' ||
      typeof entry.directory !== 'string' ||
      !isAbsolute(entry.directory) ||
      typeof entry.accountContextId !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(entry.accountContextId) ||
      Object.keys(entry).some(
        (key) => !['id', 'runner', 'directory', 'accountContextId', 'state'].includes(key),
      ) ||
      !['active', 'retiring'].includes(String(entry.state))
    )
      throw new Error('Invalid native profile configuration');
  }
  return value as AccountConfig;
}
function writeConfig(home: string, config: AccountConfig): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  durableWrite(providerAccountsConfigPath(home), config);
}

export function listNativeProfiles(home = farmslotHome()): NativeProfileInfo[] {
  return Object.values(readConfig(home).nativeProfiles ?? {});
}
export function findNativeProfile(
  id: string,
  home = farmslotHome(),
): NativeProfileInfo | undefined {
  profileId(id);
  return listNativeProfiles(home).find((profile) => profile.id === id);
}
export function requireNativeProfile(
  id: string,
  runner?: string,
  home = farmslotHome(),
): NativeProfileInfo {
  const profile = findNativeProfile(id, home);
  if (!profile || profile.state !== 'active')
    throw new Error('Native account profile is unavailable');
  if (runner !== undefined && profile.runner !== runner)
    throw new Error('Native profile belongs to another runner');
  if (!Object.hasOwn(nativeRunnerDefinitions, profile.runner))
    throw new Error('Native profile runner is unavailable');
  return profile;
}
export function assertNativeProfileCurrent(
  profile: NativeProfileInfo,
  home = farmslotHome(),
): void {
  const current = requireNativeProfile(profile.id, profile.runner, home);
  if (
    current.accountContextId !== profile.accountContextId ||
    current.directory !== profile.directory
  )
    throw new Error('Native account profile changed; start a new conversation');
}
export function nativeProfileEnvironment(
  profile: NativeProfileInfo,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const definition = nativeRunnerDefinitions[profile.runner];
  if (!definition?.account) throw new Error('Native profile runner is unavailable');
  const env = { ...base };
  for (const key of definition.account.unset) delete env[key];
  return {
    ...env,
    FARMSLOT_HOME: base.FARMSLOT_HOME ?? farmslotHome(),
    ...definition.account.environment(profile.directory, base),
  };
}

// Node-local profile mutations share one queue. Retirement holds it through
// process cleanup; ordinary profile reads still observe the persisted retiring state.
const mutations = new Map<string, Promise<void>>();
async function mutate<T>(home: string, operation: () => Promise<T> | T): Promise<T> {
  const previous = mutations.get(home);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutations.set(home, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (mutations.get(home) === current) mutations.delete(home);
  }
}

export function inspectNativeProfile<T>(
  id: string,
  inspect: (profile: NativeProfileInfo) => Promise<T>,
  home = farmslotHome(),
): Promise<T> {
  return mutate(home, () => inspect(requireNativeProfile(id, undefined, home)));
}

export function addNativeProfile(
  params: NativeProfileAddParams,
  home = farmslotHome(),
): Promise<NativeProfileInfo> {
  profileId(params.profileId);
  if (!Object.hasOwn(nativeRunnerDefinitions, params.runner))
    throw new Error('Runner has no native profile support');
  return mutate(home, () => {
    const config = readConfig(home);
    const profiles = config.nativeProfiles ?? {};
    const existing = Object.hasOwn(profiles, params.profileId)
      ? profiles[params.profileId]
      : undefined;
    const requested =
      params.directory ?? join(home, 'runner-profiles', params.runner, params.profileId);
    if (!isAbsolute(requested) && !requested.startsWith('~/'))
      throw new Error('Native profile directory must be absolute or start with ~/');
    const directory = resolve(
      requested.startsWith('~/') ? join(homedir(), requested.slice(2)) : requested,
    );
    const canonical = canonicalDirectory(directory);
    if (existing) {
      if (
        existing.runner === params.runner &&
        existing.directory === canonical &&
        existing.state === 'active'
      )
        return existing;
      throw new Error('Retire the existing profile before changing its account location');
    }
    if (
      Object.values(profiles).some(
        (profile) => profile.runner === params.runner && profile.directory === canonical,
      )
    )
      throw new Error('This native account directory already has a profile');
    mkdirSync(canonical, { recursive: true, mode: 0o700 });
    const profile: NativeProfileInfo = {
      id: params.profileId,
      runner: params.runner,
      directory: canonical,
      accountContextId: randomUUID(),
      state: 'active',
    };
    writeConfig(home, { ...config, nativeProfiles: { ...profiles, [profile.id]: profile } });
    return profile;
  });
}

export function removeNativeProfile(
  id: string,
  accountContextId: string,
  stopSessions: (profile: NativeProfileInfo) => Promise<void>,
  home = farmslotHome(),
): Promise<void> {
  profileId(id);
  return mutate(home, async () => {
    const config = readConfig(home);
    const profile = Object.hasOwn(config.nativeProfiles ?? {}, id)
      ? config.nativeProfiles![id]
      : undefined;
    if (!profile) return;
    if (profile.accountContextId !== accountContextId)
      throw new Error('Native profile changed; refresh before removing it');
    profile.state = 'retiring';
    writeConfig(home, config);
    await stopSessions(profile);
    const latest = readConfig(home);
    if (latest.nativeProfiles?.[id]?.accountContextId !== accountContextId)
      throw new Error('Native profile changed during retirement');
    delete latest.nativeProfiles[id];
    writeConfig(home, latest);
  });
}
