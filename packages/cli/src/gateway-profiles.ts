import { createHash } from 'node:crypto';
// gateway-profiles.ts — kubeconfig-style gateway profiles for the CLI (ADR-036).
//
// Machine-level store at <FARMSLOT_HOME>/gateways.json (0600, default ~/.farmslot): named gateway URLs
// plus the pairing/auth credential obtained via `farmslot login`. Workspace
// state stays untouched — profiles follow the operator, not the checkout.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { withCredentialLock } from '@farmslot/credential-store';
import {
  type GatewayAuthMode,
  parsePersonSessionAuth,
  type PersonSessionAuth,
  PersonSessionChangedError,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';
import { isLoopbackHost } from '@farmslot/protocol/node/loopback-host';

import { isCheckoutGatewayUrl } from './onboarding/env-file.js';
import type { GatewayCredential } from './gateway-client.js';

export type { GatewayAuthMode };

export interface GatewayProfile {
  url: string;
  /** Auth mode the credential belongs to; absent until login. */
  authMode?: Exclude<GatewayAuthMode, 'none'>;
  /** Pairing/auth credential; never printed in logs or --json output. */
  secret?: string;
  personSession?: PersonSessionAuth;
}

export interface GatewayProfilesFile {
  active?: string;
  gateways: Record<string, GatewayProfile>;
}

const profileVersions = new WeakMap<GatewayProfilesFile, { path: string; digest: string | null }>();

export const DEFAULT_GATEWAY_PORT = 7777;
export const DEFAULT_GATEWAY_URL = `ws://localhost:${DEFAULT_GATEWAY_PORT}`;

export function profilesPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(farmslotHome(env), 'gateways.json');
}

// Names the file (and the profile) but never echoes its contents: the store
// holds credentials, and a JSON.parse message quotes the input around the error.
function invalidProfilesFile(path: string, detail: string): Error {
  return new Error(`Invalid gateway profiles file: ${path} — ${detail}; fix or remove it`);
}

export function loadProfiles(path: string = profilesPath()): GatewayProfilesFile {
  if (!existsSync(path)) {
    const empty: GatewayProfilesFile = { gateways: {} };
    profileVersions.set(empty, { path, digest: null });
    return empty;
  }
  const raw = readFileSync(path, 'utf-8');
  let parsed: GatewayProfilesFile;
  try {
    parsed = JSON.parse(raw) as GatewayProfilesFile;
  } catch {
    throw invalidProfilesFile(path, 'not valid JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.gateways !== 'object' ||
    parsed.gateways === null ||
    Array.isArray(parsed.gateways)
  ) {
    throw invalidProfilesFile(path, 'expected a "gateways" object');
  }
  for (const [name, profile] of Object.entries(parsed.gateways as Record<string, unknown>)) {
    const p = profile as Partial<Record<keyof GatewayProfile, unknown>> | null;
    if (
      typeof p !== 'object' ||
      p === null ||
      typeof p.url !== 'string' ||
      (p.authMode !== undefined && p.authMode !== 'token' && p.authMode !== 'password') ||
      (p.secret !== undefined && typeof p.secret !== 'string') ||
      (p.personSession !== undefined &&
        (!parsePersonSessionAuth(p.personSession) || p.secret !== undefined))
    ) {
      throw invalidProfilesFile(path, `profile '${name}' is malformed`);
    }
  }
  const result = { active: parsed.active, gateways: parsed.gateways ?? {} };
  profileVersions.set(result, { path, digest: createHash('sha256').update(raw).digest('hex') });
  return result;
}

export function saveProfiles(profiles: GatewayProfilesFile, path: string = profilesPath()): void {
  withCredentialLock(
    () => {
      const current = existsSync(path)
        ? createHash('sha256').update(readFileSync(path)).digest('hex')
        : null;
      const snapshot = profileVersions.get(profiles);
      if (snapshot?.path === path && snapshot.digest !== current)
        throw new Error(
          'Gateway profiles changed while this command was running. Retry the command.',
        );
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const text = JSON.stringify(profiles, null, 2) + '\n';
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, text, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
      profileVersions.set(profiles, {
        path,
        digest: createHash('sha256').update(text).digest('hex'),
      });
    },
    { FARMSLOT_HOME: dirname(path) },
  );
}

/** Load the store with a clean CLI error (path included) instead of a stack trace. */
export function loadProfilesOrExit(output: { error: (msg: string) => void }): GatewayProfilesFile {
  try {
    return loadProfiles();
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

const PROFILE_NAME_RE = /^[a-z][a-z0-9-]*$/;

export function assertProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(`Profile name must be lowercase kebab-case, got '${name}'`);
  }
}

export function assertGatewayUrl(url: string): void {
  if (!/^wss?:\/\//.test(url)) {
    throw new Error(`Gateway URL must start with ws:// or wss://, got '${url}'`);
  }
}

export interface GatewayTarget {
  url: string;
  /**
   * Profile credential when the target came from a profile. null = profile has
   * no credential: the client must NOT fall back to env discovery, or a local
   * secret could leak to a remote gateway. undefined = non-profile target
   * (no credential is sent).
   */
  credential?: GatewayCredential | null;
  profileName?: string;
  source: 'url-flag' | 'gateway-flag' | 'env' | 'active-profile' | 'default';
}

/** Map a profile's stored secret onto the auth.connect credential shape. */
export function profileCredential(
  profile: GatewayProfile,
  persist?: (value: PersonSessionAuth | null) => Promise<void>,
): GatewayCredential | undefined {
  if (profile.personSession)
    return {
      personSession: profile.personSession,
      persistPersonSession: async (value) => {
        await persist?.(value);
        if (value) profile.personSession = value;
        else delete profile.personSession;
      },
    };
  if (!profile.secret || !profile.authMode) return undefined;
  return profile.authMode === 'password' ? { password: profile.secret } : { token: profile.secret };
}

/** Persist only the selected profile; a late response cannot overwrite a new login or URL. */
export function storedProfileCredential(
  name: string,
  profile: GatewayProfile,
  path = profilesPath(),
): GatewayCredential | undefined {
  const credential = profileCredential(profile, async (value) => {
    const current = loadProfiles(path);
    const selected = matchingProfile(current, name, profile);
    if (selected.personSession?.refreshToken !== profile.personSession?.refreshToken)
      throw new PersonSessionChangedError();
    if (value) selected.personSession = value;
    else delete selected.personSession;
    saveProfiles(current, path);
  });
  if (credential && !profile.personSession && profile.secret) {
    const presented = profile.secret;
    credential.forgetLegacyPerson = async () => {
      const current = loadProfiles(path);
      const selected = matchingProfile(current, name, profile);
      if (selected.secret !== presented || selected.personSession)
        throw new PersonSessionChangedError();
      delete selected.secret;
      delete selected.authMode;
      saveProfiles(current, path);
      delete profile.secret;
      delete profile.authMode;
    };
  }
  return credential;
}

function matchingProfile(
  profiles: GatewayProfilesFile,
  name: string,
  expected: GatewayProfile,
): GatewayProfile {
  const selected = profiles.gateways[name];
  if (!selected || selected.url !== expected.url) throw new PersonSessionChangedError();
  return selected;
}

/** Scheme, host, explicit-or-default port and path without a trailing slash. */

function comparableGatewayUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    const port = url.port || (url.protocol === 'wss:' ? '443' : '80');
    return `${url.protocol}//${url.hostname}:${port}${url.pathname.replace(/\/+$/u, '')}`;
  } catch {
    return undefined;
  }
}

/**
 * The stored profile for `url`, ignoring scheme/host case, a default port and a
 * trailing slash; the active profile wins a tie.
 */
export function profileForUrl(
  url: string,
  profiles: GatewayProfilesFile,
): { name: string; profile: GatewayProfile } | undefined {
  const target = comparableGatewayUrl(url);
  if (!target) return undefined;
  const names = Object.keys(profiles.gateways).sort(
    (a, b) => Number(b === profiles.active) - Number(a === profiles.active),
  );
  const name = names.find((n) => comparableGatewayUrl(profiles.gateways[n].url) === target);
  return name ? { name, profile: profiles.gateways[name] } : undefined;
}

function targetForMatchedUrl(
  url: string,
  source: GatewayTarget['source'],
  profiles: GatewayProfilesFile,
  credentialFor: (name: string, profile: GatewayProfile) => GatewayCredential | undefined,
): GatewayTarget | undefined {
  const match = profileForUrl(url, profiles);
  return match
    ? {
        url,
        credential: credentialFor(match.name, match.profile) ?? null,
        profileName: match.name,
        source,
      }
    : undefined;
}

/**
 * Resolve which gateway a command targets.
 * Precedence: --url > --gateway <name> > GW_URL env (back-compat) >
 * active profile > default localhost. Explicit URLs reuse only the matching
 * stored profile. GW_URL requires a match and never falls back to the active
 * profile or a credential belonging to another gateway.
 *
 * The profile store is read lazily: a corrupt gateways.json must never break
 * explicit --url invocations. A malformed store fails env/profile routing.
 */
export function resolveGatewayTarget(
  opts: { url?: string; gateway?: string },
  env: NodeJS.ProcessEnv = process.env,
  profilesOverride?: GatewayProfilesFile,
): GatewayTarget {
  const path = profilesPath();
  const getProfiles = (): GatewayProfilesFile => profilesOverride ?? loadProfiles(path);
  const credentialFor = (name: string, profile: GatewayProfile): GatewayCredential | undefined =>
    profilesOverride ? profileCredential(profile) : storedProfileCredential(name, profile, path);

  if (opts.url) {
    let profiles: GatewayProfilesFile;
    try {
      profiles = getProfiles();
    } catch {
      // A raw URL remains available if the store cannot be loaded. Mapping
      // failures after loading propagate rather than silently losing auth.
      return { url: opts.url, source: 'url-flag' };
    }
    return (
      targetForMatchedUrl(opts.url, 'url-flag', profiles, credentialFor) ?? {
        url: opts.url,
        source: 'url-flag',
      }
    );
  }

  if (opts.gateway) {
    const profiles = getProfiles();
    const profile = profiles.gateways[opts.gateway];
    if (!profile) {
      throw new Error(
        `Unknown gateway profile '${opts.gateway}' — add it with: farmslot gateway add ${opts.gateway} <ws-url>`,
      );
    }
    return {
      url: profile.url,
      credential: credentialFor(opts.gateway, profile) ?? null,
      profileName: opts.gateway,
      source: 'gateway-flag',
    };
  }

  if (env.GW_URL) {
    // The gateway sets GW_URL for remote workers to the URL their node dials.
    // A stored profile for that gateway supplies its credential (or none).
    const target = targetForMatchedUrl(env.GW_URL, 'env', getProfiles(), credentialFor);
    if (target) return target;
    // Locally derived sandbox URLs may intentionally name an unauthenticated
    // development gateway. An inherited worker URL never gets this fallback.
    if (isCheckoutGatewayUrl(env, env.GW_URL)) {
      if (!URL.canParse(env.GW_URL))
        throw new Error(
          'Invalid checkout-derived GW_URL; correct it in the checkout configuration',
        );
      if (isLoopbackHost(new URL(env.GW_URL).hostname)) return { url: env.GW_URL, source: 'env' };
    }
    throw Object.assign(
      new Error(
        'No stored gateway profile matches GW_URL; add and log in to a profile for the gateway URL in GW_URL with farmslot gateway add and farmslot login',
      ),
      { userAction: 'farmslot gateway add <name> <ws-url> && farmslot login <name>' },
    );
  }

  // Fail hard on a corrupt store here: silently falling back to localhost
  // could aim a mutating command at the wrong gateway when the operator's
  // active profile was remote. --url/GW_URL targets never reach this point.
  const profiles = getProfiles();
  if (profiles.active) {
    const profile = profiles.gateways[profiles.active];
    if (profile) {
      return {
        url: profile.url,
        credential: credentialFor(profiles.active, profile) ?? null,
        profileName: profiles.active,
        source: 'active-profile',
      };
    }
  }

  return { url: DEFAULT_GATEWAY_URL, source: 'default' };
}
