// gateway-profiles.ts — kubeconfig-style gateway profiles for the CLI (ADR-036).
//
// Machine-level store at <FARMSLOT_HOME>/gateways.json (0600, default ~/.farmslot): named gateway URLs
// plus the pairing/auth credential obtained via `farmslot login`. Workspace
// state stays untouched — profiles follow the operator, not the checkout.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { GatewayAuthMode } from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';
import { isLoopbackHost } from '@farmslot/protocol/node/loopback-host';

import { isCheckoutGatewayUrl } from './onboarding/env-file.js';

export type { GatewayAuthMode };

export interface GatewayProfile {
  url: string;
  /** Auth mode the credential belongs to; absent until login. */
  authMode?: Exclude<GatewayAuthMode, 'none'>;
  /** Pairing/auth credential; never printed in logs or --json output. */
  secret?: string;
}

export interface GatewayProfilesFile {
  active?: string;
  gateways: Record<string, GatewayProfile>;
}

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
  if (!existsSync(path)) return { gateways: {} };
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
      (p.secret !== undefined && typeof p.secret !== 'string')
    ) {
      throw invalidProfilesFile(path, `profile '${name}' is malformed`);
    }
  }
  return { active: parsed.active, gateways: parsed.gateways ?? {} };
}

export function saveProfiles(profiles: GatewayProfilesFile, path: string = profilesPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(profiles, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync mode only applies on create — enforce on every save.
  chmodSync(path, 0o600);
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
   * (env discovery stays allowed for back-compat).
   */
  credential?: { token?: string; password?: string } | null;
  profileName?: string;
  source: 'url-flag' | 'gateway-flag' | 'env' | 'active-profile' | 'default';
}

/** Map a profile's stored secret onto the auth.connect credential shape. */
export function profileCredential(
  profile: GatewayProfile,
): { token?: string; password?: string } | undefined {
  if (!profile.secret || !profile.authMode) return undefined;
  return profile.authMode === 'password' ? { password: profile.secret } : { token: profile.secret };
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
): GatewayTarget | undefined {
  const match = profileForUrl(url, profiles);
  return match
    ? { url, credential: profileCredential(match.profile) ?? null, profileName: match.name, source }
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
  const getProfiles = (): GatewayProfilesFile => profilesOverride ?? loadProfiles();

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
      targetForMatchedUrl(opts.url, 'url-flag', profiles) ?? { url: opts.url, source: 'url-flag' }
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
      credential: profileCredential(profile) ?? null,
      profileName: opts.gateway,
      source: 'gateway-flag',
    };
  }

  if (env.GW_URL) {
    // The gateway sets GW_URL for remote workers to the URL their node dials.
    // A stored profile for that gateway supplies its credential (or none).
    const target = targetForMatchedUrl(env.GW_URL, 'env', getProfiles());
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
        credential: profileCredential(profile) ?? null,
        profileName: profiles.active,
        source: 'active-profile',
      };
    }
  }

  return { url: DEFAULT_GATEWAY_URL, source: 'default' };
}
