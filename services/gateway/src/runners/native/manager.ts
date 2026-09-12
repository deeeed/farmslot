import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import type {
  NativeSessionCreateParams,
  NativeSessionEvent,
  NativeSessionInfo,
  NativeSessionResponse,
  NativeSessionSendResult,
} from '@farmslot/protocol';

import { KNOWN_RUNNERS } from '../registry.js';

import { claudeNativeAdapter } from './claude.js';
import { codexNativeAdapter } from './codex.js';
import type { NativeAdapter, NativeAdapterSession, NativeEventInput } from './types.js';

const exec = promisify(execFile);
const adapters: Record<string, { adapter: NativeAdapter; binary: string }> = {
  'codex-app-server': { adapter: codexNativeAdapter, binary: 'codex' },
  'claude-stream-json': { adapter: claudeNativeAdapter, binary: 'claude' },
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

function nativeEnvironment(executable: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${dirname(executable)}${delimiter}${process.env.PATH ?? ''}` };
}

interface SessionRecord {
  info: NativeSessionInfo;
  events: NativeSessionEvent[];
  adapter?: NativeAdapterSession;
  startup?: Promise<NativeAdapterSession>;
  // Retain receipts for the session lifetime so old command IDs stay idempotent.
  commands: Map<string, { text: string; state: 'pending' | 'accepted' | 'uncertain' }>;
  pendingRequests: Set<string>;
  sending: boolean;
}

/** One manager owns native stdin. Client disconnects only stop polling. */
export class NativeSessionManager {
  private sessions = new Map<string, SessionRecord>();

  async create(
    ownerPrincipalId: string,
    params: NativeSessionCreateParams,
  ): Promise<NativeSessionInfo> {
    const definition = KNOWN_RUNNERS[params.runner];
    const transport = definition?.nativeTransport && adapters[definition.nativeTransport];
    if (!transport) throw new Error(`Runner has no native transport: ${params.runner}`);
    if (!isAbsolute(params.cwd) || !(await stat(params.cwd)).isDirectory())
      throw new Error('Native cwd must be an existing absolute directory');
    if (params.model && !definition.acceptsModel(params.model))
      throw new Error('Model is incompatible with this runner');
    let mode = params.mode ?? 'default';
    if (params.resumeSessionId) {
      const previous = [...this.sessions.values()].find(
        (record) =>
          record.info.nativeSessionId === params.resumeSessionId &&
          record.info.runner === params.runner,
      );
      if (!previous || previous.info.ownerPrincipalId !== ownerPrincipalId)
        throw new Error('Resume requires an owned native session');
      if (!['closed', 'failed'].includes(previous.info.state))
        throw new Error('Close the current native input owner before resuming');
      if (previous.info.cwd !== params.cwd)
        throw new Error('Resume must preserve the recorded working directory');
      mode = params.mode ?? previous.info.mode;
    }
    if (!transport.adapter.capabilities.modes.includes(mode))
      throw new Error('Native runner does not support this interaction mode');
    const resolved = await resolveNativeExecutable(transport.binary, params.cwd);
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
      id: randomUUID(),
      runner: params.runner,
      nativeSessionId: params.resumeSessionId ?? '',
      ownerPrincipalId,
      executionNodeId: 'local',
      accountContextId: `native-local:${ownerPrincipalId}`,
      cwd: params.cwd,
      ...resolved,
      model: params.model,
      mode,
      accountMode: 'native',
      state: 'starting',
      capabilities: { ...transport.adapter.capabilities },
    };
    const record: SessionRecord = {
      info,
      events: [],
      commands: new Map(),
      pendingRequests: new Set(),
      sending: false,
    };
    this.sessions.set(info.id, record);
    try {
      record.startup = transport.adapter.start(
        {
          ...params,
          mode,
          executable: resolved.executable,
          env: nativeEnvironment(resolved.executable),
        },
        (event) => this.append(record, event),
      );
      record.adapter = await record.startup;
      info.nativeSessionId = record.adapter.nativeSessionId;
      if (record.adapter.capabilities) info.capabilities = { ...record.adapter.capabilities };
      if (info.state === 'starting') info.state = 'idle';
      return { ...info };
    } catch (error) {
      info.state = 'failed';
      this.append(record, { type: 'error', text: (error as Error).message });
      throw error;
    }
  }

  private append(record: SessionRecord, event: NativeEventInput): void {
    record.events.push({
      ...event,
      sessionId: record.info.id,
      sequence: record.events.length + 1,
      at: new Date().toISOString(),
    });
    if (event.type === 'turn.started' && record.info.state !== 'closing')
      record.info.state = 'running';
    if (event.type === 'error' && event.status === 'failed') record.info.state = 'closing';
    if (event.type === 'turn.completed') {
      if (record.info.state !== 'closing') record.info.state = 'idle';
      record.pendingRequests.clear();
    }
    if (event.type === 'session.closed') {
      record.info.state = event.status === 'failed' ? 'failed' : 'closed';
      record.pendingRequests.clear();
    }
    if (
      (event.type === 'approval.requested' || event.type === 'question.requested') &&
      event.nativeId
    )
      record.pendingRequests.add(event.nativeId);
    if (event.type === 'approval.resolved' && event.nativeId)
      record.pendingRequests.delete(event.nativeId);
    if (event.type === 'command.accepted' && event.commandId) {
      const command = record.commands.get(event.commandId);
      if (command) command.state = 'accepted';
    }
  }

  private owned(owner: string, id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record || record.info.ownerPrincipalId !== owner)
      throw new Error('Native session not found for this principal');
    return record;
  }
  list(owner: string): NativeSessionInfo[] {
    return [...this.sessions.values()]
      .filter((record) => record.info.ownerPrincipalId === owner)
      .map((record) => ({ ...record.info }));
  }
  read(owner: string, id: string, after = 0) {
    const record = this.owned(owner, id);
    if (!Number.isSafeInteger(after) || after < 0 || after > record.events.length)
      throw new Error('Invalid native event cursor');
    return {
      session: { ...record.info },
      events: record.events.slice(after),
      cursor: record.events.length,
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
      if (existing.state !== 'uncertain')
        return { submitted: true, accepted: existing.state === 'accepted', commandId };
      throw new Error(`Command acceptance is ${existing.state}; inspect events before continuing`);
    }
    if (
      !record.adapter ||
      record.info.state !== 'idle' ||
      record.sending ||
      [...record.commands.values()].some((command) => command.state !== 'accepted')
    )
      throw new Error('Native session is not idle');
    record.sending = true;
    record.info.state = 'waiting';
    const command = { text, state: 'pending' as 'pending' | 'accepted' | 'uncertain' };
    record.commands.set(commandId, command);
    try {
      await record.adapter.send(text, commandId);
      return { submitted: true, accepted: command.state === 'accepted', commandId };
    } catch (error) {
      if (command.state !== 'accepted') command.state = 'uncertain';
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
    if (!record.pendingRequests.has(requestId))
      throw new Error('Native request is stale or belongs to another session');
    await record.adapter!.respond(requestId, response);
    record.pendingRequests.delete(requestId);
  }
  async interrupt(owner: string, id: string): Promise<void> {
    const record = this.owned(owner, id);
    if (record.info.state !== 'running') throw new Error('Native session has no running turn');
    await record.adapter!.interrupt();
  }
  async close(owner: string, id: string): Promise<void> {
    const record = this.owned(owner, id);
    if (record.info.state === 'closed' || record.info.state === 'failed') return;
    record.info.state = 'closing';
    const adapter = record.adapter ?? (await record.startup);
    await adapter?.close();
    if (!['closed', 'failed'].includes(this.owned(owner, id).info.state))
      this.append(record, { type: 'session.closed' });
  }
}

export const nativeSessionManager = new NativeSessionManager();
