import type { ActiveResourcePointer, Run, SlotResource } from '@farmslot/protocol';

import type { ProcessCensusRow } from './process-census.js';

export const DEVSERVER_IDLE_LIMIT_MS = 15 * 60_000;
type SlotRow = Readonly<Record<string, unknown>>;

export interface IdleDevServerDeps {
  now(): number;
  row(slotId: string): Promise<SlotRow | null>;
  runs(): Run[];
  progress(run: Run): Promise<string>;
  preparing(slotId: string): boolean;
  retained(slotId: string, resourceId: string): Promise<boolean>;
  resources(slotId: string): Promise<SlotResource[]>;
  pointer(
    slotId: string,
    resourceId: string,
    refresh?: boolean,
  ): ActiveResourcePointer | undefined | Promise<ActiveResourcePointer | undefined>;
  census(slotId: string): Promise<ProcessCensusRow[]>;
  write(slotId: string, expected: SlotRow, fields: Record<string, unknown>): Promise<boolean>;
  stop(
    slotId: string,
    rows: ProcessCensusRow[],
    roots: ProcessCensusRow[],
    stillOwned: () => Promise<boolean>,
  ): Promise<boolean>;
  boot(slotId: string, resourceId: string): Promise<{ ok: boolean; detail?: string }>;
  health(slotId: string, resourceId: string): Promise<string>;
}

interface IdleCandidate {
  since: number;
  epoch: unknown;
  owner: unknown;
  process: ProcessCensusRow;
}

/** Policy for watched dev servers only. It never infers ownership from a process name. */
export class IdleDevServerReaper {
  private readonly idle = new Map<string, IdleCandidate>();

  constructor(private readonly deps: IdleDevServerDeps) {}

  private async quiet(slotId: string, expected: SlotRow, resourceId?: string): Promise<boolean> {
    const row = await this.deps.row(slotId);
    if (
      !row ||
      row.slot_epoch !== expected.slot_epoch ||
      row.current_run_id !== expected.current_run_id ||
      row.phase === 'releasing' ||
      row.lifecycle === 'manual' ||
      row.handoff_run_id ||
      (row.warm === true && !row.current_run_id) ||
      this.deps.preparing(slotId) ||
      (resourceId !== undefined && (await this.deps.retained(slotId, resourceId)))
    )
      return false;
    const runs = this.deps.runs().filter((run) => run.slotId === slotId);
    if (row.current_run_id && !runs.some((run) => run.id === row.current_run_id)) return false;
    if (!runs.length && row.agent === 'working') return false;
    for (const run of runs) {
      const progress = await this.deps.progress(run);
      if (progress !== 'idle' && progress !== 'awaiting-input') return false;
    }
    return true;
  }

  async sweep(slotId: string): Promise<void> {
    const row = await this.deps.row(slotId);
    const prefix = `${slotId}/`;
    if (!row || !(await this.quiet(slotId, row))) {
      for (const key of this.idle.keys()) if (key.startsWith(prefix)) this.idle.delete(key);
      return;
    }
    const resources = (await this.deps.resources(slotId)).filter(
      (resource) =>
        resource.definition.type === 'dev-server' &&
        resource.definition.hooks?.boot &&
        resource.definition.hooks.health &&
        (resource.status === 'running' || resource.status === 'stale'),
    );
    let rows: ProcessCensusRow[] | undefined;
    for (const resource of resources) {
      const key = `${prefix}${resource.id}`;
      if (await this.deps.retained(slotId, resource.id)) {
        this.idle.delete(key);
        continue;
      }
      const pointer = await this.deps.pointer(slotId, resource.id);
      // A port-only health result without a watched PID grants no stop authority.
      if (!pointer) {
        this.idle.delete(key);
        continue;
      }
      let candidate = this.idle.get(key);
      if (
        !candidate ||
        candidate.process.pid !== String(pointer.pid) ||
        candidate.epoch !== row.slot_epoch ||
        candidate.owner !== row.current_run_id
      ) {
        rows ??= await this.deps.census(slotId);
        const process = rows.find((process) => process.pid === String(pointer.pid));
        if (
          !process ||
          (pointer.meta?.process &&
            (pointer.meta.process.identity !== process.identity ||
              pointer.meta.process.group !== process.group))
        ) {
          this.idle.delete(key);
          continue;
        }
        candidate = {
          since: this.deps.now(),
          epoch: row.slot_epoch,
          owner: row.current_run_id,
          process,
        };
        this.idle.set(key, candidate);
      }
      if (this.deps.now() - candidate.since < DEVSERVER_IDLE_LIMIT_MS) continue;
      rows ??= await this.deps.census(slotId);
      const root = rows.find(
        (process) =>
          process.pid === candidate.process.pid &&
          process.identity === candidate.process.identity &&
          process.group === candidate.process.group,
      );
      if (!root) {
        this.idle.delete(key);
        continue;
      }
      // Write-ahead intent survives a gateway restart between signals and settlement.
      const current = await this.deps.row(slotId);
      if (!current || !(await this.quiet(slotId, row, resource.id))) return;
      const prior = Array.isArray(current.idle_devservers)
        ? current.idle_devservers.filter((id): id is string => typeof id === 'string')
        : [];
      if (
        !(await this.deps.write(slotId, row, {
          idle_devservers: [...new Set([...prior, resource.id])],
          idle_devserver_epoch: row.slot_epoch,
        }))
      )
        return;
      const stopped = await this.deps.stop(
        slotId,
        rows,
        [root],
        async () =>
          (await this.deps.pointer(slotId, resource.id, true))?.pid === pointer.pid &&
          (await this.quiet(slotId, row, resource.id)),
      );
      if (stopped) this.idle.delete(key);
    }
  }

  /** Resume only what this cap deliberately stopped, through the configured boot path. */
  async restore(slotId: string, ownerRunId?: string): Promise<void> {
    const row = await this.deps.row(slotId);
    if (!row || row.idle_devserver_epoch !== row.slot_epoch || !Array.isArray(row.idle_devservers))
      return;
    if (ownerRunId && row.current_run_id !== ownerRunId)
      throw new Error('Slot owner changed before dev server re-prepare');
    const assertOwner = async () => {
      const current = await this.deps.row(slotId);
      if (
        !current ||
        current.slot_epoch !== row.slot_epoch ||
        current.current_run_id !== row.current_run_id ||
        current.phase === 'releasing' ||
        current.handoff_run_id
      )
        throw new Error('Slot owner changed or is releasing during dev server re-prepare');
    };
    await assertOwner();
    const resources = await this.deps.resources(slotId);
    for (const id of row.idle_devservers) {
      const resource = resources.find(
        (resource) => resource.id === id && resource.definition.type === 'dev-server',
      );
      if (!resource) throw new Error(`Idle dev server '${String(id)}' is no longer configured`);
      await assertOwner();
      const status = await this.deps.health(slotId, resource.id);
      if (status === 'stopped') {
        await assertOwner();
        const result = await this.deps.boot(slotId, resource.id);
        if (!result.ok) throw new Error(result.detail ?? 'Dev server re-prepare failed');
      } else if (status !== 'running')
        throw new Error(`Dev server '${resource.id}' health is ${status}; resume refused`);
    }
    await assertOwner();
    if (
      !(await this.deps.write(slotId, row, { idle_devservers: null, idle_devserver_epoch: null }))
    )
      throw new Error('Slot owner changed during dev server re-prepare');
  }
}
