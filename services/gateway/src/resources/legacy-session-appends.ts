import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { watchFile } from '@farmslot/capabilities/fs-watch';
import type {
  NodeFsChangedPayload,
  NodeFsReadChunkResult,
  WorkerSessionHistorySnapshot,
} from '@farmslot/protocol';

import { type ConnectedNode, getNode } from '../fleet/machine-registry.js';
import { sendNodeRequest } from '../fleet/node-rpc.js';
import { getRunnerSessionHistoryProvider } from '../runners/worker-session-history.js';

interface Listener {
  changed(snapshot: WorkerSessionHistorySnapshot): void;
  failed(error: Error): void;
}
interface Source {
  key: string;
  entry: SourceEntry;
  path: string;
  node?: ConnectedNode;
  requestId?: string;
  stopWatch?: () => void;
  snapshot?: WorkerSessionHistorySnapshot;
  offset: number;
  tail: Buffer;
  reading: boolean;
  dirty: boolean;
  stopped: boolean;
  failure?: Error;
  listeners: Set<Listener>;
}
interface SourceEntry {
  pending: Promise<Source>;
  waiters: number;
}

/** Shared on-demand byte-range reader for completed-message legacy histories. No timers. */
export class LegacySessionAppends {
  private sources = new Map<string, SourceEntry>();
  private remote = new Map<string, Source>();

  async observe(
    key: string,
    path: string,
    node: ConnectedNode | undefined,
    load: () => Promise<WorkerSessionHistorySnapshot>,
    listener: Listener,
  ): Promise<{ snapshot: WorkerSessionHistorySnapshot; stop(): void }> {
    let entry = this.sources.get(key);
    if (!entry) {
      const created: SourceEntry = {
        waiters: 0,
        pending: Promise.resolve().then(() => this.open(created, key, path, node, load)),
      };
      entry = created;
      this.sources.set(key, entry);
    }
    entry.waiters++;
    let source: Source | undefined;
    try {
      source = await entry.pending;
      if (source.failure) throw source.failure;
      source.listeners.add(listener);
      const owned = source;
      return {
        snapshot: source.snapshot!,
        stop: () => {
          owned.listeners.delete(listener);
          if (!owned.listeners.size && !entry!.waiters) this.close(owned);
        },
      };
    } finally {
      entry.waiters--;
      if (!source && !entry.waiters && this.sources.get(key) === entry) this.sources.delete(key);
    }
  }
  accept(socket: ConnectedNode['ws'], payload: NodeFsChangedPayload): boolean {
    const source = this.remote.get(payload.requestId);
    if (!source) return false;
    if (source.node?.ws !== socket || source.path !== payload.path) return true;
    if (!this.current(source)) {
      this.fail(source, new Error('Legacy history node authority changed'));
      return true;
    }
    if (payload.kind === 'error' || payload.kind === 'deleted')
      this.fail(
        source,
        new Error(payload.kind === 'error' ? payload.error.message : 'Legacy transcript removed'),
      );
    else this.changed(source);
    return true;
  }
  disconnect(socket: ConnectedNode['ws']): void {
    for (const source of this.remote.values())
      if (source.node?.ws === socket)
        this.fail(source, new Error('Legacy history node disconnected'));
  }
  private current(source: Source): boolean {
    return (
      !source.stopped &&
      (!source.node ||
        (getNode(source.node.machine) === source.node &&
          source.node.ws.readyState === 1 &&
          source.node.observationAuthority?.() !== false))
    );
  }
  private async open(
    entry: SourceEntry,
    key: string,
    path: string,
    node: ConnectedNode | undefined,
    load: () => Promise<WorkerSessionHistorySnapshot>,
  ): Promise<Source> {
    const source: Source = {
      key,
      entry,
      path,
      node,
      offset: 0,
      tail: Buffer.alloc(0),
      reading: false,
      dirty: false,
      stopped: false,
      listeners: new Set(),
    };
    try {
      if (node) {
        if (node.observationCapabilities?.fileAppends !== 1)
          throw new Error('Update this node for completed-message append observations');
        const result = (await sendNodeRequest(
          node,
          'fs.watch',
          { path, notificationsOnly: 1 },
          {
            requireSameConnection: true,
            onRequestId: (id) => {
              source.requestId = id;
              this.remote.set(id, source);
            },
          },
        )) as { notificationsOnly?: number };
        if (result.notificationsOnly !== 1 || !this.current(source))
          throw new Error('Legacy append source is unavailable');
      } else
        source.stopWatch = watchFile(path, () => this.changed(source), {
          notificationsOnly: true,
          onUnavailable: (value) =>
            this.fail(
              source,
              new Error(value.kind === 'error' ? value.error.message : 'Legacy transcript removed'),
            ),
        }).stop;
      // Listener before the high-water read. Any concurrent append is drained from that boundary.
      source.snapshot = await load();
      if (source.failure) throw source.failure;
      if (source.snapshot.runnerSessionPath !== path || !source.snapshot.cursor)
        throw new Error('Legacy transcript identity changed during observation');
      source.offset = source.snapshot.cursor.offset;
      await this.drain(source);
      return source;
    } catch (error) {
      this.close(source);
      throw error;
    }
  }
  private changed(source: Source): void {
    source.dirty = true;
    if (!source.snapshot || source.reading || source.stopped) return;
    void this.drain(source).catch((error) =>
      this.fail(source, error instanceof Error ? error : new Error(String(error))),
    );
  }
  private async chunk(source: Source): Promise<{ content: Buffer; size: number; eof: boolean }> {
    if (!this.current(source)) throw new Error('Legacy append source changed');
    if (source.node) {
      const result = (await sendNodeRequest(
        source.node,
        'fs.readChunk',
        {
          root: dirname(source.path),
          relPath: basename(source.path),
          offset: source.offset,
          length: 128 * 1024,
        },
        { requireSameConnection: true },
      )) as NodeFsReadChunkResult;
      if (
        !this.current(source) ||
        result.fileIdentity !== source.snapshot?.cursor?.fileIdentity ||
        result.offset !== source.offset ||
        result.encoding !== 'base64'
      )
        throw new Error('Legacy append read source changed');
      const content = Buffer.from(result.content, 'base64');
      if (content.length !== result.bytesRead || content.length > 128 * 1024)
        throw new Error('Invalid legacy append range');
      return { content, size: result.size, eof: result.eof };
    }
    const file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (`${stat.dev}:${stat.ino}` !== source.snapshot?.cursor?.fileIdentity)
        throw new Error('Legacy transcript file was replaced; reopen its history');
      if (stat.size < source.offset)
        throw new Error('Legacy transcript was truncated; reopen its history');
      const content = Buffer.alloc(Math.min(128 * 1024, stat.size - source.offset));
      const { bytesRead } = await file.read(content, 0, content.length, source.offset);
      return {
        content: content.subarray(0, bytesRead),
        size: stat.size,
        eof: source.offset + bytesRead >= stat.size,
      };
    } finally {
      await file.close();
    }
  }
  private async drain(source: Source): Promise<void> {
    if (source.reading || source.stopped) return;
    source.reading = true;
    try {
      do {
        source.dirty = false;
        const next = await this.chunk(source);
        if (source.stopped) return;
        source.offset += next.content.length;
        source.tail = Buffer.concat([source.tail, next.content]);
        const end = source.tail.lastIndexOf(10) + 1;
        if (end) {
          const lines = source.tail.subarray(0, end).toString('utf8').split('\n');
          source.tail = source.tail.subarray(end);
          const snapshot = source.snapshot!;
          const provider = snapshot.runner && getRunnerSessionHistoryProvider(snapshot.runner);
          if (!provider) throw new Error('Legacy completed-message projection unavailable');
          const projection = provider.project(lines);
          if (projection.skippedMalformedLines)
            throw new Error('Legacy transcript append contains malformed complete records');
          const messages = new Map(snapshot.messages.map((message) => [message.id, message]));
          for (const message of projection.messages) messages.set(message.id, message);
          source.snapshot = boundLegacyHistorySnapshot({
            ...snapshot,
            messages: [...messages.values()].slice(-1000),
            cursor: {
              fileIdentity: snapshot.cursor?.fileIdentity,
              path: source.path,
              offset: source.offset - source.tail.length,
              messageCount: messages.size,
            },
            generatedAt: new Date().toISOString(),
            degradedReason: 'Completed-message history; this source does not expose token deltas.',
          });
          for (const listener of [...source.listeners]) listener.changed(source.snapshot);
        }
        if (source.tail.length > 1024 * 1024)
          throw new Error('Legacy transcript record exceeds the append budget');
        if (!next.eof) source.dirty = true;
      } while (source.dirty && !source.stopped);
    } finally {
      source.reading = false;
    }
  }
  private fail(source: Source, error: Error): void {
    if (source.failure) return;
    source.failure = error;
    for (const listener of [...source.listeners]) listener.failed(error);
    this.close(source);
  }
  private close(source: Source): void {
    if (source.stopped) return;
    source.stopped = true;
    source.stopWatch?.();
    if (this.sources.get(source.key) === source.entry) this.sources.delete(source.key);
    if (source.requestId) {
      this.remote.delete(source.requestId);
      if (
        source.node &&
        getNode(source.node.machine) === source.node &&
        source.node.ws.readyState === 1
      )
        void sendNodeRequest(
          source.node,
          'fs.watch.stop',
          { requestId: source.requestId },
          { requireSameConnection: true },
        ).catch(() => source.node?.ws.close(1011, 'legacy history unsubscribe failed'));
    }
  }
}
export const legacySessionAppends = new LegacySessionAppends();

/** Legacy rows remain completed messages and have an explicit bounded-history marker. */
export function boundLegacyHistorySnapshot(
  snapshot: WorkerSessionHistorySnapshot,
): WorkerSessionHistorySnapshot {
  const messages = [];
  let bytes = 0;
  for (let index = snapshot.messages.length - 1; index >= 0; index--) {
    const message = snapshot.messages[index];
    const size = Buffer.byteLength(JSON.stringify(message));
    if (bytes + size > 768 * 1024) break;
    messages.unshift(message);
    bytes += size;
  }
  return {
    ...snapshot,
    messages,
    truncated: snapshot.truncated || messages.length < snapshot.messages.length,
  };
}
