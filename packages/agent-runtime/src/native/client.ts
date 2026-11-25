import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  NativeApprovalMode,
  NativeCommandObservation,
  NativeCommandReceipt,
  NativeContextCompactionRecord,
  NativeContextCompactionRequest,
  NativeConversationCursor,
  NativeConversationUpdate,
  NativeSessionCreateParams,
  NativeSessionEnsureParams,
  NativeSessionInfo,
  NativeSessionReadResult,
  NativeSessionRequester,
  NativeSessionResponse,
  NativeSessionSendResult,
} from '@farmslot/protocol';
import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';

import { subscribeHost } from './conversation-ipc.js';
import {
  assertNativeHostRuntime,
  nativeHostRunsCurrentRuntime,
  nativeHostVersionSkew,
  retireIdleNativeHost,
  stopIdleSessionsNativeHost,
} from './host-runtime.js';
import { nativeHostUnavailableError } from './host-unavailable.js';
import { type HostIdentity, type HostRequest, requestHost } from './ipc.js';
import { currentRuntimeBuild, runtimeBuildIdentity } from './runtime-build.js';
import { alive, privateDirectory, readJson } from './storage.js';
import {
  NATIVE_WORKER_CANCEL,
  NATIVE_WORKER_CANCEL_COMMAND,
  NATIVE_WORKER_CLOSE,
  NATIVE_WORKER_COMPACT,
  NATIVE_WORKER_CONFIRM_STOPPED,
  NATIVE_WORKER_ENSURE,
  NATIVE_WORKER_INTERRUPT,
  NATIVE_WORKER_METHODS,
  NATIVE_WORKER_READ,
  NATIVE_WORKER_RESPOND,
  NATIVE_WORKER_RESUME,
  NATIVE_WORKER_SEND,
  NATIVE_WORKER_STEER,
  NATIVE_WORKER_TRANSFER,
  type NativeWorkerCancelResult,
  type NativeWorkerCancelTarget,
  type NativeWorkerLaunch,
  type NativeWorkerResumeParams,
  type NativeWorkerTarget,
} from './worker-launch.js';

const passiveHostReads = new AsyncLocalStorage<boolean>();
/** UI/history observation may use an existing host, never start a missing one. */
export function observeExistingNativeHost<T>(read: () => Promise<T>): Promise<T> {
  return passiveHostReads.run(true, read);
}

/**
 * Says which idle live sessions of a host on another runtime must keep it running, as a
 * reason per session id. A service that knows its sessions' callers sets one; without it, a
 * client refreshes only a host whose runners have all stopped.
 */
export type NativeHostRefreshPolicy = (
  sessions: NativeSessionInfo[],
) => Promise<ReadonlyMap<string, string>>;

const requestRefreshPolicies = new AsyncLocalStorage<NativeHostRefreshPolicy>();
/**
 * Runs a request under its caller's own refresh policy: an execution node gets the gateway's
 * release list with each launch, so the policy belongs to that launch, not to the client.
 */
export function withNativeHostRefreshPolicy<T>(
  policy: NativeHostRefreshPolicy,
  run: () => Promise<T>,
): Promise<T> {
  return requestRefreshPolicies.run(policy, run);
}

/**
 * A node's policy for one launch: it may stop only its owner's sessions that the gateway's run
 * census released. Any other live session keeps the host, so a stale list can only over-keep.
 */
export function releasedSessionsPolicy(
  owner: string,
  released: ReadonlySet<string>,
): NativeHostRefreshPolicy {
  return async (sessions) =>
    new Map(
      sessions.flatMap((session): [string, string][] =>
        session.ownerPrincipalId !== owner
          ? [[session.id, 'another owner']]
          : released.has(session.id)
            ? []
            : [[session.id, 'not released by the gateway']],
      ),
    );
}

/**
 * An execution node stops idle runners only under a host's idle-runner fence, and at most this
 * many, so a launch that refreshes its host finishes within its gateway's timeout.
 */
export interface NativeIdleStopLimits {
  maxRunners: number;
}

/** How long a busy census answers launches before the host is asked again. */
const NATIVE_REFRESH_BUSY_REUSE_MS = 5_000;

const NATIVE_ADMISSION_METHODS: readonly string[] = [
  'create',
  'ensure',
  NATIVE_WORKER_ENSURE,
  NATIVE_WORKER_RESUME,
  NATIVE_WORKER_TRANSFER,
];

/** Requests that start or change runner work; a refresh never stops a host under one. */
const NATIVE_WORK_METHODS: readonly string[] = [
  ...NATIVE_ADMISSION_METHODS,
  'send',
  'steer',
  'setApprovalMode',
  NATIVE_WORKER_SEND,
  NATIVE_WORKER_STEER,
  NATIVE_WORKER_COMPACT,
];

/** A session journal's owner, from its first line (the session's info record). */
async function journalOwner(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    // Removed since the directory was read: nothing to count.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const lines = handle.readLines({ start: 0 });
    for await (const line of lines) {
      lines.close();
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch (error) {
        // A torn first line has no session in it yet, as the host's own reader treats it.
        if (error instanceof SyntaxError) return undefined;
        throw error;
      }
      if (!record || typeof record !== 'object' || !('info' in record)) return undefined;
      const info: unknown = record.info;
      return info && typeof info === 'object' && 'ownerPrincipalId' in info
        ? typeof info.ownerPrincipalId === 'string'
          ? info.ownerPrincipalId
          : undefined
        : undefined;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

/** The same client is usable by gateway and execution-node services. */
export class NativeSessionClient {
  readonly root: string;
  private starting?: Promise<HostIdentity>;
  private refreshPolicy?: NativeHostRefreshPolicy;
  private refreshing?: Promise<{ refreshed: boolean; busy: string[] }>;
  /** A refresh that found the host busy, reused briefly so launches don't re-census it each time. */
  private lastBusy?: { at: number; hostPid: number; result: { refreshed: false; busy: string[] } };
  /** Requests adding work that are on their way to the host; any of them holds a refresh. */
  private inFlight = 0;
  /** Journal file name to owner: each journal's first line is read once. */
  private readonly journalOwners = new Map<string, string>();
  /** Whether this process runs older code than its checkout, rechecked at most every 5 s. */
  private checkoutChecked?: { at: number; older: boolean };
  /**
   * @param checkoutBuild The runtime build in the checkout on disk, which a new host would run.
   */
  constructor(
    root = currentFarmPaths('node').state.nativeSessions,
    readonly executionNodeId = 'local',
    private readonly checkoutBuild: () => string = runtimeBuildIdentity,
    private readonly idleStopLimits?: NativeIdleStopLimits,
  ) {
    this.root = resolve(root);
    // This process's build is read now, before a checkout update can change the files under it.
    currentRuntimeBuild();
  }
  /** Public target metadata only; never starts a host or exposes its IPC credential. */
  metadata() {
    let supportsStandaloneDelegation = true;
    let supportsWorkerCompaction = true;
    const file = join(this.root, 'host.json');
    if (existsSync(file) && existsSync(join(this.root, 'ready.json'))) {
      try {
        const host = readJson<HostIdentity>(file);
        this.assertHostNode(host);
        if (alive(host.pid) && existsSync(host.socket)) {
          supportsStandaloneDelegation = host.supportsStandaloneDelegation === true;
          supportsWorkerCompaction = host.supportsWorkerCompaction === true;
        }
      } catch {
        // Corrupt private metadata must not leak credential-bearing JSON parse errors.
        throw Object.assign(new Error('Native host metadata is unavailable'), {
          code: 'NATIVE_SOURCE_UNAVAILABLE',
        });
      }
    }
    return { homeDirectory: homedir(), supportsStandaloneDelegation, supportsWorkerCompaction };
  }
  workerStateDirectory(owner: string, sessionId: string): string {
    return join(this.root, 'workers', createHash('sha256').update(owner).digest('hex'), sessionId);
  }
  prepareWorkerState(owner: string, sessionId: string): string {
    const state = this.workerStateDirectory(owner, sessionId);
    for (const directory of [this.root, join(this.root, 'workers'), resolve(state, '..'), state])
      privateDirectory(directory);
    return state;
  }
  subscribe(
    owner: string,
    id: string,
    after: NativeConversationCursor | undefined,
    deliver: (update: NativeConversationUpdate) => void,
    leaseId?: string,
    generation?: string,
  ) {
    const host = this.existingHost();
    if (host.conversationStreaming !== 1)
      throw Object.assign(new Error('Native host upgrade required for conversation streaming'), {
        code: 'NATIVE_SOURCE_UNAVAILABLE',
      });
    return subscribeHost(
      host,
      { method: 'subscribe', owner, id, after, leaseId, generation },
      deliver,
    );
  }
  async inspect(owner: string, id: string): Promise<NativeSessionInfo> {
    const host = this.existingHost();
    if (host.conversationStreaming !== 1)
      throw new Error('Native host upgrade required for passive session metadata');
    return requestHost(host, { method: 'inspect', owner, id });
  }
  async commandStatus(
    owner: string,
    id: string,
    commandId: string,
    waitForAcceptance = false,
  ): Promise<NativeCommandObservation> {
    const host = this.existingHost();
    if (host.conversationStreaming !== 1)
      throw new Error('Native host upgrade required for passive command receipts');
    return requestHost(host, { method: 'commandStatus', owner, id, commandId, waitForAcceptance });
  }
  private existingHost(): HostIdentity {
    const file = join(this.root, 'host.json');
    if (!existsSync(file))
      throw Object.assign(new Error('Native host unavailable; refresh it from the login context'), {
        code: 'NATIVE_SOURCE_UNAVAILABLE',
      });
    const host = readJson<HostIdentity>(file);
    this.assertHostNode(host);
    if (!existsSync(join(this.root, 'ready.json')) || !alive(host.pid) || !existsSync(host.socket))
      throw Object.assign(new Error('Native host unavailable; refresh it from the login context'), {
        code: 'NATIVE_SOURCE_UNAVAILABLE',
      });
    return host;
  }

  private async host(): Promise<HostIdentity> {
    privateDirectory(this.root);
    const path = join(this.root, 'host.json');
    if (existsSync(path)) {
      const host = readJson<HostIdentity>(path);
      this.assertHostNode(host);
      if (alive(host.pid) && existsSync(join(this.root, 'ready.json')) && existsSync(host.socket))
        return host;
    }
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  private assertHostNode(host: HostIdentity) {
    if ((host.executionNodeId ?? 'local') !== this.executionNodeId)
      throw new Error('Native state directory belongs to another execution node');
  }
  private async start(): Promise<HostIdentity> {
    privateDirectory(this.root);
    // A prebuilt CLI snapshot runs the .js built beside each source: start the supervisor from
    // its source with TSX, as when this module itself runs from source.
    const running = fileURLToPath(import.meta.url);
    const source = running.endsWith('.ts') || existsSync(running.replace(/\.js$/, '.ts'));
    const entry = fileURLToPath(new URL(`./supervisor.${source ? 'ts' : 'js'}`, import.meta.url));
    const args = source
      ? ['--import', import.meta.resolve('tsx'), entry, this.root]
      : [entry, this.root];
    const log = openSync(join(this.root, 'host.log'), 'a', 0o600);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, FARMSLOT_NATIVE_EXECUTION_NODE_ID: this.executionNodeId },
    });
    closeSync(log);
    child.unref();
    let spawnError: Error | undefined;
    let exited = false;
    child.on('error', (error) => {
      spawnError = error;
    });
    child.once('exit', () => {
      exited = true;
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      const path = join(this.root, 'host.json');
      if (existsSync(path)) {
        const host = readJson<HostIdentity>(path);
        this.assertHostNode(host);
        if (alive(host.pid) && existsSync(join(this.root, 'ready.json')) && existsSync(host.socket))
          return host;
      }
      // A clean exit can hand off to another supervisor still starting. An abnormal
      // exit of our child cannot become ready; keep the live-start ceiling unchanged.
      if (exited && child.exitCode !== 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw nativeHostUnavailableError(join(this.root, 'host.log'));
  }
  /** Explicit lifecycle operation. Deployment invokes it from the login/GUI context. */
  async warm(): Promise<void> {
    const host = await this.host();
    if (nativeHostRunsCurrentRuntime(host)) return;
    const { refreshed, busy } = await this.refreshStaleHost();
    if (!refreshed) throw this.skew(host, busy);
    assertNativeHostRuntime(await this.host());
  }

  /** Lets idle live sessions be stopped for a refresh, except those the policy keeps. */
  setRefreshPolicy(policy: NativeHostRefreshPolicy): void {
    this.refreshPolicy = policy;
  }

  /**
   * Refresh a running host on another runtime, so new launches get the current one. It is
   * retired once its runners have all stopped, or, under a refresh policy, when every live
   * session is idle and the policy keeps none: those runners are stopped, their journals kept,
   * and the next host reports them for resume. Returns the sessions that keep it running.
   * Never starts a host. Concurrent callers share one refresh; a caller's own `policy` waits for
   * it and then runs its own.
   */
  refreshStaleHost(
    policy?: NativeHostRefreshPolicy,
  ): Promise<{ refreshed: boolean; busy: string[] }> {
    if (policy) return this.refreshUnder(policy);
    this.refreshing ??= this.refreshOnce(this.refreshPolicy, false).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /**
   * A refresh under a caller's own policy runs after any other and answers from a fresh census,
   * never from another policy's result.
   */
  private async refreshUnder(
    policy: NativeHostRefreshPolicy,
  ): Promise<{ refreshed: boolean; busy: string[] }> {
    // A refresh's outcome belongs to the caller that asked for it; a failure only ends this wait.
    while (this.refreshing) await this.refreshing.catch(() => undefined);
    this.refreshing = this.refreshOnce(policy, true).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** The running host's sessions whose runner is still live, for every owner; never starts one. */
  liveSessions(): Promise<NativeSessionInfo[]> {
    return this.liveSessionsOf(this.existingHost());
  }

  private async liveSessionsOf(host: HostIdentity): Promise<NativeSessionInfo[]> {
    const directory = join(this.root, 'sessions');
    const names = existsSync(directory)
      ? (await readdir(directory)).filter((name) => name.endsWith('.journal'))
      : [];
    const present = new Set(names);
    for (const name of this.journalOwners.keys())
      if (!present.has(name)) this.journalOwners.delete(name);
    for (const name of names)
      if (!this.journalOwners.has(name)) {
        const owner = await journalOwner(join(directory, name));
        if (owner) this.journalOwners.set(name, owner);
      }
    const live: NativeSessionInfo[] = [];
    for (const owner of new Set(names.map((name) => this.journalOwners.get(name))))
      if (owner)
        for (const session of await requestHost<NativeSessionInfo[]>(host, {
          method: 'list',
          owner,
        }))
          if (!session.processStopped) live.push(session);
    return live;
  }

  /**
   * This service runs code older than its own checkout (updated, not yet restarted): a new host
   * would start from the checkout and be skewed too. Hashing the checkout takes about 10 ms.
   */
  private olderThanCheckout(): boolean {
    const now = Date.now();
    if (!this.checkoutChecked || now - this.checkoutChecked.at >= NATIVE_REFRESH_BUSY_REUSE_MS)
      this.checkoutChecked = { at: now, older: this.checkoutBuild() !== currentRuntimeBuild() };
    return this.checkoutChecked.older;
  }

  /** The version-skew error, saying when the host is refreshed. */
  private skew(host: HostIdentity, busy: readonly string[], capability?: string): Error {
    if (this.olderThanCheckout())
      return nativeHostVersionSkew(
        host,
        [],
        'This service runs older code than its checkout: restart it to take the new runtime and refresh the host.',
      );
    return nativeHostVersionSkew(
      host,
      busy,
      (this.refreshPolicy || requestRefreshPolicies.getStore()
        ? 'It is refreshed at a later launch or service restart once no live session is busy.'
        : 'It is refreshed when its service next starts, once every runner has stopped.') +
        (capability ? ` ${capability}.` : ''),
    );
  }

  private async refreshOnce(
    policy: NativeHostRefreshPolicy | undefined,
    requestPolicy: boolean,
  ): Promise<{ refreshed: boolean; busy: string[] }> {
    let host: HostIdentity;
    try {
      host = this.existingHost();
    } catch (error) {
      // No running host: the next launch starts the current runtime.
      if (error instanceof Error && 'code' in error && error.code === 'NATIVE_SOURCE_UNAVAILABLE')
        return { refreshed: false, busy: [] };
      throw error;
    }
    if (nativeHostRunsCurrentRuntime(host)) return { refreshed: false, busy: [] };
    if (
      !requestPolicy &&
      this.lastBusy?.hostPid === host.pid &&
      Date.now() - this.lastBusy.at < NATIVE_REFRESH_BUSY_REUSE_MS
    )
      return this.lastBusy.result;
    // Stopping the host helps nothing: its replacement would be skewed too. The skew error
    // says to restart the service.
    if (this.olderThanCheckout()) return { refreshed: false, busy: [] };
    // A request adding work is already on its way: stopping now could cut it off. It ends
    // soon, so this answer is not reused like a census.
    if (this.inFlight)
      return { refreshed: false, busy: [`${this.inFlight} request(s) on their way to the host`] };
    if (await retireIdleNativeHost(this.root, host)) return { refreshed: true, busy: [] };
    if (!policy) return { refreshed: false, busy: [] };
    const live = await this.liveSessionsOf(host);
    const kept = await policy(live);
    const busy = live.flatMap((session) => {
      // A live runner (processStopped unset) whose session isn't idle is busy, whatever its
      // state: a closed or failed one still has a process to reconcile.
      const reason =
        session.state !== 'idle'
          ? session.state
          : session.approvalModePending
            ? 'approval mode change pending'
            : session.contextCompactions?.some((row) => row.status === 'pending')
              ? 'compacting'
              : kept.get(session.id);
      return reason ? [`${session.id} (${reason})`] : [];
    });
    if (busy.length) return this.busy(host, busy, requestPolicy);
    if (this.idleStopLimits) {
      // The unfenced stop of an older host relies on this process's admission lock alone, and a
      // restarted node can't see launches the host still holds from before.
      if (!host.supportsIdleRunnerUpgrade)
        return this.busy(
          host,
          [
            'the host predates the idle-runner fence: it is refreshed once every runner has stopped',
          ],
          requestPolicy,
        );
      if (live.length > this.idleStopLimits.maxRunners)
        return this.busy(
          host,
          [
            `${live.length} idle runners, more than the ${this.idleStopLimits.maxRunners} a launch may stop`,
          ],
          requestPolicy,
        );
    }
    const stopped = await stopIdleSessionsNativeHost(this.root, host, live.length);
    if (stopped.stopped) return { refreshed: true, busy: [] };
    return this.busy(
      host,
      stopped.busy.length ? stopped.busy : ['the host process identity could not be verified'],
      requestPolicy,
    );
  }

  /** A busy result; only a census under the client's policy answers later launches for 5 s. */
  private busy(
    host: HostIdentity,
    busy: string[],
    requestPolicy: boolean,
  ): { refreshed: false; busy: string[] } {
    const result = { refreshed: false as const, busy };
    if (!requestPolicy) this.lastBusy = { at: Date.now(), hostPid: host.pid, result };
    return result;
  }

  private async call<T>(request: HostRequest): Promise<T> {
    const passive = request.method === 'list' || passiveHostReads.getStore() === true;
    if (passive) return this.dispatch<T>(request, this.existingHost(), []);
    // Reads, interrupts, closes and answers add no work; they never wait for a refresh.
    if (!NATIVE_WORK_METHODS.includes(request.method))
      return this.dispatch<T>(request, await this.host(), []);
    let host: HostIdentity | undefined;
    const requestPolicy = requestRefreshPolicies.getStore();
    if (
      (requestPolicy ?? this.refreshPolicy) &&
      NATIVE_ADMISSION_METHODS.includes(request.method)
    ) {
      // A launch checks the host before it counts itself: it never goes to an old host, so
      // it must not hold that host's refresh, nor another launch's. A refresh's outcome
      // belongs to the caller that asked for it, so its error is not this launch's; the
      // launch reads the host again below.
      while (this.refreshing) await this.refreshing.catch(() => undefined);
      host = await this.host();
      if (!nativeHostRunsCurrentRuntime(host)) {
        const refresh = await this.refreshStaleHost(requestPolicy);
        // A stopped or vanished host is replaced by a current one; a skewed host refuses
        // before any request reaches it.
        host = await this.host();
        if (!nativeHostRunsCurrentRuntime(host))
          return this.dispatch<T>(request, host, refresh.busy);
      }
    }
    // A refresh that ran while this request waited may have stopped the host read above.
    if (await this.enterWork()) host = undefined;
    try {
      return await this.dispatch<T>(request, host ?? (await this.host()), []);
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * Count a request that adds work, once no refresh is deciding: the count is taken in the
   * same tick the wait ends, so a refresh that starts later sees it and leaves the host alone.
   * Returns whether it waited for a refresh.
   */
  private async enterWork(): Promise<boolean> {
    const waited = this.refreshing !== undefined;
    // A refresh's outcome belongs to the caller that asked for it; a failure only ends this wait.
    while (this.refreshing) await this.refreshing.catch(() => undefined);
    this.inFlight += 1;
    return waited;
  }

  /** What the host lacks for this request, as the error to raise. */
  private missingCapability(request: HostRequest, host: HostIdentity): string | undefined {
    if (
      (request.method === 'setApprovalMode' ||
        ('params' in request &&
          'approvalMode' in request.params &&
          request.params.approvalMode !== undefined)) &&
      !host.supportsApprovalMode
    )
      return 'Native host upgrade required for per-session approval modes';
    if (
      'params' in request &&
      'profileId' in request.params &&
      request.params.profileId &&
      !host.supportsProfiles
    )
      return 'Native host upgrade required for account profiles; existing sessions remain available';
    if (
      request.method === NATIVE_WORKER_RESUME &&
      request.params.relocation &&
      !host.supportsWorkerRelocation
    )
      return 'Native host upgrade required for worker relocation';
    if (
      (request.method === NATIVE_WORKER_RESUME ||
        (request.method === NATIVE_WORKER_CANCEL && request.resumeCommandId)) &&
      !host.supportsWorkerResumeFence
    )
      return 'Native host upgrade required for durable worker resume cancellation';
    if (NATIVE_WORKER_METHODS.includes(request.method) && !host.supportsWorkers)
      return 'Native host upgrade required for worker launch configuration; existing sessions remain available';
    if (request.method === 'ensure' && !host.supportsEnsure)
      return 'Native host upgrade required for idempotent creation; existing sessions remain available';
    if (request.method === NATIVE_WORKER_CONFIRM_STOPPED && !host.supportsWorkerStopAttestation)
      return 'Native host upgrade required for explicit stopped-process confirmation; existing sessions remain readable';
    if (
      'params' in request &&
      'resultSchema' in request.params &&
      request.params.resultSchema &&
      !host.supportsStructuredResults
    )
      return 'Native host upgrade required for schema-bound review results';
    if ('requester' in request && request.requester && !host.supportsStandaloneDelegation)
      return 'Native host upgrade required for standalone requester attribution';
    if (
      ['create', 'ensure', NATIVE_WORKER_ENSURE, NATIVE_WORKER_RESUME].includes(request.method) &&
      host.conversationStreaming !== 1
    )
      return 'Native host upgrade required for conversation streaming before launching new work';
    return undefined;
  }

  private async dispatch<T>(
    request: HostRequest,
    host: HostIdentity,
    busy: readonly string[],
  ): Promise<T> {
    const missing = this.missingCapability(request, host);
    // A launch to a host on another runtime is refused as skew, which its refresh fixes, even
    // when that host also lacks a capability the launch needs.
    if (NATIVE_ADMISSION_METHODS.includes(request.method) && !nativeHostRunsCurrentRuntime(host))
      throw this.skew(host, busy, missing);
    if (missing) throw new Error(missing);
    const result = await requestHost<T>(host, request);
    if ('params' in request && request.params.profileId) {
      const session = result as NativeSessionInfo;
      if (
        session.profileId !== request.params.profileId ||
        session.accountContextId !== request.params.accountContextId
      )
        throw new Error('Native host returned a different account profile binding');
    }
    return result;
  }
  create(owner: string, params: NativeSessionCreateParams, requester?: NativeSessionRequester) {
    if (params.executionNodeId !== undefined && params.executionNodeId !== this.executionNodeId)
      throw new Error('Native session targets another execution node');
    return this.call<NativeSessionInfo>({ method: 'create', owner, params, requester });
  }
  ensure(owner: string, params: NativeSessionEnsureParams, requester?: NativeSessionRequester) {
    if (params.executionNodeId !== undefined && params.executionNodeId !== this.executionNodeId)
      throw new Error('Native session targets another execution node');
    return this.call<NativeSessionInfo>({ method: 'ensure', owner, params, requester });
  }
  ensureWorker(owner: string, params: NativeSessionEnsureParams, launch: NativeWorkerLaunch) {
    if (params.executionNodeId !== undefined && params.executionNodeId !== this.executionNodeId)
      throw new Error('Native worker targets another execution node');
    return this.call<NativeSessionInfo>({ method: NATIVE_WORKER_ENSURE, owner, params, launch });
  }
  resumeWorker(owner: string, params: NativeWorkerResumeParams, launch: NativeWorkerLaunch) {
    if (params.executionNodeId !== undefined && params.executionNodeId !== this.executionNodeId)
      throw new Error('Native worker targets another execution node');
    return this.call<NativeSessionInfo>({ method: NATIVE_WORKER_RESUME, owner, params, launch });
  }
  private workerTarget(target: NativeWorkerTarget) {
    if (target.executionNodeId !== undefined && target.executionNodeId !== this.executionNodeId)
      throw new Error('Native worker targets another execution node');
    return { id: target.sessionId, generation: target.generation, leaseId: target.leaseId };
  }
  transferWorker(owner: string, target: NativeWorkerTarget, launch: NativeWorkerLaunch) {
    return this.call<NativeSessionInfo>({
      method: NATIVE_WORKER_TRANSFER,
      owner,
      ...this.workerTarget(target),
      launch,
    });
  }
  sendWorker(owner: string, target: NativeWorkerTarget, commandId: string, text: string) {
    return this.call<NativeSessionSendResult>({
      method: NATIVE_WORKER_SEND,
      owner,
      ...this.workerTarget(target),
      commandId,
      text,
    });
  }
  compact(owner: string, target: NativeWorkerTarget, compaction: NativeContextCompactionRequest) {
    const worker = this.workerTarget(target);
    if (!this.metadata().supportsWorkerCompaction)
      return Promise.resolve<NativeContextCompactionRecord>({
        operationId: compaction.operationId,
        lineageId: compaction.lineageId,
        packetDigest: compaction.packetDigest,
        nativeSessionId: compaction.nativeSessionId,
        focusSha256: createHash('sha256').update(compaction.focus).digest('hex'),
        status: 'unsupported',
        requestedAt: new Date().toISOString(),
        reason: 'Native host does not support structured context compaction',
      });
    return this.call<NativeContextCompactionRecord>({
      method: NATIVE_WORKER_COMPACT,
      owner,
      ...worker,
      compaction,
    });
  }
  steerWorker(owner: string, target: NativeWorkerTarget, commandId: string, text: string) {
    return this.call<NativeSessionSendResult>({
      method: NATIVE_WORKER_STEER,
      owner,
      ...this.workerTarget(target),
      commandId,
      text,
    });
  }
  cancelCommandWorker(owner: string, target: NativeWorkerTarget, commandId: string) {
    return this.call<NativeCommandReceipt>({
      method: NATIVE_WORKER_CANCEL_COMMAND,
      owner,
      ...this.workerTarget(target),
      commandId,
    });
  }
  closeWorker(owner: string, target: NativeWorkerTarget) {
    return this.call<NativeSessionInfo>({
      method: NATIVE_WORKER_CLOSE,
      owner,
      ...this.workerTarget(target),
    });
  }
  interruptWorker(owner: string, target: NativeWorkerTarget) {
    return this.call<void>({
      method: NATIVE_WORKER_INTERRUPT,
      owner,
      ...this.workerTarget(target),
    });
  }
  confirmWorkerStopped(owner: string, target: NativeWorkerTarget) {
    return this.call<NativeSessionInfo>({
      method: NATIVE_WORKER_CONFIRM_STOPPED,
      owner,
      ...this.workerTarget(target),
    });
  }
  cancelWorker(owner: string, target: NativeWorkerCancelTarget) {
    if (target.executionNodeId !== undefined && target.executionNodeId !== this.executionNodeId)
      throw new Error('Native worker targets another execution node');
    return this.call<NativeWorkerCancelResult>({
      method: NATIVE_WORKER_CANCEL,
      owner,
      id: target.sessionId,
      generation: target.generation,
      leaseId: target.leaseId,
      sourceLeaseId: target.sourceLeaseId,
      resumeCommandId: target.resumeCommandId,
    });
  }
  respondWorker(
    owner: string,
    target: NativeWorkerTarget,
    requestId: string,
    response: NativeSessionResponse,
  ) {
    return this.call<void>({
      method: NATIVE_WORKER_RESPOND,
      owner,
      ...this.workerTarget(target),
      requestId,
      response,
    });
  }
  list(owner: string) {
    if (!existsSync(join(this.root, 'host.json')) && !existsSync(join(this.root, 'sessions')))
      return Promise.resolve([]);
    return this.call<NativeSessionInfo[]>({ method: 'list', owner });
  }
  read(owner: string, id: string, after?: number, limit?: number) {
    return this.call<NativeSessionReadResult>({ method: 'read', owner, id, after, limit });
  }
  readWorker(
    owner: string,
    id: string,
    leaseId: string,
    after?: number,
    limit?: number,
    generation?: string,
  ) {
    return this.call<NativeSessionReadResult>({
      method: NATIVE_WORKER_READ,
      owner,
      id,
      leaseId,
      generation,
      after,
      limit,
    });
  }
  send(owner: string, id: string, commandId: string, text: string) {
    return this.call<NativeSessionSendResult>({ method: 'send', owner, id, commandId, text });
  }
  /** An older host refuses this as an unknown method instead of queueing the message. */
  steer(owner: string, id: string, commandId: string, text: string) {
    return this.call<NativeSessionSendResult>({ method: 'steer', owner, id, commandId, text });
  }
  /** An older host refuses this as an unknown method. */
  cancelCommand(owner: string, id: string, commandId: string) {
    return this.call<NativeCommandReceipt>({ method: 'cancelCommand', owner, id, commandId });
  }
  respond(owner: string, id: string, requestId: string, response: NativeSessionResponse) {
    return this.call<void>({ method: 'respond', owner, id, requestId, response });
  }
  setApprovalMode(owner: string, id: string, approvalMode: NativeApprovalMode) {
    return this.call<NativeSessionInfo>({ method: 'setApprovalMode', owner, id, approvalMode });
  }
  interrupt(owner: string, id: string) {
    return this.call<void>({ method: 'interrupt', owner, id });
  }
  close(owner: string, id: string) {
    return this.call<void>({ method: 'close', owner, id });
  }
}
