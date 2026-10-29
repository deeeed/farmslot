// methods/gateway-status.ts — gateway.status: package version + update freshness.
//
// Farmslot has no semver release stream; it is a git clone advanced by
// `farmslot update` (fetch + reset to origin's default branch). "Update
// available" therefore means the local HEAD is behind origin/<default-branch>.
// One source owner captures remote refs. Client reads share its retained observation.
import { execFile as execFileCb } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  GatewayReleaseNotes,
  GatewayStatusParams,
  GatewayStatusResult,
  GatewayUpdateStatus,
  UpstreamObservation,
} from '@farmslot/protocol';

import { farmslotRoot } from '../core/index.js';
import { getGatewayListenSnapshot } from '../core/listen-address.js';
import { githubQueryBudget } from '../integrations/github-query-budget.js';
import {
  GATEWAY_UPDATE_ERROR_TTL_MS,
  type GatewayUpdateClientInterest,
  GatewayUpdateObservation,
} from '../resources/gateway-update-observation.js';
import { resourceRevisions } from '../resources/revisions.js';

import {
  type CheckoutObservationChange,
  readCheckoutUpdate,
  watchCheckoutUpdateChanges,
} from './gateway-update.js';
import { workerSessionHistoryEnabled } from './worker-session-history.js';

const execFile = promisify(execFileCb);

const UPDATE_COMMAND = 'farmslot update';
const GIT_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 20_000;

let gatewayVersion = readGatewayVersion();
let gatewayReleaseNotes = readGatewayReleaseNotes();
let hasVisibleInterest = () => false;
let sourceStopping = false;
let sourceGeneration = 0;
const publish = () => {
  if (!sourceStopping) resourceRevisions.advance({ family: 'gateway-update', scope: 'gateway' });
};
const updateObservation = new GatewayUpdateObservation({
  sample: runGitFreshness,
  hasInterest: () => hasVisibleInterest(),
  changed: () => {
    publish();
    void refreshInstalled('checkout');
  },
  empty: emptyUpdateStatus,
});
let operation: GatewayUpdateStatus['operation'];
let installedLoaded = false;
let installedError: string | undefined;
let installedRead: Promise<void> | undefined;
let installedDirty: CheckoutObservationChange | undefined;
let sourceStarted = false;

function emptyUpdateStatus(): GatewayUpdateStatus {
  return {
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
}

function readGatewayReleaseNotes(): GatewayReleaseNotes | undefined {
  try {
    const notesPath = path.join(farmslotRoot, 'services', 'gateway', 'release-notes.json');
    if (!existsSync(notesPath)) return undefined;
    const payload = JSON.parse(readFileSync(notesPath, 'utf-8')) as GatewayReleaseNotes;
    const items = Array.isArray(payload.items)
      ? payload.items.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
    if (!payload?.version || items.length === 0) return undefined;
    return { version: payload.version, date: payload.date ?? null, items };
  } catch {
    return undefined;
  }
}

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

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run git against the gateway's own clone with argv (no shell). The default
 * branch name flows in from `origin/HEAD`, which is remote-controlled — git
 * permits refnames containing shell metacharacters (e.g. `main;id`), so this
 * MUST NOT go through a shell. execFile passes args verbatim to git; a hostile
 * branch name can at worst make git fail to resolve a ref, never execute a
 * command. Resolves (never rejects) so callers branch on exitCode: a non-zero
 * git exit on the offline / missing-ref paths is routine control flow here.
 */
async function git(args: string[], timeout = GIT_TIMEOUT_MS): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFile('git', args, {
      cwd: farmslotRoot,
      timeout,
      maxBuffer: 64 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
}

async function resolveDefaultBranch(): Promise<string> {
  // origin/HEAD records the remote default branch once `git remote set-head` ran.
  const head = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.exitCode === 0 && head.stdout.trim()) {
    return head.stdout.trim().replace(/^origin\//, '');
  }
  // A `curl | bash` clone may never have set origin/HEAD — ask the remote once.
  const auto = await git(['remote', 'set-head', 'origin', '--auto']);
  if (auto.exitCode === 0) {
    const retry = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (retry.exitCode === 0 && retry.stdout.trim()) {
      return retry.stdout.trim().replace(/^origin\//, '');
    }
  }
  return 'main';
}

async function runGitFreshness(): Promise<GatewayUpdateStatus> {
  const base = emptyUpdateStatus();

  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    // Not a git checkout (e.g. a tarball deploy) — there is nothing to compare.
    return { ...base, error: 'farmslot is not a git checkout — update via install.sh' };
  }

  const branch = await resolveDefaultBranch();
  base.branch = branch;
  base.localSha = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim();

  const fetch = await git(
    ['fetch', '--no-write-fetch-head', 'origin', branch, '--quiet'],
    FETCH_TIMEOUT_MS,
  );
  if (fetch.exitCode !== 0) {
    // Offline / no remote access is expected and recoverable: surface it as the
    // status `error`, never throw — a transient network failure must not break
    // the gateway or the UI bootstrap.
    return {
      ...base,
      error: `could not reach origin: ${fetch.stderr.trim() || 'git fetch failed'}`,
    };
  }

  const remote = await git(['rev-parse', '--short', `origin/${branch}`]);
  const remoteSha = remote.exitCode === 0 ? remote.stdout.trim() : null;
  const behind = await git(['rev-list', '--count', `HEAD..origin/${branch}`]);
  const ahead = await git(['rev-list', '--count', `origin/${branch}..HEAD`]);
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

async function readInstalledCheckout(): Promise<Partial<GatewayUpdateStatus>> {
  const current = updateObservation.snapshot();
  const tracked = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const branch =
    tracked.exitCode === 0 && tracked.stdout.trim()
      ? tracked.stdout.trim().replace(/^origin\//, '')
      : current.branch;
  const head = await git(['rev-parse', '--short', 'HEAD']);
  if (head.exitCode !== 0) throw new Error('Could not read the installed gateway commit.');
  const remote = await git(['rev-parse', '--short', `origin/${branch}`]);
  if (remote.exitCode !== 0)
    return {
      branch,
      localSha: head.stdout.trim(),
      remoteSha: null,
      updateAvailable: false,
      commitsBehind: 0,
      commitsAhead: 0,
    };
  const [behind, ahead] = await Promise.all([
    git(['rev-list', '--count', `HEAD..origin/${branch}`]),
    git(['rev-list', '--count', `origin/${branch}..HEAD`]),
  ]);
  if (behind.exitCode !== 0 || ahead.exitCode !== 0)
    throw new Error('Could not compare the installed gateway commit.');
  const commitsBehind = Number.parseInt(behind.stdout.trim(), 10) || 0;
  return {
    branch,
    localSha: head.stdout.trim(),
    remoteSha: remote.stdout.trim(),
    commitsBehind,
    commitsAhead: Number.parseInt(ahead.stdout.trim(), 10) || 0,
    updateAvailable: commitsBehind > 0,
  };
}

function installedFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (installedError !== message) {
    installedError = message;
    publish();
  }
}

function refreshInstalled(kind: CheckoutObservationChange): Promise<void> {
  if (sourceStopping) return Promise.resolve();
  if (kind === 'checkout' || !installedDirty) installedDirty = kind;
  if (installedRead) return installedRead;
  installedRead = (async () => {
    while (installedDirty) {
      const next = installedDirty;
      installedDirty = undefined;
      if (next === 'checkout') {
        updateObservation.installedChanged(await readInstalledCheckout());
        const version = readGatewayVersion();
        const notes = readGatewayReleaseNotes();
        if (
          version !== gatewayVersion ||
          JSON.stringify(notes) !== JSON.stringify(gatewayReleaseNotes)
        ) {
          gatewayVersion = version;
          gatewayReleaseNotes = notes;
          publish();
        }
      }
      const currentOperation = await readCheckoutUpdate();
      if (JSON.stringify(operation) !== JSON.stringify(currentOperation)) {
        operation = currentOperation;
        publish();
      }
      installedLoaded = true;
      if (installedError) {
        installedError = undefined;
        publish();
      }
    }
  })()
    .catch(installedFailure)
    .finally(() => {
      installedRead = undefined;
    });
  return installedRead;
}

/** Gateway startup owns this service and supplies authorized, visible observer interest. */
export async function startGatewayUpdateObservation(options: {
  hasInterest(): boolean;
}): Promise<() => Promise<void>> {
  if (sourceStarted) throw new Error('Gateway update observation already started');
  sourceStarted = true;
  sourceStopping = false;
  updateObservation.start();
  const generation = ++sourceGeneration;
  const current = () => generation === sourceGeneration && !sourceStopping;
  hasVisibleInterest = options.hasInterest;
  let stopFiles: (() => Promise<void>) | undefined;
  try {
    stopFiles = await watchCheckoutUpdateChanges(
      (kind) => {
        if (current()) void refreshInstalled(kind);
      },
      (error) => {
        if (current()) installedFailure(error);
      },
    );
    await refreshInstalled('checkout');
  } catch (error) {
    sourceStopping = true;
    sourceGeneration++;
    hasVisibleInterest = () => false;
    const remote = updateObservation.stop();
    try {
      if (stopFiles) await stopFiles();
    } finally {
      await remote;
      await installedRead;
      sourceStarted = false;
    }
    throw error;
  }
  const timer = setInterval(() => {
    void updateObservation.tick().catch(installedFailure);
  }, GATEWAY_UPDATE_ERROR_TTL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    sourceStopping = true;
    sourceGeneration++;
    hasVisibleInterest = () => false;
    // Mark the sampler stopped before closing files; drain both sources before teardown returns.
    const remote = updateObservation.stop();
    try {
      await stopFiles!();
    } finally {
      await remote;
      await installedRead;
      sourceStarted = false;
    }
  };
}

/** Admission can wake a due source immediately without waiting for the next slow service tick. */
export function wakeGatewayUpdateObservation(): Promise<void> {
  return updateObservation.tick();
}

/** Observer adoption and socket close withdraw the caller's legacy interest. */
export function forgetGatewayUpdateClientInterest(clientId: string): void {
  updateObservation.forgetLegacyClientInterest(clientId);
}

function sourceObservation(): UpstreamObservation {
  const source = updateObservation.observation;
  return installedError
    ? {
        ...source,
        status: source.observedAt === undefined ? 'error' : 'stale',
        error: { code: 'GATEWAY_INSTALLED_SOURCE_UNAVAILABLE', message: installedError },
      }
    : source;
}

export async function gatewayStatus(
  params?: GatewayStatusParams,
  interest: GatewayUpdateClientInterest = {},
): Promise<GatewayStatusResult> {
  await updateObservation.read(params?.refresh === true, interest);
  if (!sourceStopping && (!sourceStarted || !installedLoaded)) await refreshInstalled('checkout');
  await installedRead;
  const update = {
    ...updateObservation.snapshot(),
    ...(installedError ? { error: installedError } : {}),
    checkoutPath: farmslotRoot,
    canUpdate: true,
    operation,
  };
  const listen = getGatewayListenSnapshot();
  return {
    version: gatewayVersion,
    observation: sourceObservation(),
    update,
    releaseNotes: gatewayReleaseNotes,
    ...(listen
      ? {
          listen: {
            host: listen.host,
            port: listen.port,
            remotePairingAllowed: listen.remotePairingAllowed,
          },
        }
      : {}),
    capabilities: {
      experimentalWorkerHistory: workerSessionHistoryEnabled(),
    },
    githubQuerySpend: githubQueryBudget.spendSnapshot(),
  };
}
