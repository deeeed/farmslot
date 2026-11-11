import type { RunnerModelCatalogResult } from '@farmslot/protocol';

import {
  listNodeModels,
  type ModelCatalogNode,
  nodeModelCatalogs,
  type RunnerModelCatalogNodeSource,
} from './model-catalog.js';

const RETRY_DELAY_MS = 15_000;
const RETRY_CAP_MS = 600_000;

/** Returns a cancellation function. Timers never keep the gateway alive. */
export type CatalogRetryScheduler = (callback: () => void, delayMs: number) => () => void;
const scheduleRetry: CatalogRetryScheduler = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

interface NodeCatalogState {
  pending?: Promise<void>;
  cancel?: () => void;
  delay: number;
}

export interface NodeCatalogObservationSource {
  source: RunnerModelCatalogNodeSource;
  nodes(): Promise<ModelCatalogNode[]>;
  scheduleRetry?: CatalogRetryScheduler;
}

interface NodeCatalogObservationOptions extends NodeCatalogObservationSource {
  runner: string;
  changed(result: RunnerModelCatalogResult): void;
}

/** Failed placement catalogs recover independently of picker interest, one listing per node. */
export class NodeModelCatalogObservation {
  private readonly states = new Map<string, NodeCatalogState>();
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly options: NodeCatalogObservationOptions) {}

  async sample(): Promise<RunnerModelCatalogResult> {
    const nodes = await this.nodes();
    await Promise.all(nodes.map((node) => this.list(node)));
    return nodeModelCatalogs.result(this.options.runner);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const state of this.states.values()) state.cancel?.();
    await Promise.all(this.pending);
  }

  private async nodes(): Promise<ModelCatalogNode[]> {
    const nodes = await this.options.nodes();
    const machines = new Set(nodes.map((node) => node.machine));
    for (const [machine, state] of this.states) {
      if (machines.has(machine)) continue;
      state.cancel?.();
      this.states.delete(machine);
    }
    return nodes;
  }

  private track(work: Promise<void>): Promise<void> {
    const pending = work.finally(() => this.pending.delete(pending));
    this.pending.add(pending);
    return pending;
  }

  private async retry(machine: string): Promise<void> {
    // Pool edits can remove a machine or replace its execution slot between attempts.
    const node = (await this.nodes()).find((node) => node.machine === machine);
    if (this.stopped || !node) return;
    await this.list(node);
    if (!this.stopped) this.options.changed(nodeModelCatalogs.result(this.options.runner));
  }

  private list(node: ModelCatalogNode): Promise<void> {
    if (this.stopped) return Promise.resolve();
    let state = this.states.get(node.machine);
    if (!state) {
      state = { delay: RETRY_DELAY_MS };
      this.states.set(node.machine, state);
    }
    const current = state;
    current.pending ??= this.track(
      (async () => {
        const ids = await listNodeModels(this.options.runner, this.options.source, node);
        if (this.stopped || this.states.get(node.machine) !== current) return;
        if (ids) {
          nodeModelCatalogs.record(this.options.runner, node.machine, ids);
          current.cancel?.();
          current.cancel = undefined;
          current.delay = RETRY_DELAY_MS;
        } else {
          nodeModelCatalogs.unavailable(this.options.runner, node.machine);
          if (!current.cancel) {
            current.cancel = (this.options.scheduleRetry ?? scheduleRetry)(() => {
              current.cancel = undefined;
              void this.track(this.retry(node.machine));
            }, current.delay);
            current.delay = Math.min(current.delay * 2, RETRY_CAP_MS);
          }
        }
      })().finally(() => {
        current.pending = undefined;
      }),
    );
    return current.pending;
  }
}
