// methods/gateway-status.ts — gateway.status: package version + update freshness.
//
// Farmslot has no semver release stream; it is a git clone advanced by
// `farmslot update` (fetch + reset to origin's default branch). "Update
// available" therefore means the local HEAD is behind origin/<default-branch>.
// We run a real `git fetch` so the answer is current, but cache it: the UI polls
// this on every (re)connect and a fetch is a network round-trip.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type {
  GatewayStatusParams,
  GatewayStatusResult,
  GatewayUpdateStatus,
} from '@farmslot/protocol';

import { execLocal, farmslotRoot } from '../core/index.js';

const UPDATE_COMMAND = 'farmslot update';
/** Fresh fetch result is trusted for 15 minutes. */
const TTL_OK_MS = 15 * 60_000;
/** A failed check retries sooner so a transient offline window self-heals. */
const TTL_ERR_MS = 60_000;
const GIT_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 20_000;

const GATEWAY_VERSION = readGatewayVersion();

let cached: GatewayUpdateStatus | null = null;
let cachedAtMs = 0;
let inFlight: Promise<GatewayUpdateStatus> | null = null;

function readGatewayVersion(): string {
  // Runs at import time. The version is contextual metadata, not the update
  // signal, so a missing/corrupt package.json must degrade to 'unknown' rather
  // than throw — an uncaught throw here would take down the whole gateway since
  // route-method.ts imports this module at top level.
  try {
    const pkgPath = path.join(farmslotRoot, 'services', 'gateway', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function git(args: string, timeout = GIT_TIMEOUT_MS) {
  // farmslotRoot is the gateway's own clone; all args are static (no injection surface).
  return execLocal(`git ${args}`, { cwd: farmslotRoot, timeout, maxBuffer: 64 * 1024 });
}

async function resolveDefaultBranch(): Promise<string> {
  // origin/HEAD records the remote default branch once `git remote set-head` ran.
  const head = await git('symbolic-ref --quiet --short refs/remotes/origin/HEAD');
  if (head.exitCode === 0 && head.stdout.trim()) {
    return head.stdout.trim().replace(/^origin\//, '');
  }
  // A `curl | bash` clone may never have set origin/HEAD — ask the remote once.
  const auto = await git('remote set-head origin --auto');
  if (auto.exitCode === 0) {
    const retry = await git('symbolic-ref --quiet --short refs/remotes/origin/HEAD');
    if (retry.exitCode === 0 && retry.stdout.trim()) {
      return retry.stdout.trim().replace(/^origin\//, '');
    }
  }
  return 'main';
}

async function runGitFreshness(): Promise<GatewayUpdateStatus> {
  const base: GatewayUpdateStatus = {
    updateAvailable: false,
    commitsBehind: 0,
    commitsAhead: 0,
    branch: 'main',
    localSha: '',
    remoteSha: null,
    lastChecked: null,
    updateCommand: UPDATE_COMMAND,
    error: null,
  };

  const inside = await git('rev-parse --is-inside-work-tree');
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    // Not a git checkout (e.g. a tarball deploy) — there is nothing to compare.
    return { ...base, error: 'farmslot is not a git checkout — update via install.sh' };
  }

  const branch = await resolveDefaultBranch();
  base.branch = branch;
  base.localSha = (await git('rev-parse --short HEAD')).stdout.trim();

  const fetch = await git(`fetch origin ${branch} --quiet`, FETCH_TIMEOUT_MS);
  if (fetch.exitCode !== 0) {
    // Offline / no remote access is expected and recoverable: surface it as the
    // status `error`, never throw — a transient network failure must not break
    // the gateway or the UI bootstrap.
    return {
      ...base,
      error: `could not reach origin: ${fetch.stderr.trim() || 'git fetch failed'}`,
    };
  }

  const remote = await git(`rev-parse --short origin/${branch}`);
  const remoteSha = remote.exitCode === 0 ? remote.stdout.trim() : null;
  const behind = await git(`rev-list --count HEAD..origin/${branch}`);
  const ahead = await git(`rev-list --count origin/${branch}..HEAD`);
  const commitsBehind = behind.exitCode === 0 ? Number.parseInt(behind.stdout.trim(), 10) || 0 : 0;
  const commitsAhead = ahead.exitCode === 0 ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 0;

  return {
    ...base,
    updateAvailable: commitsBehind > 0,
    commitsBehind,
    commitsAhead,
    remoteSha,
    lastChecked: new Date().toISOString(),
  };
}

async function computeUpdateStatus(force: boolean): Promise<GatewayUpdateStatus> {
  const now = Date.now();
  if (!force && cached && now - cachedAtMs < (cached.error ? TTL_ERR_MS : TTL_OK_MS)) {
    return cached;
  }
  // Collapse concurrent callers (the UI fans out bootstrap RPCs) onto one fetch.
  if (!inFlight) {
    inFlight = runGitFreshness()
      .then((status) => {
        cached = status;
        cachedAtMs = Date.now();
        return status;
      })
      // runGitFreshness should not reject (execLocal never rejects), but a future
      // edit that adds a throwing call must not permanently poison the cache: clear
      // inFlight unconditionally and degrade to an error status this cycle.
      .catch((err: unknown): GatewayUpdateStatus => {
        const fallback: GatewayUpdateStatus = {
          updateAvailable: false,
          commitsBehind: 0,
          commitsAhead: 0,
          branch: 'main',
          localSha: '',
          remoteSha: null,
          lastChecked: null,
          updateCommand: UPDATE_COMMAND,
          error: err instanceof Error ? err.message : String(err),
        };
        cached = fallback;
        cachedAtMs = Date.now();
        return fallback;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export async function gatewayStatus(params?: GatewayStatusParams): Promise<GatewayStatusResult> {
  const update = await computeUpdateStatus(params?.refresh === true);
  return { version: GATEWAY_VERSION, update };
}
