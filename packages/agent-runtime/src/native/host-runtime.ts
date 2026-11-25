import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, watch } from 'node:fs';
import { join } from 'node:path';

import { RUNTIME_VERSION } from '../version.js';

import { NATIVE_HOST_VERSION_SKEW } from './host-unavailable.js';
import { type HostIdentity, requestHost } from './ipc.js';
import { currentRuntimeBuild } from './runtime-build.js';
import { readJson, type RecordedProcess, recordedProcessAlive } from './storage.js';

/**
 * New launches refused by a host on another runtime. `busy` names the live sessions that keep
 * it running; `refreshes` says when the refusing service refreshes it on its own.
 */
export function nativeHostVersionSkew(
  host: HostIdentity,
  busy: readonly string[] = [],
  refreshes = 'It is refreshed when its service next starts, once every runner has stopped.',
) {
  return Object.assign(
    new Error(
      `Native host runtime version skew: node ${RUNTIME_VERSION} (build ${currentRuntimeBuild().slice(0, 12)}), host ${host.runtimeVersion ?? 'unknown (legacy)'} (build ${host.runtimeBuild?.slice(0, 12) ?? 'unknown'}). ` +
        `Existing sessions remain available; new launches fail until the host is refreshed. ${refreshes} ` +
        (busy.length ? `Busy: ${busy.join('; ')}. ` : '') +
        'See docs/operations/native-host-refresh.md.',
    ),
    { code: NATIVE_HOST_VERSION_SKEW },
  );
}

/** The host runs this installed runtime: the same version and the same built code. */
export function nativeHostRunsCurrentRuntime(host: HostIdentity): boolean {
  return host.runtimeVersion === RUNTIME_VERSION && host.runtimeBuild === currentRuntimeBuild();
}

export function assertNativeHostRuntime(host: HostIdentity): void {
  if (!nativeHostRunsCurrentRuntime(host)) throw nativeHostVersionSkew(host);
}

/** Lifecycle only: stop only after the running host atomically fences its admissions. */
export async function retireIdleNativeHost(root: string, host: HostIdentity): Promise<boolean> {
  // Only the running host can fence admissions and account for launches before their
  // first reservation. A legacy journal census cannot establish quiescence.
  if (!host.supportsRuntimeUpgrade) return false;
  return (await stopNativeHost(root, host, 'admissions')).stopped;
}

/**
 * Lifecycle only: stop a host whose live sessions the caller found idle. The supervisor's
 * cleanup stops each idle runner and confirms it; the next host keeps their journals and
 * reports them for resume. A host that supports it fences admissions and new input first and
 * names any session still busy (sending, compacting, finishing a turn, asked). An older host
 * fences only once every runner has stopped, so the caller's own checks and admission lock
 * are all that stand between its snapshot and the stop.
 */
export function stopIdleSessionsNativeHost(
  root: string,
  host: HostIdentity,
  runners: number,
): Promise<{ stopped: boolean; busy: string[] }> {
  return stopNativeHost(
    root,
    host,
    host.supportsIdleRunnerUpgrade ? 'idle-runners' : 'none',
    nativeIdleStopCleanupMs(runners),
  );
}

/** How long a host's own cleanup may take, and how much longer each live runner adds. */
const NATIVE_HOST_CLEANUP_MS = 10_000;
/** Each runner's cleanup takes a process-tree census and two captures, each allowed 5 s. */
const NATIVE_RUNNER_CLEANUP_MS = 15_000;

/** The cleanup wait for a stop with live runners: the supervisor stops them one by one. */
export function nativeIdleStopCleanupMs(runners: number): number {
  return NATIVE_HOST_CLEANUP_MS + runners * NATIVE_RUNNER_CLEANUP_MS;
}

/** The most idle runners an execution node stops when a launch refreshes its host. */
export const NATIVE_NODE_REFRESH_MAX_RUNNERS = 6;
/** A launch to a node may first stop that many idle runners, then start the new host. */
export const NATIVE_NODE_ADMISSION_TIMEOUT_MS =
  60_000 + nativeIdleStopCleanupMs(NATIVE_NODE_REFRESH_MAX_RUNNERS);

/**
 * The supervisor's command line ends with the state directory it was started on, spelled as
 * its client resolved it. Another spelling of the same directory, through a symlink, matches.
 */
function startedOn(command: string, root: string): boolean {
  if (command.endsWith(` ${root}`)) return true;
  const real = realpathSync(root);
  // A path may contain spaces: try each suffix that starts an absolute path.
  for (let at = command.indexOf(' /'); at !== -1; at = command.indexOf(' /', at + 1)) {
    const candidate = command.slice(at + 1);
    if (existsSync(candidate) && realpathSync(candidate) === real) return true;
  }
  return false;
}

async function stopNativeHost(
  root: string,
  host: HostIdentity,
  fence: 'admissions' | 'idle-runners' | 'none',
  cleanupMs = NATIVE_HOST_CLEANUP_MS,
): Promise<{ stopped: boolean; busy: string[] }> {
  const unverified = { stopped: false, busy: [] };
  const supervisor = readJson<RecordedProcess>(join(root, 'lock', 'owner.json'));
  const worker = readJson<RecordedProcess>(join(root, 'worker.json'));
  if (
    supervisor.pid !== host.pid ||
    !supervisor.identity ||
    !worker.identity ||
    !recordedProcessAlive(supervisor) ||
    !recordedProcessAlive(worker)
  )
    return unverified;
  const command = execFileSync('ps', ['-p', String(supervisor.pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!command.includes('/native/supervisor.') || !startedOn(command, root)) return unverified;
  const current = readJson<HostIdentity>(join(root, 'host.json'));
  if (current.pid !== host.pid || current.token !== host.token) return unverified;

  if (fence !== 'none') {
    const prepared = await requestHost<{ idle: boolean; busy?: string[] }>(host, {
      method: 'prepareUpgrade',
      owner: 'node-runtime-upgrade',
      ...(fence === 'idle-runners' ? { idleRunners: true } : {}),
    });
    if (prepared.idle !== true) return { stopped: false, busy: prepared.busy ?? [] };
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      watcher.close();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const check = () => {
      try {
        if (existsSync(join(root, 'lock'))) return;
        const cleanup = readJson<{ state: string; hostPid: number }>(join(root, 'cleanup.json'));
        if (cleanup.state !== 'complete' || cleanup.hostPid !== worker.pid)
          throw new Error('Native host cleanup is unconfirmed; no replacement was started');
        finish();
      } catch (error) {
        finish(error);
      }
    };
    // Lock removal and cleanup.json publication both change direct children of root.
    const watcher = watch(root, check);
    const timeout = setTimeout(() => {
      check();
      if (!settled) finish(new Error('Native host cleanup timed out; no replacement was started'));
    }, cleanupMs);
    watcher.once('error', finish);
    try {
      process.kill(supervisor.pid, 'SIGTERM');
      check();
    } catch (error) {
      finish(error);
    }
  });
  if (recordedProcessAlive(worker))
    throw new Error('Native host cleanup is unconfirmed; previous host is still alive');
  return { stopped: true, busy: [] };
}
