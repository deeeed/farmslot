import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  NativeSessionCreateParams,
  NativeSessionEnsureParams,
  NativeSessionInfo,
  NativeSessionReadResult,
  NativeSessionResponse,
  NativeSessionSendResult,
} from '@farmslot/protocol';
import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { type HostIdentity, type HostRequest, requestHost } from './ipc.js';
import { alive, privateDirectory, readJson } from './storage.js';

/** The same client is usable by gateway and execution-node services. */
export class NativeSessionClient {
  readonly root: string;
  private starting?: Promise<HostIdentity>;
  constructor(
    root = process.env.FARMSLOT_NATIVE_STATE_DIR ?? join(farmslotHome(), 'native-sessions'),
    readonly executionNodeId = 'local',
  ) {
    this.root = resolve(root);
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
    const source = import.meta.url.endsWith('.ts');
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
    child.on('error', (error) => {
      spawnError = error;
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
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `Native host unavailable; inspect ${join(this.root, 'host.log')}. No command was retried.`,
    );
  }
  private async call<T>(request: HostRequest): Promise<T> {
    const host = await this.host();
    if (request.method === 'ensure' && !host.supportsEnsure)
      throw new Error(
        'Native host upgrade required for idempotent creation; existing sessions remain available',
      );
    return requestHost<T>(host, request);
  }
  create(owner: string, params: NativeSessionCreateParams) {
    if (params.executionNodeId !== undefined && params.executionNodeId !== this.executionNodeId)
      throw new Error('Native session targets another execution node');
    return this.call<NativeSessionInfo>({ method: 'create', owner, params });
  }
  ensure(owner: string, params: NativeSessionEnsureParams) {
    if (params.executionNodeId !== undefined && params.executionNodeId !== this.executionNodeId)
      throw new Error('Native session targets another execution node');
    return this.call<NativeSessionInfo>({ method: 'ensure', owner, params });
  }
  list(owner: string) {
    return this.call<NativeSessionInfo[]>({ method: 'list', owner });
  }
  read(owner: string, id: string, after?: number, limit?: number) {
    return this.call<NativeSessionReadResult>({ method: 'read', owner, id, after, limit });
  }
  send(owner: string, id: string, commandId: string, text: string) {
    return this.call<NativeSessionSendResult>({ method: 'send', owner, id, commandId, text });
  }
  respond(owner: string, id: string, requestId: string, response: NativeSessionResponse) {
    return this.call<void>({ method: 'respond', owner, id, requestId, response });
  }
  interrupt(owner: string, id: string) {
    return this.call<void>({ method: 'interrupt', owner, id });
  }
  close(owner: string, id: string) {
    return this.call<void>({ method: 'close', owner, id });
  }
}
