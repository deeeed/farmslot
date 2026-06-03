// methods/workspace.ts — workspace.metro.subscribe / unsubscribe
// Tails metro log files and streams lines to subscribed clients.

import { open, stat } from 'node:fs/promises';
import path from 'node:path';

import { watch } from 'chokidar';

import {
  Events,
  type OkResult,
  type WorkspaceMetroSubscribeParams,
  type WorkspaceMetroUnsubscribeParams,
} from '@farmslot/protocol';

import { loadPoolConfigs } from '../fleet/state.js';

type EventEmitter = (event: string, payload: unknown) => void;

interface MetroWatcher {
  close: () => void;
}

// Key: "slotId" — one watcher per slot per client (managed via ClientState in server.ts)
const watchers = new Map<string, MetroWatcher>();

async function resolveRepoDir(slotId: string): Promise<string | undefined> {
  const pools = await loadPoolConfigs();
  for (const pool of pools) {
    for (const slot of pool.slots) {
      if (slot.id === slotId) return slot.repo;
    }
  }
  return undefined;
}

function resolveMetroLogPath(repoDir: string): string {
  // Convention: metro logs written to .metro-logs/metro.log in the repo
  return path.join(repoDir, '.metro-logs', 'metro.log');
}

async function readLastNLines(filePath: string, n: number): Promise<string[]> {
  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch {
    return [];
  }
  if (fileInfo.size === 0) return [];

  const fd = await open(filePath, 'r');
  try {
    // Read up to last 256KB to find N lines
    const readSize = Math.min(fileInfo.size, 256 * 1024);
    const offset = fileInfo.size - readSize;
    const buf = Buffer.alloc(readSize);
    await fd.read(buf, 0, readSize, offset);
    const text = buf.toString('utf-8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    return lines.slice(-n);
  } finally {
    await fd.close();
  }
}

export async function metroSubscribe(
  params: WorkspaceMetroSubscribeParams,
  emit: EventEmitter,
  clientKey: string,
): Promise<OkResult> {
  const repoDir = await resolveRepoDir(params.slotId);
  if (!repoDir) {
    throw new Error(`No repo path found for slot ${params.slotId}`);
  }

  const logPath = resolveMetroLogPath(repoDir);
  const lastN = params.lastN ?? 200;
  const watcherKey = `${clientKey}:${params.slotId}`;

  console.log(`[metro] subscribe slot=${params.slotId} logPath=${logPath} lastN=${lastN}`);

  // Send initial lines
  const initial = await readLastNLines(logPath, lastN);
  if (initial.length > 0) {
    emit(Events.WORKSPACE_METRO_DATA, {
      slotId: params.slotId,
      lines: initial,
    });
  }

  // Track file size for incremental reads
  let lastSize = 0;
  try {
    const info = await stat(logPath);
    lastSize = info.size;
  } catch {
    // File doesn't exist yet — watcher will pick it up when created
  }

  // Watch for changes
  const watcher = watch(logPath, {
    persistent: false,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher.on('change', async () => {
    try {
      const info = await stat(logPath);
      if (info.size <= lastSize) {
        // File was truncated — re-read from start
        lastSize = 0;
      }
      if (info.size === lastSize) return;

      const fd = await open(logPath, 'r');
      try {
        const readSize = info.size - lastSize;
        const buf = Buffer.alloc(readSize);
        await fd.read(buf, 0, readSize, lastSize);
        lastSize = info.size;

        const text = buf.toString('utf-8');
        const lines = text.split('\n').filter((l) => l.length > 0);
        if (lines.length > 0) {
          emit(Events.WORKSPACE_METRO_DATA, {
            slotId: params.slotId,
            lines,
          });
        }
      } finally {
        await fd.close();
      }
    } catch (err) {
      console.error(`[metro] read error slot=${params.slotId}:`, (err as Error).message);
    }
  });

  watcher.on('add', async () => {
    // File was created — read initial content
    lastSize = 0;
    const lines = await readLastNLines(logPath, lastN);
    if (lines.length > 0) {
      emit(Events.WORKSPACE_METRO_DATA, {
        slotId: params.slotId,
        lines,
      });
      try {
        const info = await stat(logPath);
        lastSize = info.size;
      } catch {
        /* ignore */
      }
    }
  });

  // Cleanup previous watcher for same key if any
  const existing = watchers.get(watcherKey);
  if (existing) {
    existing.close();
  }

  watchers.set(watcherKey, {
    close: () => {
      watcher.close();
    },
  });

  return { ok: true };
}

export async function metroUnsubscribe(
  params: WorkspaceMetroUnsubscribeParams,
  clientKey: string,
): Promise<OkResult> {
  const watcherKey = `${clientKey}:${params.slotId}`;
  const watcher = watchers.get(watcherKey);
  if (watcher) {
    console.log(`[metro] unsubscribe slot=${params.slotId}`);
    watcher.close();
    watchers.delete(watcherKey);
  }
  return { ok: true };
}

export function metroUnsubscribeAll(clientKey: string): void {
  const prefix = `${clientKey}:`;
  for (const [key, watcher] of watchers) {
    if (key.startsWith(prefix)) {
      watcher.close();
      watchers.delete(key);
    }
  }
}
