import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  NativeCommandReceipt,
  NativeProfileInfo,
  NativeSessionCreateParams,
  NativeSessionEnsureParams,
  NativeSessionEvent,
  NativeSessionInfo,
  NativeSessionResponse,
  NativeSessionSendResult,
} from '@farmslot/protocol';

import {
  assertNativeProfileCurrent,
  nativeProfileEnvironment,
  requireNativeProfile,
} from './account-profiles.js';
import { nativeRunnerDefinitions as adapters } from './registry.js';
import { hostReviewSandboxAvailable, reviewProcessSandbox } from './review-sandbox.js';
import { durableWrite, privateDirectory, readJournal, readJson } from './storage.js';
import type { NativeAdapterSession, NativeEventInput } from './types.js';
import { NativeWorkerHistory } from './worker-history.js';
import {
  type NativeWorkerCancelResult,
  nativeWorkerEnvironment,
  type NativeWorkerLaunch,
  nativeWorkerLaunchDigest,
  type NativeWorkerResumeParams,
  validateNativeWorkerFilesystemPolicy,
} from './worker-launch.js';

const exec = promisify(execFile);

export async function resolveNativeExecutable(
  binary: string,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ executable: string; version: string }> {
  let executable: string | undefined;
  const requested = binary.startsWith('~/')
    ? join(environment.HOME ?? homedir(), binary.slice(2))
    : binary;
  const candidates = isAbsolute(requested)
    ? [requested]
    : requested.includes('/')
      ? [resolve(cwd, requested)]
      : (environment.PATH ?? '')
          .split(delimiter)
          .map((directory) => resolve(cwd, directory, requested));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
    } catch (error) {
      if (['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        continue;
      throw error;
    }
    if (candidate.includes('/.asdf/shims/')) {
      try {
        const resolved = await exec('asdf', ['which', basename(binary)], {
          cwd,
          timeout: 10_000,
          env: environment,
        });
        executable = resolved.stdout.trim();
      } catch (error) {
        // Fresh worktrees may not select the shim's runtime. For a PATH lookup,
        // continue to another installed executable; explicit paths remain exact.
        if (
          (error as { code?: unknown }).code === 1 &&
          !isAbsolute(requested) &&
          !requested.includes('/')
        )
          continue;
        throw error;
      }
    } else executable = candidate;
    break;
  }
  if (!executable) throw new Error(`Install and log into the native ${binary} runner first`);
  executable = await realpath(executable);
  const result = await exec(executable, ['--version'], {
    cwd,
    timeout: 10_000,
    env: nativeEnvironment(executable, environment),
  });
  const version = result.stdout.trim();
  if (!version) throw new Error('Native executable did not provide version metadata');
  return { executable, version };
}

function executionContext(
  workerLaunch?: NativeWorkerLaunch,
  runner?: string,
  profile?: NativeProfileInfo,
): Record<string, string> {
  const environment = profile
    ? nativeProfileEnvironment(
        profile,
        workerLaunch ? nativeWorkerEnvironment(workerLaunch) : process.env,
      )
    : process.env;
  return {
    home: profile ? (environment.HOME ?? homedir()) : homedir(),
    codexHome: environment.CODEX_HOME ?? '',
    claudeConfigDir: environment.CLAUDE_CONFIG_DIR ?? '',
    ...(runner === 'cursor'
      ? {
          cursorConfigDir: environment.CURSOR_CONFIG_DIR ?? '',
          cursorDataDir: environment.CURSOR_DATA_DIR ?? '',
          xdgConfigHome: environment.XDG_CONFIG_HOME ?? '',
        }
      : {}),
    ...(runner === 'grok' ? { grokHome: environment.GROK_HOME ?? '' } : {}),
    ...(workerLaunch ? { workerLaunchDigest: nativeWorkerLaunchDigest(workerLaunch) } : {}),
    ...(profile
      ? {
          profileId: profile.id,
          profileDirectory: profile.directory,
          profileAccountContextId: profile.accountContextId,
        }
      : {}),
  };
}
function nativeEnvironment(
  executable: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Native configuration may reference environment credentials. Inherit it in-process only;
  // never persist or send it over IPC. Remove parent Claude invocation context.
  const env: NodeJS.ProcessEnv = {
    ...base,
    PATH: `${dirname(executable)}${delimiter}${base.PATH ?? ''}`,
  };
  delete env.CLAUDECODE;
  return env;
}
interface StoredCommand extends NativeCommandReceipt {
  text: string;
}
interface JournalEntry {
  info?: NativeSessionInfo;
  context?: Record<string, string>;
  commands?: StoredCommand[];
  pending?: NativeSessionEvent[];
  event?: NativeSessionEvent;
}
interface SessionRecord {
  workerHistory: NativeWorkerHistory;
  info: NativeSessionInfo;
  events: NativeSessionEvent[];
  adapter?: NativeAdapterSession;
  startup?: Promise<NativeAdapterSession>;
  startupAbort?: AbortController;
  /** An uncertain initial journal write cannot become a successful retry in this host. */
  reservationError?: Error;
  workerLeaseError?: Error;
  // Retain receipts for the session lifetime so old command IDs stay idempotent.
  commands: Map<string, StoredCommand>;
  pendingRequests: Map<string, NativeSessionEvent>;
  context: Record<string, string>;
  sending: boolean;
}

/** Runs only inside the local host. Synchronous fsync orders intent before native input. */
export class NativeSessionManager {
  private sessions = new Map<string, SessionRecord>();
  private persisted = new WeakMap<
    SessionRecord,
    { info?: string; context?: string; pending?: string; commands: Map<string, string> }
  >();

  constructor(
    private readonly root: string,
    private readonly executionNodeId = 'local',
  ) {
    privateDirectory(root);
    for (const name of readdirSync(root).filter((name) => name.endsWith('.journal'))) {
      const path = join(root, name);
      const entries = readJournal(path).map((line) => JSON.parse(line) as JournalEntry);
      // The first durable record precedes process launch; a torn first write owned no input.
      if (!entries.length) continue;
      let info: NativeSessionInfo | undefined;
      let context: Record<string, string> | undefined;
      let pending: NativeSessionEvent[] = [];
      const commands = new Map<string, StoredCommand>();
      const events: NativeSessionEvent[] = [];
      const workerHistory = new NativeWorkerHistory();
      for (const entry of entries) {
        workerHistory.observe(entry);
        info = entry.info ?? info;
        context = entry.context ?? context;
        pending = entry.pending ?? pending;
        for (const command of entry.commands ?? []) commands.set(command.commandId, command);
        if (entry.event) events.push(entry.event);
      }
      if (!info || !context) throw new Error('Native journal has no durable session identity');
      if (info.executionNodeId !== executionNodeId)
        throw new Error('Native journal belongs to another execution node');
      const record: SessionRecord = {
        workerHistory,
        info,
        context,
        commands,
        events,
        pendingRequests: new Map(pending.map((event) => [event.request!.id, event])),
        sending: false,
      };
      this.persisted.set(record, {
        info: JSON.stringify(info),
        context: JSON.stringify(context),
        pending: JSON.stringify(pending),
        commands: new Map([...commands].map(([id, command]) => [id, JSON.stringify(command)])),
      });
      this.sessions.set(record.info.id, record);
      if (!['closed', 'failed'].includes(record.info.state)) {
        record.info.state = 'failed';
        record.info.recovery =
          'Native host stopped. Verify the old process group is stopped, then explicitly resume the saved native identity.';
        for (const command of record.commands.values())
          if (command.state === 'pending') command.state = 'unknown';
        this.append(record, {
          type: 'session.closed',
          status: 'failed',
          text: record.info.recovery,
        });
      }
    }
  }
  private persist(record: SessionRecord, event?: NativeSessionEvent): void {
    const previous = this.persisted.get(record) ?? { commands: new Map<string, string>() };
    const info = JSON.stringify(record.info);
    const context = JSON.stringify(record.context);
    const pending = JSON.stringify([...record.pendingRequests.values()]);
    const commands = [...record.commands.values()].filter(
      (command) => previous.commands.get(command.commandId) !== JSON.stringify(command),
    );
    const entry: JournalEntry = {
      ...(info !== previous.info ? { info: record.info } : {}),
      ...(context !== previous.context ? { context: record.context } : {}),
      ...(pending !== previous.pending ? { pending: [...record.pendingRequests.values()] } : {}),
      ...(commands.length ? { commands } : {}),
      event,
    };
    if (!event && !entry.info && !entry.context && !entry.pending && !entry.commands) return;
    const fd = openSync(join(this.root, `${record.info.id}.journal`), 'a', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const directory = openSync(this.root, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    for (const command of commands)
      previous.commands.set(command.commandId, JSON.stringify(command));
    this.persisted.set(record, { info, context, pending, commands: previous.commands });
    record.workerHistory.observe(entry);
  }
  create(
    owner: string,
    params: NativeSessionCreateParams,
    workerLaunch?: NativeWorkerLaunch,
  ): Promise<NativeSessionInfo> {
    return this.start(owner, params, undefined, workerLaunch);
  }

  async ensure(
    owner: string,
    params: NativeSessionEnsureParams,
    workerLaunch?: NativeWorkerLaunch,
  ): Promise<NativeSessionInfo> {
    if (
      typeof params.sessionId !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(params.sessionId)
    )
      throw new Error('Reserved sessionId must be a lowercase UUID');
    if ('resumeSessionId' in params && params.resumeSessionId !== undefined)
      throw new Error('Reserved sessionId is for initial creation, not resume');
    return this.start(owner, params, params.sessionId, workerLaunch);
  }

  resumeWorker(
    owner: string,
    params: NativeWorkerResumeParams,
    launch: NativeWorkerLaunch,
  ): Promise<NativeSessionInfo> {
    const assertCurrent = () => {
      this.assertWorkerLease(owner, params.sessionId, params.generation, launch.leaseId, true);
      const record = this.owned(owner, params.sessionId);
      if (record.info.nativeSessionId !== params.resumeSessionId)
        throw new Error('Worker recovery must preserve its recorded session identity');
      if (
        existsSync(this.resumeCancellationPath(params.sessionId, launch.leaseId, params.commandId))
      )
        throw new Error('Native worker recovery operation was cancelled before launch');
    };
    return this.start(owner, params, undefined, launch, assertCurrent, params.relocation);
  }

  private async start(
    ownerPrincipalId: string,
    params: NativeSessionCreateParams,
    reservedId?: string,
    workerLaunch?: NativeWorkerLaunch,
    assertResumeCurrent?: () => void,
    relocation?: NativeWorkerResumeParams['relocation'],
  ): Promise<NativeSessionInfo> {
    assertResumeCurrent?.();
    const profile = params.profileId
      ? requireNativeProfile(params.profileId, params.runner)
      : undefined;
    if (profile && params.accountContextId !== profile.accountContextId)
      throw new Error('Native account profile changed; select its current account binding');
    if (params.executionNodeId !== undefined && params.executionNodeId !== this.executionNodeId)
      throw new Error('Native session targets another execution node');
    if (reservedId !== undefined) {
      const existing = this.existingCreation(ownerPrincipalId, params, reservedId, workerLaunch);
      if (existing) return this.createdSession(existing);
      if (workerLaunch) this.assertWorkerNotCancelled(reservedId);
    }
    const transport = adapters[params.runner];
    if (!transport) throw new Error(`Runner has no native transport: ${params.runner}`);
    if (workerLaunch && !transport.supportsWorkers)
      throw new Error('Native worker execution is not supported for this runner');
    if (workerLaunch?.filesystemPolicy && !transport.supportsReadOnlyWorkspace)
      throw new Error('Native runner cannot enforce a read-only source workspace');
    if (!isAbsolute(params.cwd) || !(await stat(params.cwd)).isDirectory())
      throw new Error('Native cwd must be an existing absolute directory');
    let previous: SessionRecord | undefined;
    let mode = params.mode ?? 'default';
    if (params.resumeSessionId) {
      previous = [...this.sessions.values()]
        .reverse()
        .find(
          (record) =>
            record.info.nativeSessionId === params.resumeSessionId &&
            record.info.runner === params.runner,
        );
      if (!previous || previous.info.ownerPrincipalId !== ownerPrincipalId)
        throw new Error('Resume requires an owned native session');
      const unavailable = transport.adapter.resumeUnavailableReason?.(previous.info.version);
      if (unavailable) throw new Error(unavailable);
      if (!['closed', 'failed'].includes(previous.info.state))
        throw new Error('Close the current native input owner before resuming');
      if (previous.info.processPid && !previous.info.processStopped)
        throw new Error('Native process cleanup is unconfirmed; recovery is blocked');
      if (previous.context.workerLaunchDigest && !workerLaunch)
        throw new Error('Worker recovery requires its recorded launch configuration');
      if (previous.info.workerLeaseId !== workerLaunch?.leaseId)
        throw new Error('Worker recovery must preserve its task lease');
      if (
        JSON.stringify(previous.context) !==
        JSON.stringify(executionContext(workerLaunch, params.runner, profile))
      )
        throw new Error('Resume must preserve the native account execution context');
      if (relocation) {
        if (
          !assertResumeCurrent ||
          relocation.fromCwd !== previous.info.cwd ||
          !previous.info.capabilities.resumeAcrossWorkspaces
        )
          throw new Error(
            'Native relocation requires the exact previous workspace and a portable saved session',
          );
        const roots = await Promise.all(
          [previous.info.cwd, params.cwd].map(async (cwd) => {
            const result = await exec(
              'git',
              ['rev-parse', '--path-format=absolute', '--git-common-dir'],
              { cwd, timeout: 10_000 },
            );
            return realpath(result.stdout.trim());
          }),
        );
        if (roots[0] !== roots[1])
          throw new Error('Native relocation requires sibling worktrees of the same repository');
        const unavailable = transport.adapter.workspaceResumeUnavailableReason?.(
          previous.info.version,
        );
        if (unavailable) throw new Error(unavailable);
      } else if (previous.info.cwd !== params.cwd)
        throw new Error('Resume must preserve the recorded working directory');
      mode = params.mode ?? previous.info.mode;
    }
    if (!transport.adapter.capabilities.modes.includes(mode))
      throw new Error('Native runner does not support this interaction mode');
    const baseEnvironment = workerLaunch ? nativeWorkerEnvironment(workerLaunch) : process.env;
    const environment = profile
      ? nativeProfileEnvironment(profile, baseEnvironment)
      : baseEnvironment;
    const resolved = await resolveNativeExecutable(
      workerLaunch?.executable ?? transport.binary,
      params.cwd,
      environment,
    );
    const unavailable = transport.adapter.resumeUnavailableReason?.(resolved.version);
    if (params.resumeSessionId && unavailable) throw new Error(unavailable);
    let filesystemPolicy = workerLaunch?.filesystemPolicy;
    if (filesystemPolicy) {
      const unsupported = transport.adapter.filesystemPolicyUnavailableReason?.(resolved.version);
      if (
        unsupported ||
        (!transport.adapter.filesystemPolicyUnavailableReason && !hostReviewSandboxAvailable())
      )
        throw new Error(unsupported ?? 'Native runner cannot enforce filesystem policy');
      filesystemPolicy = validateNativeWorkerFilesystemPolicy({
        readOnlyRoots: await Promise.all(
          [...filesystemPolicy.readOnlyRoots, this.root].map((root) => realpath(root)),
        ),
        writableRoots: await Promise.all(
          filesystemPolicy.writableRoots.map((root) => realpath(root)),
        ),
      });
      if (!filesystemPolicy.readOnlyRoots.includes(await realpath(params.cwd)))
        throw new Error('Native worker cwd must be an explicit read-only source root');
      if (
        !transport.adapter.filesystemPolicyUnavailableReason &&
        existsSync(join(params.cwd, '.git'))
      ) {
        const gitDirectory = await exec(
          'git',
          ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          { cwd: params.cwd, timeout: 10000 },
        );
        filesystemPolicy.readOnlyRoots.push(await realpath(gitDirectory.stdout.trim()));
      }
      if (workerLaunch?.safetyTier !== 'sandboxed')
        throw new Error('Read-only native workers require sandboxed execution');
    }
    const hostProtection =
      filesystemPolicy && !transport.adapter.filesystemPolicyUnavailableReason
        ? await reviewProcessSandbox(
            filesystemPolicy,
            transport.reviewRuntimeRoots?.(environment) ?? [],
          )
        : undefined;
    if (relocation) {
      const unavailable = transport.adapter.workspaceResumeUnavailableReason?.(resolved.version);
      if (unavailable) throw new Error(unavailable);
    }
    // Validation above awaits filesystem/process probes. Recheck synchronously before reservation.
    assertResumeCurrent?.();
    if (profile) assertNativeProfileCurrent(profile);
    const existing = this.existingCreation(ownerPrincipalId, params, reservedId, workerLaunch);
    if (existing) return this.createdSession(existing);
    if (reservedId && workerLaunch) this.assertWorkerNotCancelled(reservedId);
    // Reserve before starting the child, so simultaneous resume calls cannot create two input owners.
    if (
      params.resumeSessionId &&
      [...this.sessions.values()].some(
        (record) =>
          record.info.nativeSessionId === params.resumeSessionId &&
          !['closed', 'failed'].includes(record.info.state),
      )
    )
      throw new Error('Native session already has an input owner');
    const effort = workerLaunch
      ? workerLaunch.effort
      : previous
        ? previous.info.effort
        : transport.defaultEffort;
    const info: NativeSessionInfo = {
      id: previous?.info.id ?? reservedId ?? randomUUID(),
      generation: randomUUID(),
      hostPid: process.pid,
      runner: params.runner,
      nativeSessionId: params.resumeSessionId ?? '',
      ownerPrincipalId,
      executionNodeId: this.executionNodeId,
      accountContextId:
        profile?.accountContextId ??
        (this.executionNodeId === 'local'
          ? `native-local:${ownerPrincipalId}`
          : `native-node:${JSON.stringify([this.executionNodeId, ownerPrincipalId])}`),
      ...(profile ? { profileId: profile.id } : {}),
      cwd: params.cwd,
      ...resolved,
      model: params.model ?? previous?.info.model,
      mode,
      accountMode: 'native',
      ...(effort ? { effort } : {}),
      ...(workerLaunch ? { workerManaged: true, workerLeaseId: workerLaunch.leaseId } : {}),
      state: 'starting',
      capabilities: {
        ...transport.adapter.capabilities,
        resumeAcrossWorkspaces:
          transport.adapter.capabilities.resumeAcrossWorkspaces === true &&
          // A source policy pins exact paths in the launch digest. Relocation must
          // not silently rewrite its grants while resuming the saved conversation.
          !workerLaunch?.filesystemPolicy &&
          !transport.adapter.workspaceResumeUnavailableReason?.(resolved.version),
      },
    };
    const record: SessionRecord = {
      workerHistory: previous?.workerHistory ?? new NativeWorkerHistory(),
      info,
      events: previous?.events ?? [],
      commands: previous?.commands ?? new Map(),
      pendingRequests: new Map(),
      context: executionContext(workerLaunch, params.runner, profile),
      sending: false,
    };
    this.sessions.set(info.id, record);
    if (previous) {
      const saved = this.persisted.get(previous);
      if (saved) this.persisted.set(record, saved);
    }
    try {
      this.persist(record);
    } catch (error) {
      record.reservationError = error as Error;
      info.state = 'failed';
      info.recovery = 'Initial session reservation could not be persisted; no runner was launched.';
      throw error;
    }
    try {
      record.startupAbort = new AbortController();
      record.startup = transport.adapter.start(
        {
          ...params,
          signal: record.startupAbort.signal,
          mode,
          model: info.model,
          effort,
          onSpawn: (pid, identity) => {
            info.processPid = pid;
            info.processIdentity = identity;
            info.processStopped = false;
            this.persist(record);
          },
          executable: resolved.executable,
          env: nativeEnvironment(resolved.executable, {
            ...environment,
            ...(hostProtection ? { TMPDIR: hostProtection.temporaryDirectory } : {}),
          }),
          processSandbox: hostProtection?.sandbox,
          ...(workerLaunch
            ? { effort: workerLaunch.effort, safetyTier: workerLaunch.safetyTier, filesystemPolicy }
            : {}),
        },
        (event) => this.append(record, event),
      );
      record.adapter = await record.startup;
      info.nativeSessionId = record.adapter.nativeSessionId;
      if (record.adapter.capabilities)
        info.capabilities = {
          ...record.adapter.capabilities,
          resumeAcrossWorkspaces: info.capabilities.resumeAcrossWorkspaces,
        };
      if (info.state === 'starting') info.state = 'idle';
      this.persist(record);
      return this.snapshot(record);
    } catch (error) {
      info.state = 'failed';
      this.append(record, { type: 'error', text: (error as Error).message });
      throw error;
    }
  }

  private existingCreation(
    owner: string,
    params: NativeSessionCreateParams,
    reservedId?: string,
    workerLaunch?: NativeWorkerLaunch,
  ): SessionRecord | undefined {
    const record = reservedId ? this.sessions.get(reservedId) : undefined;
    if (!record) return undefined;
    if (record.info.ownerPrincipalId !== owner)
      throw new Error('Reserved sessionId belongs to another owner');
    if (record.info.workerLeaseId !== workerLaunch?.leaseId)
      throw new Error('Reserved sessionId belongs to another worker task lease');
    for (const field of ['runner', 'cwd', 'model', 'mode', 'profileId'] as const) {
      const requested = field === 'mode' ? (params.mode ?? 'default') : params[field];
      if (record.info[field] !== requested)
        throw new Error(`Reserved sessionId launch configuration differs: ${field}`);
    }
    if (
      record.context.workerLaunchDigest !==
      (workerLaunch ? nativeWorkerLaunchDigest(workerLaunch) : undefined)
    )
      throw new Error(
        'Reserved sessionId launch configuration differs: worker launch configuration',
      );
    const profile = params.profileId
      ? requireNativeProfile(params.profileId, params.runner)
      : undefined;
    if (
      JSON.stringify(record.context) !==
      JSON.stringify(executionContext(workerLaunch, params.runner, profile))
    )
      throw new Error('Reserved sessionId launch configuration differs: account execution context');
    return record;
  }

  private async createdSession(record: SessionRecord): Promise<NativeSessionInfo> {
    if (record.reservationError) throw record.reservationError;
    if (record.workerLeaseError) throw record.workerLeaseError;
    if (record.info.state === 'starting' && record.startup) await record.startup;
    // Failed/closed reservations remain explicit. A retry cannot create a replacement process.
    return this.snapshot(record);
  }

  assertWorkerLease(
    owner: string,
    id: string,
    generation: string,
    leaseId: string,
    closing = false,
  ): void {
    const record = this.owned(owner, id);
    if (record.info.generation !== generation || record.info.workerLeaseId !== leaseId)
      throw new Error('Native worker generation or task lease changed');
    if (record.workerLeaseError && !closing) throw record.workerLeaseError;
  }

  async closeWorker(
    owner: string,
    id: string,
    generation: string,
    leaseId: string,
  ): Promise<NativeSessionInfo> {
    this.assertWorkerLease(owner, id, generation, leaseId, true);
    const record = this.owned(owner, id);
    await this.close(owner, id);
    return this.snapshot(record);
  }

  private assertWorkerNotCancelled(id: string): void {
    if (existsSync(join(this.root, 'cancelled-workers', `${id}.json`)))
      throw new Error('Native worker reservation was cancelled before launch');
  }

  private resumeCancellationPath(id: string, leaseId: string, commandId: string): string {
    if (!commandId.trim()) throw new Error('Native recovery command ID is required');
    const key = createHash('sha256')
      .update(JSON.stringify([id, leaseId, commandId]))
      .digest('hex');
    return join(this.root, 'cancelled-resumes', `${key}.json`);
  }

  async cancelWorker(
    owner: string,
    id: string,
    leaseId: string,
    generation?: string,
    sourceLeaseId?: string,
    resumeCommandId?: string,
  ): Promise<NativeWorkerCancelResult> {
    if (
      ![id, leaseId].every((value) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value))
    )
      throw new Error('Native worker reservation and lease must be lowercase UUIDs');
    const root = join(this.root, 'cancelled-workers');
    privateDirectory(root);
    const markerPath = join(root, `${id}.json`);
    const marker = existsSync(markerPath)
      ? readJson<{ owner: string; leaseId: string; generation?: string }>(markerPath)
      : undefined;
    const record = this.sessions.get(id);
    if (resumeCommandId !== undefined) {
      if (!generation)
        throw new Error('Native recovery cancellation requires its source generation');
      if (
        !record ||
        record.info.ownerPrincipalId !== owner ||
        record.info.workerLeaseId !== leaseId
      )
        throw new Error('Native recovery cancellation ownership changed');
      // Keep every operation fence. A later explicit recovery uses a different ID,
      // but must never make an older delayed request launchable again.
      privateDirectory(join(this.root, 'cancelled-resumes'));
      durableWrite(this.resumeCancellationPath(id, leaseId, resumeCommandId), { owner });
      if (record.info.generation !== generation)
        return {
          cancelled: false,
          reason: 'generation-changed',
          sessionId: id,
          leaseId,
          generation: record.info.generation,
        };
    }
    if (sourceLeaseId !== undefined) {
      if (
        !generation ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sourceLeaseId) ||
        sourceLeaseId === leaseId
      )
        throw new Error(
          'Native handoff cancellation requires an exact source lease and generation',
        );
      if (record?.info.workerLeaseId === sourceLeaseId) {
        if (record.info.ownerPrincipalId !== owner || record.info.generation !== generation)
          throw new Error('Native handoff cancellation ownership changed');
        // Claim the reserved successor lease before stopping. A delayed transfer to
        // that lease now observes the same closed record; stale source commands fail.
        record.workerHistory.assertNewLease(leaseId);
        record.info.workerLeaseId = leaseId;
        try {
          this.persist(record);
        } catch (error) {
          record.workerLeaseError = error as Error;
          throw error;
        }
      }
    }
    if (
      marker &&
      (marker.owner !== owner ||
        (marker.leaseId !== leaseId && record?.info.workerLeaseId !== leaseId))
    )
      throw new Error('Native worker cancellation belongs to another owner or task lease');
    // A replay of an earlier cancel cannot stop an explicitly resumed generation.
    if (
      marker?.leaseId === leaseId &&
      record &&
      record.info.generation !== (generation ?? marker.generation)
    )
      return {
        cancelled: true,
        sessionId: id,
        leaseId,
        generation: generation ?? marker.generation,
      };
    if (record) {
      if (
        record.info.ownerPrincipalId !== owner ||
        record.info.workerLeaseId !== leaseId ||
        (generation !== undefined && record.info.generation !== generation)
      )
        throw new Error('Native worker cancellation ownership changed');
    } else if (generation && !marker) {
      throw new Error('Known native worker session is unavailable; stop cannot be confirmed');
    }
    const cancelledGeneration = record?.info.generation ?? generation ?? marker?.generation;
    // This durable tombstone also catches ensure calls still awaiting executable probes.
    durableWrite(markerPath, { owner, leaseId, generation: cancelledGeneration });
    if (record) await this.close(owner, id);
    return {
      cancelled: true,
      sessionId: id,
      leaseId,
      generation: cancelledGeneration,
      ...(record ? { session: this.snapshot(record) } : {}),
    };
  }

  transferWorker(
    owner: string,
    id: string,
    generation: string,
    leaseId: string,
    launch: NativeWorkerLaunch,
  ): NativeSessionInfo {
    const record = this.owned(owner, id);
    if (record.workerLeaseError) throw record.workerLeaseError;
    if (
      record.info.generation !== generation ||
      record.context.workerLaunchDigest !== nativeWorkerLaunchDigest(launch)
    )
      throw new Error('Native worker handoff must preserve generation and launch configuration');
    if (record.info.workerLeaseId === launch.leaseId) return this.snapshot(record);
    this.assertWorkerLease(owner, id, generation, leaseId);
    const stopped =
      ['closed', 'failed'].includes(record.info.state) &&
      record.info.processStopped &&
      Boolean(record.info.nativeSessionId);
    if ((record.info.state !== 'idle' && !stopped) || record.sending || record.pendingRequests.size)
      throw new Error(
        'Native worker handoff requires an idle session or a confirmed stopped session with no pending requests',
      );
    record.workerHistory.assertNewLease(launch.leaseId);
    record.info.workerLeaseId = launch.leaseId;
    try {
      this.persist(record);
    } catch (error) {
      // The write may have landed. Neither lease may submit more worker input until recovery.
      record.workerLeaseError = error as Error;
      throw error;
    }
    return this.snapshot(record);
  }

  private append(record: SessionRecord, event: NativeEventInput): void {
    const enriched: NativeSessionEvent = {
      ...event,
      sessionId: record.info.id,
      generation: record.info.generation,
      sequence: record.events.length + 1,
      at: new Date().toISOString(),
      ...(event.request
        ? { request: { ...event.request, id: `${record.info.generation}:${randomUUID()}` } }
        : {}),
    };
    record.events.push(enriched);
    if (event.type === 'session.started' && event.nativeId)
      record.info.nativeSessionId = event.nativeId;
    if (event.type === 'turn.started' && record.info.state !== 'closing')
      record.info.state = 'running';
    if (event.type === 'error' && event.status === 'failed') record.info.state = 'closing';
    if (event.type === 'turn.completed') {
      if (record.info.state !== 'closing') record.info.state = 'idle';
      record.pendingRequests.clear();
      const command = event.commandId && record.commands.get(event.commandId);
      if (command) {
        command.state = event.status === 'completed' ? 'completed' : 'failed';
        command.outcome = event.status;
      }
    }
    if (event.type === 'session.closed') {
      if (event.data?.processStopped === true) record.info.processStopped = true;
      record.info.state = event.status === 'failed' ? 'failed' : 'closed';
      if (event.status === 'failed')
        record.info.recovery ??= record.info.nativeSessionId
          ? 'Native runner stopped. Explicitly resume the saved identity after verifying its process group is stopped.'
          : 'Native runner stopped before its conversation identity was known. Automatic recovery is unavailable.';
      for (const command of record.commands.values())
        if (command.state === 'pending') command.state = 'unknown';
      record.pendingRequests.clear();
    }
    if (
      (event.type === 'approval.requested' || event.type === 'question.requested') &&
      event.nativeId
    )
      record.pendingRequests.set(enriched.request!.id, enriched);
    if (event.type === 'approval.resolved' && event.nativeId)
      for (const [id, pending] of record.pendingRequests)
        if (pending.nativeId === event.nativeId) {
          enriched.request = pending.request;
          record.pendingRequests.delete(id);
        }
    if (event.type === 'command.accepted' && event.commandId) {
      const command = record.commands.get(event.commandId);
      if (command) {
        command.accepted = true;
        if (!['completed', 'failed'].includes(command.state)) command.state = 'accepted';
      }
    }
    this.persist(record, enriched);
  }

  private owned(owner: string, id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record || record.info.ownerPrincipalId !== owner)
      throw new Error('Native session not found for this principal');
    return record;
  }
  private snapshot(record: Pick<SessionRecord, 'info'>): NativeSessionInfo {
    const unavailable = adapters[record.info.runner]?.adapter.resumeUnavailableReason?.(
      record.info.version,
    );
    return {
      ...record.info,
      capabilities: {
        ...record.info.capabilities,
        ...(unavailable ? { resume: false, resumeUnavailableReason: unavailable } : {}),
      },
    };
  }
  list(owner: string): NativeSessionInfo[] {
    return [...this.sessions.values()]
      .filter((record) => record.info.ownerPrincipalId === owner)
      .map((record) => this.snapshot(record));
  }
  read(owner: string, id: string, after = 0, limit = 200) {
    const record = this.owned(owner, id);
    if (!Number.isSafeInteger(after) || after < 0 || after > record.events.length)
      throw new Error('Invalid native event cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Invalid native event limit');
    const events: NativeSessionEvent[] = [];
    let bytes = 0;
    for (const event of record.events.slice(after, after + limit)) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (events.length && bytes + size > 2 * 1024 * 1024) break;
      events.push(event);
      bytes += size;
    }
    return {
      session: this.snapshot(record),
      events,
      cursor: after + events.length,
      hasMore: after + events.length < record.events.length,
      commands: [...record.commands.values()]
        .slice(-100)
        .map(({ text: _text, ...receipt }) => receipt),
      pendingRequests: [...record.pendingRequests.values()],
    };
  }
  readWorker(owner: string, id: string, leaseId: string, after?: number, limit?: number) {
    const record = this.owned(owner, id);
    if (record.workerLeaseError) throw record.workerLeaseError;
    const result = record.workerHistory.read(
      leaseId,
      record.events,
      [...record.pendingRequests.values()],
      after,
      limit,
    );
    return { ...result, session: this.snapshot({ info: result.session }) };
  }
  private assertAccountCurrent(record: SessionRecord): void {
    if (!record.info.profileId) return;
    assertNativeProfileCurrent({
      id: record.info.profileId,
      runner: record.info.runner,
      directory: record.context.profileDirectory,
      accountContextId: record.info.accountContextId,
      state: 'active',
    });
  }

  async send(
    owner: string,
    id: string,
    commandId: string,
    text: string,
  ): Promise<NativeSessionSendResult> {
    const record = this.owned(owner, id);
    this.assertAccountCurrent(record);
    const existing = record.commands.get(commandId);
    if (existing) {
      if (existing.text !== text) throw new Error('Command ID already has different text');
      return {
        submitted: existing.submitted,
        accepted: existing.accepted,
        state: existing.state,
        commandId,
      };
    }
    if (
      !record.adapter ||
      record.info.state !== 'idle' ||
      record.sending ||
      [...record.commands.values()].some(
        (command) =>
          command.generation === record.info.generation &&
          ['pending', 'unknown', 'accepted'].includes(command.state),
      )
    )
      throw new Error('Native session is not idle');
    record.sending = true;
    record.info.state = 'waiting';
    const command: StoredCommand = {
      text,
      commandId,
      generation: record.info.generation,
      // Reserve uncertainty and the visible prompt together before touching stdin.
      state: 'unknown',
      submitted: true,
      accepted: false,
    };
    record.commands.set(commandId, command);
    try {
      // A crash after this durable reservation must never trigger a resend.
      this.append(record, { type: 'command.submitted', commandId, text });
      await record.adapter.send(text, commandId);
      return {
        submitted: command.submitted,
        accepted: command.accepted,
        state: command.state,
        commandId,
      };
    } catch (error) {
      this.persist(record);
      throw error;
    } finally {
      record.sending = false;
    }
  }
  async respond(
    owner: string,
    id: string,
    requestId: string,
    response: NativeSessionResponse,
  ): Promise<void> {
    const record = this.owned(owner, id);
    this.assertAccountCurrent(record);
    const pending = record.pendingRequests.get(requestId);
    if (!record.adapter || !pending || pending.generation !== record.info.generation)
      throw new Error('Native request is stale or belongs to another session');
    if (
      pending.type === 'question.requested'
        ? !response.answers || !!response.decision
        : !response.decision || !!response.answers
    )
      throw new Error('Response does not match the pending interaction');
    if (pending.responseState) throw new Error('Native response outcome is unknown; do not resend');
    // Reserve durably before delivery. An uncertain decision cannot be applied twice.
    record.pendingRequests.set(requestId, { ...pending, responseState: 'unknown' });
    this.persist(record);
    await record.adapter.respond(pending.nativeId!, response);
  }
  async interrupt(owner: string, id: string): Promise<void> {
    const record = this.owned(owner, id);
    if (!['waiting', 'running'].includes(record.info.state))
      throw new Error('Native session has no running turn');
    await record.adapter!.interrupt();
  }
  async close(owner: string, id: string): Promise<void> {
    const record = this.owned(owner, id);
    if (record.info.state === 'closed' || record.info.state === 'failed') {
      if (record.info.processPid && !record.info.processStopped)
        throw new Error('Native process cleanup is unconfirmed; close outcome is unknown');
      return;
    }
    record.info.state = 'closing';
    this.persist(record);
    if (!record.adapter && record.startup) {
      record.startupAbort?.abort();
      try {
        await record.startup;
      } catch (error) {
        // Startup rejection is expected after cancellation only when the process
        // adapter has independently confirmed that its entire owned tree stopped.
        if (record.info.processStopped && ['closed', 'failed'].includes(record.info.state)) return;
        throw error;
      }
    }
    const adapter = record.adapter ?? (await record.startup);
    await adapter?.close();
    if (!['closed', 'failed'].includes(this.owned(owner, id).info.state))
      this.append(record, { type: 'session.closed' });
  }
}
