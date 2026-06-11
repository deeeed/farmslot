// gateway-profiles.ts — kubeconfig-style gateway profiles for the CLI (ADR-036).
//
// Machine-level store at ~/.farmslot/gateways.json (0600): named gateway URLs
// plus the pairing/auth credential obtained via `farmslot login`. Workspace
// state stays untouched — profiles follow the operator, not the checkout.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type GatewayAuthMode = 'none' | 'token' | 'password';

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

export const DEFAULT_GATEWAY_URL = 'ws://localhost:7777';

export function profilesPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.FARMSLOT_HOME ?? join(homedir(), '.farmslot');
  return join(home, 'gateways.json');
}

export function loadProfiles(path: string = profilesPath()): GatewayProfilesFile {
  if (!existsSync(path)) return { gateways: {} };
  let parsed: GatewayProfilesFile;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as GatewayProfilesFile;
  } catch (err) {
    // Always name the file — a raw SyntaxError with no path is undiagnosable.
    throw new Error(
      `Invalid gateway profiles file: ${path} — fix or remove it (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.gateways !== 'object' ||
    parsed.gateways === null ||
    Array.isArray(parsed.gateways)
  ) {
    throw new Error(`Invalid gateway profiles file: ${path} — fix or remove it`);
  }
  return { active: parsed.active, gateways: parsed.gateways ?? {} };
}

export function saveProfiles(profiles: GatewayProfilesFile, path: string = profilesPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(profiles, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync mode only applies on create — enforce on every save.
  chmodSync(path, 0o600);
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

/**
 * Resolve which gateway a command targets.
 * Precedence: --url > --gateway <name> > GW_URL env (back-compat) >
 * active profile > default localhost.
 *
 * The profile store is read lazily and only on the profile branches: a corrupt
 * gateways.json must never break --url/GW_URL/default invocations.
 */
export function resolveGatewayTarget(
  opts: { url?: string; gateway?: string },
  env: NodeJS.ProcessEnv = process.env,
  profilesOverride?: GatewayProfilesFile,
): GatewayTarget {
  if (opts.url) return { url: opts.url, source: 'url-flag' };
  const getProfiles = (): GatewayProfilesFile => profilesOverride ?? loadProfiles();

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

  if (env.GW_URL) return { url: env.GW_URL, source: 'env' };

  let profiles: GatewayProfilesFile;
  try {
    profiles = getProfiles();
  } catch (err) {
    // A corrupt store must not break local default-target commands — warn
    // loudly on stderr and fall back; doctor and the gateway/auth commands
    // surface the same error with the file path as a hard failure.
    process.stderr.write(
      `warning: ${err instanceof Error ? err.message : String(err)} — using default gateway target\n`,
    );
    return { url: DEFAULT_GATEWAY_URL, source: 'default' };
  }
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
