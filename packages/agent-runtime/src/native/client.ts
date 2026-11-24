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
  constructor(
    root = currentFarmPaths('node').state.nativeSessions,
    readonly executionNodeId = 'local',
  ) {
    this.root = resolve(root);
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
   * Never starts a host; concurrent callers share one refresh.
   */
  refreshStaleHost(): Promise<{ refreshed: boolean; busy: string[] }> {
    this.refreshing ??= this.refreshOnce().finally(() => {
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

  /** The version-skew error, saying when this client refreshes the host on its own. */
  private skew(host: HostIdentity, busy: readonly string[]): Error {
    return nativeHostVersionSkew(
      host,
      busy,
      this.refreshPolicy
        ? 'It is refreshed at a later launch or service restart once no live session is busy.'
        : 'It is refreshed when its service next starts, once every runner has stopped.',
    );
  }

  private async refreshOnce(): Promise<{ refreshed: boolean; busy: string[] }> {
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
      this.lastBusy?.hostPid === host.pid &&
      Date.now() - this.lastBusy.at < NATIVE_REFRESH_BUSY_REUSE_MS
    )
      return this.lastBusy.result;
    // A request adding work is already on its way: stopping now could cut it off.
    if (this.inFlight)
      return this.busy(host, [`${this.inFlight} request(s) on their way to the host`]);
    if (await retireIdleNativeHost(this.root, host)) return { refreshed: true, busy: [] };
    if (!this.refreshPolicy) return { refreshed: false, busy: [] };
    const live = await this.liveSessionsOf(host);
    const kept = await this.refreshPolicy(live);
    const busy = live.flatMap((session) => {
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
    if (busy.length) return this.busy(host, busy);
    const stopped = await stopIdleSessionsNativeHost(this.root, host);
    if (stopped.stopped) return { refreshed: true, busy: [] };
    return this.busy(
      host,
      stopped.busy.length ? stopped.busy : ['the host process identity could not be verified'],
    );
  }

  private busy(host: HostIdentity, busy: string[]): { refreshed: false; busy: string[] } {
    const result = { refreshed: false as const, busy };
    this.lastBusy = { at: Date.now(), hostPid: host.pid, result };
    return result;
  }

  private async call<T>(request: HostRequest): Promise<T> {
    const passive = request.method === 'list' || passiveHostReads.getStore() === true;
    if (passive) return this.dispatch<T>(request, this.existingHost(), []);
    // Reads, interrupts, closes and answers add no work; they never wait for a refresh.
    if (!NATIVE_WORK_METHODS.includes(request.method))
      return this.dispatch<T>(request, await this.host(), []);
    await this.enterWork();
    let counted = true;
    try {
      let host = await this.host();
      let busy: string[] = [];
      if (
        this.refreshPolicy &&
        NATIVE_ADMISSION_METHODS.includes(request.method) &&
        !nativeHostRunsCurrentRuntime(host)
      ) {
        // This launch is not on its way to the old host; the refresh may stop it.
        this.inFlight -= 1;
        counted = false;
        const refresh = await this.refreshStaleHost();
        await this.enterWork();
        counted = true;
        host = await this.host();
        busy = refresh.refreshed ? [] : refresh.busy;
      }
      return await this.dispatch<T>(request, host, busy);
    } finally {
      if (counted) this.inFlight -= 1;
    }
  }

  /**
   * Count a request that adds work, once no refresh is deciding: the count is taken in the
   * same tick the wait ends, so a refresh that starts later sees it and leaves the host alone.
   */
  private async enterWork(): Promise<void> {
    // A refresh's outcome belongs to the caller that asked for it; a failure only ends this wait.
    while (this.refreshing) await this.refreshing.catch(() => undefined);
    this.inFlight += 1;
  }

  private async dispatch<T>(
    request: HostRequest,
    host: HostIdentity,
    busy: readonly string[],
  ): Promise<T> {
    if (
      (request.method === 'setApprovalMode' ||
        ('params' in request &&
          'approvalMode' in request.params &&
          request.params.approvalMode !== undefined)) &&
      !host.supportsApprovalMode
    )
      throw new Error('Native host upgrade required for per-session approval modes');
    if (
      'params' in request &&
      'profileId' in request.params &&
      request.params.profileId &&
      !host.supportsProfiles
    )
      throw new Error(
        'Native host upgrade required for account profiles; existing sessions remain available',
      );
    if (
      request.method === NATIVE_WORKER_RESUME &&
      request.params.relocation &&
      !host.supportsWorkerRelocation
    )
      throw new Error('Native host upgrade required for worker relocation');
    if (
      (request.method === NATIVE_WORKER_RESUME ||
        (request.method === NATIVE_WORKER_CANCEL && request.resumeCommandId)) &&
      !host.supportsWorkerResumeFence
    )
      throw new Error('Native host upgrade required for durable worker resume cancellation');
    if (NATIVE_WORKER_METHODS.includes(request.method) && !host.supportsWorkers)
      throw new Error(
        'Native host upgrade required for worker launch configuration; existing sessions remain available',
      );
    if (request.method === 'ensure' && !host.supportsEnsure)
      throw new Error(
        'Native host upgrade required for idempotent creation; existing sessions remain available',
      );
    if (request.method === NATIVE_WORKER_CONFIRM_STOPPED && !host.supportsWorkerStopAttestation)
      throw new Error(
        'Native host upgrade required for explicit stopped-process confirmation; existing sessions remain readable',
      );
    if (
      'params' in request &&
      'resultSchema' in request.params &&
      request.params.resultSchema &&
      !host.supportsStructuredResults
    )
      throw new Error('Native host upgrade required for schema-bound review results');
    if ('requester' in request && request.requester && !host.supportsStandaloneDelegation)
      throw new Error('Native host upgrade required for standalone requester attribution');
    if (
      ['create', 'ensure', NATIVE_WORKER_ENSURE, NATIVE_WORKER_RESUME].includes(request.method) &&
      host.conversationStreaming !== 1
    )
      throw new Error(
        'Native host upgrade required for conversation streaming before launching new work',
      );
    if (NATIVE_ADMISSION_METHODS.includes(request.method) && !nativeHostRunsCurrentRuntime(host))
      throw this.skew(host, busy);
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
