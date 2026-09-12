import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, openSync, readdirSync, writeFileSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import type {
  NativeCommandReceipt,
  NativeSessionCreateParams,
  NativeSessionEvent,
  NativeSessionInfo,
  NativeSessionResponse,
  NativeSessionSendResult,
} from '@farmslot/protocol';

import { claudeNativeAdapter } from './claude.js';
import { codexNativeAdapter } from './codex.js';
import { privateDirectory, readJournal } from './storage.js';
import type { NativeAdapter, NativeAdapterSession, NativeEventInput } from './types.js';

const exec = promisify(execFile);
const adapters: Record<string, { adapter: NativeAdapter; binary: string }> = {
  codex: { adapter: codexNativeAdapter, binary: 'codex' },
  claude: { adapter: claudeNativeAdapter, binary: 'claude' },
};

export async function resolveNativeExecutable(
  binary: string,
  cwd: string,
): Promise<{ executable: string; version: string }> {
  let executable: string | undefined;
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, binary);
    try {
      await access(candidate, constants.X_OK);
    } catch (error) {
      if (['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        continue;
      throw error;
    }
    executable = candidate;
    break;
  }
  if (!executable) throw new Error(`Install and log into the native ${binary} runner first`);
  if (executable.includes('/.asdf/shims/')) {
    const resolved = await exec('asdf', ['which', binary], { cwd, timeout: 10_000 });
    executable = resolved.stdout.trim();
  }
  executable = await realpath(executable);
  const result = await exec(executable, ['--version'], {
    cwd,
    timeout: 10_000,
    env: nativeEnvironment(executable),
  });
  const version = result.stdout.trim();
  if (!version) throw new Error('Native executable did not provide version metadata');
  return { executable, version };
}

function executionContext(): Record<string, string> {
  return {
    home: homedir(),
    codexHome: process.env.CODEX_HOME ?? '',
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? '',
  };
}
function nativeEnvironment(executable: string): NodeJS.ProcessEnv {
  // Native configuration may reference environment credentials. Inherit it in-process only;
  // never persist or send it over IPC. Remove parent Claude invocation context.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dirname(executable)}${delimiter}${process.env.PATH ?? ''}`,
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
  info: NativeSessionInfo;
  events: NativeSessionEvent[];
  adapter?: NativeAdapterSession;
  startup?: Promise<NativeAdapterSession>;
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
      for (const entry of entries) {
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
  }
  async create(
    ownerPrincipalId: string,
    params: NativeSessionCreateParams,
  ): Promise<NativeSessionInfo> {
    if (params.executionNodeId !== undefined && params.executionNodeId !== this.executionNodeId)
      throw new Error('Native session targets another execution node');
    const transport = adapters[params.runner];
    if (!transport) throw new Error(`Runner has no native transport: ${params.runner}`);
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
      if (JSON.stringify(previous.context) !== JSON.stringify(executionContext()))
        throw new Error('Resume must preserve the native account execution context');
      if (previous.info.cwd !== params.cwd)
        throw new Error('Resume must preserve the recorded working directory');
      mode = params.mode ?? previous.info.mode;
    }
    if (!transport.adapter.capabilities.modes.includes(mode))
      throw new Error('Native runner does not support this interaction mode');
    const resolved = await resolveNativeExecutable(transport.binary, params.cwd);
    const unavailable = transport.adapter.resumeUnavailableReason?.(resolved.version);
    if (params.resumeSessionId && unavailable) throw new Error(unavailable);
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
    const info: NativeSessionInfo = {
      id: previous?.info.id ?? randomUUID(),
      generation: randomUUID(),
      hostPid: process.pid,
      runner: params.runner,
      nativeSessionId: params.resumeSessionId ?? '',
      ownerPrincipalId,
      executionNodeId: this.executionNodeId,
      accountContextId:
        this.executionNodeId === 'local'
          ? `native-local:${ownerPrincipalId}`
          : `native-node:${JSON.stringify([this.executionNodeId, ownerPrincipalId])}`,
      cwd: params.cwd,
      ...resolved,
      model: params.model ?? previous?.info.model,
      mode,
      accountMode: 'native',
      state: 'starting',
      capabilities: { ...transport.adapter.capabilities },
    };
    const record: SessionRecord = {
      info,
      events: previous?.events ?? [],
      commands: previous?.commands ?? new Map(),
      pendingRequests: new Map(),
      context: executionContext(),
      sending: false,
    };
    this.sessions.set(info.id, record);
    if (previous) {
      const saved = this.persisted.get(previous);
      if (saved) this.persisted.set(record, saved);
    }
    this.persist(record);
    try {
      record.startup = transport.adapter.start(
        {
          ...params,
          mode,
          model: info.model,
          onSpawn: (pid, identity) => {
            info.processPid = pid;
            info.processIdentity = identity;
            info.processStopped = false;
            this.persist(record);
          },
          executable: resolved.executable,
          env: nativeEnvironment(resolved.executable),
        },
        (event) => this.append(record, event),
      );
      record.adapter = await record.startup;
      info.nativeSessionId = record.adapter.nativeSessionId;
      if (record.adapter.capabilities) info.capabilities = { ...record.adapter.capabilities };
      if (info.state === 'starting') info.state = 'idle';
      this.persist(record);
      return this.snapshot(record);
    } catch (error) {
      info.state = 'failed';
      this.append(record, { type: 'error', text: (error as Error).message });
      throw error;
    }
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
  private snapshot(record: SessionRecord): NativeSessionInfo {
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
  async send(
    owner: string,
    id: string,
    commandId: string,
    text: string,
  ): Promise<NativeSessionSendResult> {
    const record = this.owned(owner, id);
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
    const adapter = record.adapter ?? (await record.startup);
    await adapter?.close();
    if (!['closed', 'failed'].includes(this.owned(owner, id).info.state))
      this.append(record, { type: 'session.closed' });
  }
}
