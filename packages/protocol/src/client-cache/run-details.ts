import { openHumanGateDecision } from '../contracts/run-lifecycle-view.js';
import { isActiveListRun, type Run } from '../contracts/runs.js';
import { Methods } from '../rpc/registry.js';
import type { RunGetResult } from '../rpc/run.js';
import { trimRunForList } from '../runs/list-trim.js';
import { runListVersion } from '../runs/list-version.js';
import type { RunListProjection } from '../runs/run-list-filter.js';

import { resourceQuery, RUN_DETAIL_STORE_BYTES } from './registry.js';
import type { StoredResourceQuery, StoredResourceQueryInfo } from './store.js';
import type { ResourceCacheConnection, ResourceQueryState } from './types.js';

export interface RunDetailTarget {
  runId: string;
  version: string;
  gate: boolean;
  active: boolean;
  updatedAt: string;
}

export function runDetailTarget(run: Run | RunListProjection, version: string): RunDetailTarget {
  return {
    runId: run.id,
    version,
    gate: !('projected' in run) && Boolean(openHumanGateDecision(run)),
    active: isActiveListRun(run),
    updatedAt: run.updatedAt,
  };
}

interface RunDetailSyncOptions {
  budgetBytes?: number;
  connection(): ResourceCacheConnection;
  list(): Promise<StoredResourceQueryInfo[]>;
  stored(runId: string): Promise<StoredResourceQuery<RunGetResult> | undefined>;
  touch(runId: string): Promise<void>;
  fetch(
    runId: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<ResourceQueryState<RunGetResult>>;
  onError(error: unknown): void;
}

/** Event-driven detail sync; it opens no transport and never polls. */
export function createRunDetailSync(options: RunDetailSyncOptions) {
  let targets: RunDetailTarget[] = [];
  let signature = '';
  let controller = new AbortController();
  let running = false;
  let again = false;
  let failed = false;
  let connectionId: string | number | undefined;
  let restricted = true;
  let retained = new Set<string>();
  const seen = new Map<string, string>();
  const encoder = new TextEncoder();
  const enabled = () => options.connection().connected && options.connection().foreground !== false;

  async function pump(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    const owned = controller;
    running = true;
    try {
      do {
        again = false;
        failed = false;
        let remaining = options.budgetBytes ?? RUN_DETAIL_STORE_BYTES;
        const rows = new Map((await options.list()).map((row) => [row.id, row]));
        for (const target of targets) {
          if (owned.signal.aborted || !enabled()) return;
          if (!retained.has(target.runId)) continue;
          const id = resourceQuery(Methods.RUN_GET, { runId: target.runId }).id;
          const info = rows.get(id);
          if (info && info.bytes > remaining) break;
          const saved =
            info && seen.get(target.runId) !== target.version
              ? await options.stored(target.runId)
              : undefined;
          if (
            info &&
            (seen.get(target.runId) === target.version ||
              (saved && runListVersion(trimRunForList(saved.data.run)) === target.version))
          ) {
            if (owned.signal.aborted) return;
            seen.set(target.runId, target.version);
            remaining -= info.bytes;
            await options.touch(target.runId);
            continue;
          }
          const startedAt = Date.now();
          const state = await options.fetch(target.runId, remaining, owned.signal);
          if (owned.signal.aborted) return;
          if (!state.data || state.error || (state.observedAt ?? -Infinity) < startedAt) {
            failed = true;
            continue;
          }
          const bytes = encoder.encode(JSON.stringify(state.data)).byteLength;
          if (bytes > remaining) break;
          remaining -= bytes;
          seen.set(target.runId, runListVersion(trimRunForList(state.data.run)));
        }
      } while (again && !owned.signal.aborted);
    } catch (error) {
      failed = true;
      if (!owned.signal.aborted) options.onError(error);
    } finally {
      running = false;
      // A reconnect can replace an aborted batch while its last RPC is still settling.
      if (owned !== controller && enabled() && targets.length) void pump();
    }
  }

  return {
    setTargets(next: readonly RunDetailTarget[]) {
      const connection = options.connection();
      const selected = next
        .filter((target) => connection.metered === false || target.gate || target.active)
        .sort(
          (a, b) =>
            Number(b.gate) - Number(a.gate) ||
            Number(b.active) - Number(a.active) ||
            b.updatedAt.localeCompare(a.updatedAt) ||
            a.runId.localeCompare(b.runId),
        );
      const nextSignature = JSON.stringify([
        connection.id,
        connection.metered ?? 'unknown',
        selected.map(({ runId, version }) => [runId, version]),
      ]);
      if (connection.id !== connectionId || (connection.metered !== false && !restricted))
        controller.abort();
      connectionId = connection.id;
      restricted = connection.metered !== false;
      targets = selected;
      retained = new Set(selected.map(({ runId }) => runId));
      if (!enabled()) {
        controller.abort();
        signature = '';
        return;
      }
      if (!selected.length) {
        controller.abort();
        signature = nextSignature;
        return;
      }
      if (nextSignature === signature && !failed) return;
      signature = nextSignature;
      for (const id of seen.keys()) if (!retained.has(id)) seen.delete(id);
      if (controller.signal.aborted) controller = new AbortController();
      void pump();
    },
    reset() {
      controller.abort();
      targets = [];
      signature = '';
      seen.clear();
    },
  };
}
