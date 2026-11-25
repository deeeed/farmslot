import { isTerminalRunStatus, type Run, type SlotResource } from '@farmslot/protocol';

import { sameSlotField } from '../core/same-slot-field.js';

import type { ProcessCensusRow } from './process-census.js';

export const DEVSERVER_IDLE_LIMIT_MS = 15 * 60_000;
/**
 * A keep-warm slot with no run holds its dev server for the next run, but not forever: a
 * keep-warm release on mini-mmt-3 left its dev server and prepare scope up for two days.
 */
export const WARM_DEVSERVER_IDLE_LIMIT_MS = 2 * 60 * 60_000;
type SlotRow = Readonly<Record<string, unknown>>;

export type IdleDevServerPointer = Pick<ProcessCensusRow, 'identity' | 'group'> & { pid: number };

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
  ): IdleDevServerPointer | undefined | Promise<IdleDevServerPointer | undefined>;
  census(slotId: string): Promise<ProcessCensusRow[]>;
  /** `admit` is checked inside the conditional write, after its row predicate. */
  write(
    slotId: string,
    expected: SlotRow,
    fields: Record<string, unknown>,
    admit?: () => boolean,
  ): Promise<boolean>;
  stop(
    slotId: string,
    rows: ProcessCensusRow[],
    roots: ProcessCensusRow[],
    stillOwned: () => Promise<boolean>,
  ): Promise<true | string>;
  /** Times this resource stopped being observed running or stale; a change restarts its window. */
  observed?(slotId: string, resourceId: string): number;
  /** The sweep's latest decision for a slot or one of its dev servers; repeated values may be dropped. */
  decide?(slotId: string, resourceId: string | undefined, decision: string): void;
  /** Why the latest pointer call for this resource returned nothing; read once. */
  explain?(slotId: string, resourceId: string): string | undefined;
  ready(
    slotId: string,
    resourceId: string,
    runId: string | undefined,
    assertOwner: () => Promise<void>,
  ): Promise<void>;
}

interface IdleCandidate {
  since: number;
  observed: number;
  epoch: unknown;
  owner: unknown;
  process: ProcessCensusRow;
}

/** Closed history is not a progress source; surviving historical panes are checked by census. */
export function slotWorkerRuns(runs: Run[], slotId: string, owner: unknown): Run[] {
  return runs.filter(
    (run) => run.slotId === slotId && (run.id === owner || !isTerminalRunStatus(run.status)),
  );
}

/** Policy for watched dev servers only. It never infers ownership from a process name. */
export class IdleDevServerReaper {
  private readonly idle = new Map<string, IdleCandidate>();

  constructor(private readonly deps: IdleDevServerDeps) {}

  /** Why the slot is not quiet enough to stop its idle dev server, or null when it is. */
  private async quietBlocker(
    slotId: string,
    expected: SlotRow,
    resourceId?: string,
  ): Promise<string | null> {
    const row = await this.deps.row(slotId);
    if (!row) return 'slot row unavailable';
    if (row.slot_epoch !== expected.slot_epoch) return 'slot epoch changed';
    if (!sameSlotField(row.current_run_id, expected.current_run_id)) return 'slot owner changed';
    if (row.phase === 'releasing') return 'slot releasing';
    if (row.lifecycle === 'manual') return 'manual slot';
    if (row.handoff_run_id) return 'slot handoff in progress';
    if (this.deps.preparing(slotId)) return 'slot preparing';
    if (resourceId !== undefined && (await this.deps.retained(slotId, resourceId)))
      return 'retained by a capability lease';
    const runs = slotWorkerRuns(this.deps.runs(), slotId, row.current_run_id);
    if (row.current_run_id && !runs.some((run) => run.id === row.current_run_id))
      return 'slot owner run unavailable';
    if (!runs.length && row.agent === 'working') return 'slot agent working';
    for (const run of runs) {
      const progress = await this.deps.progress(run);
      if (progress !== 'idle' && progress !== 'awaiting-input')
        return `run ${run.id.slice(0, 8)} ${progress}`;
    }
    return null;
  }

  private decide(slotId: string, resourceId: string | undefined, decision: string): void {
    this.deps.decide?.(slotId, resourceId, decision);
  }

  /**
   * Dev servers the cap may stop: watched, with boot and health hooks, and observed running or
   * stale. An unobserved server loses its idle window.
   */
  async eligible(slotId: string): Promise<SlotResource[]> {
    const devServers = (await this.deps.resources(slotId)).filter(
      (resource) => resource.definition.type === 'dev-server',
    );
    const configured = new Set(devServers.map((resource) => `${slotId}/${resource.id}`));
    for (const key of this.idle.keys())
      if (key.startsWith(`${slotId}/`) && !configured.has(key)) this.idle.delete(key);
    return devServers.filter((resource) => {
      let skip: string | undefined;
      if (!resource.definition.watch) skip = 'skip: no watch';
      else if (!resource.definition.hooks?.boot || !resource.definition.hooks.health)
        skip = 'skip: no boot and health hooks';
      else if (resource.status !== 'running' && resource.status !== 'stale')
        skip = `skip: status ${resource.status}`;
      if (!skip) return true;
      this.idle.delete(`${slotId}/${resource.id}`);
      this.decide(slotId, resource.id, skip);
      return false;
    });
  }

  /** A slot the sweep no longer observes restarts its idle windows when it returns. */
  forget(slotId: string): void {
    for (const key of this.idle.keys()) if (key.startsWith(`${slotId}/`)) this.idle.delete(key);
  }

  async sweep(slotId: string): Promise<void> {
    const prefix = `${slotId}/`;
    const resources = await this.eligible(slotId);
    if (!resources.length) return;
    const row = await this.deps.row(slotId);
    const blocker = row ? await this.quietBlocker(slotId, row) : 'slot row unavailable';
    if (!row || blocker) {
      for (const key of this.idle.keys()) if (key.startsWith(prefix)) this.idle.delete(key);
      this.decide(slotId, undefined, `skip: ${blocker}`);
      return;
    }
    this.decide(slotId, undefined, 'quiet');
    let rows: ProcessCensusRow[] | undefined;
    for (const resource of resources) {
      const key = `${prefix}${resource.id}`;
      if (await this.deps.retained(slotId, resource.id)) {
        this.idle.delete(key);
        this.decide(slotId, resource.id, 'skip: retained by a capability lease');
        continue;
      }
      const pointer = await this.deps.pointer(slotId, resource.id, !this.idle.has(key));
      // A port-only health result without a watched PID grants no stop authority.
      if (!pointer) {
        this.idle.delete(key);
        const why = this.deps.explain?.(slotId, resource.id) ?? 'no watched process';
        this.decide(slotId, resource.id, `skip: no stop authority (${why})`);
        continue;
      }
      const observed = this.deps.observed?.(slotId, resource.id) ?? 0;
      let candidate = this.idle.get(key);
      if (
        !candidate ||
        candidate.process.pid !== String(pointer.pid) ||
        candidate.process.identity !== pointer.identity ||
        candidate.process.group !== pointer.group ||
        candidate.epoch !== row.slot_epoch ||
        candidate.owner !== row.current_run_id ||
        candidate.observed !== observed
      ) {
        rows ??= await this.deps.census(slotId);
        const process = rows.find((process) => process.pid === String(pointer.pid));
        if (!process || pointer.identity !== process.identity || pointer.group !== process.group) {
          this.idle.delete(key);
          this.decide(slotId, resource.id, 'skip: watched process not in the census');
          continue;
        }
        candidate = {
          since: this.deps.now(),
          observed,
          epoch: row.slot_epoch,
          owner: row.current_run_id,
          process,
        };
        this.idle.set(key, candidate);
      }
      const limit =
        row.warm === true && !row.current_run_id
          ? WARM_DEVSERVER_IDLE_LIMIT_MS
          : DEVSERVER_IDLE_LIMIT_MS;
      if (this.deps.now() - candidate.since < limit) {
        this.decide(
          slotId,
          resource.id,
          `idle: pid ${candidate.process.pid} stops after ${new Date(candidate.since + limit).toISOString()}${limit === WARM_DEVSERVER_IDLE_LIMIT_MS ? ' (keep-warm)' : ''}`,
        );
        continue;
      }
      rows ??= await this.deps.census(slotId);
      const root = rows.find(
        (process) =>
          process.pid === candidate.process.pid &&
          process.identity === candidate.process.identity &&
          process.group === candidate.process.group,
      );
      if (!root) {
        this.idle.delete(key);
        this.decide(slotId, resource.id, 'skip: watched process exited or changed identity');
        continue;
      }
      // An observation lost since the window started (even during this sweep) restarts it.
      const unobserved = () =>
        (this.deps.observed?.(slotId, resource.id) ?? 0) !== candidate.observed;
      if (unobserved()) {
        this.idle.delete(key);
        this.decide(slotId, resource.id, 'skip at stop: observation lost');
        continue;
      }
      // Write-ahead intent survives a gateway restart between signals and settlement.
      const current = await this.deps.row(slotId);
      const late = current
        ? await this.quietBlocker(slotId, row, resource.id)
        : 'slot row unavailable';
      if (!current || late) {
        this.decide(slotId, resource.id, `skip at stop: ${late}`);
        return;
      }
      const prior = Array.isArray(current.idle_devservers)
        ? current.idle_devservers.filter((id): id is string => typeof id === 'string')
        : [];
      if (
        !(await this.deps.write(
          slotId,
          row,
          {
            idle_devservers: [...new Set([...prior, resource.id])],
            idle_devserver_epoch: row.slot_epoch,
          },
          () => !unobserved(),
        ))
      ) {
        if (unobserved()) this.idle.delete(key);
        this.decide(
          slotId,
          resource.id,
          unobserved() ? 'skip at stop: observation lost' : 'skip at stop: slot row write refused',
        );
        return;
      }
      let lost: string | undefined;
      const stopped = await this.deps.stop(slotId, rows, [root], async () => {
        const current = await this.deps.pointer(slotId, resource.id, true);
        if (
          current?.pid !== pointer.pid ||
          current.identity !== pointer.identity ||
          current.group !== pointer.group
        ) {
          lost = current
            ? `watched process changed (${current.pid !== pointer.pid ? `pid ${current.pid}` : current.identity !== pointer.identity ? 'identity' : 'process group'})`
            : (this.deps.explain?.(slotId, resource.id) ?? 'watched process lost');
          return false;
        }
        // Last, after every awaited check: a loss during them still refuses.
        lost =
          (await this.quietBlocker(slotId, row, resource.id)) ??
          (unobserved() ? 'observation lost' : undefined);
        return !lost;
      });
      if (stopped === true) this.idle.delete(key);
      this.decide(
        slotId,
        resource.id,
        stopped === true
          ? `stopped pid ${root.pid} after the idle limit`
          : `skip at stop: ${lost ?? stopped}`,
      );
    }
  }

  /**
   * Resume only what this cap deliberately stopped, through the configured boot path. `admits`
   * lets an owner restore on a row it does not own yet (a warm child on the hold its parent's
   * cleanup left for it); every ownership check then also requires the row to still admit it.
   */
  async restore(
    slotId: string,
    ownerRunId?: string,
    admits?: (row: Readonly<Record<string, unknown>>) => boolean,
  ): Promise<void> {
    const row = await this.deps.row(slotId);
    if (!row || row.idle_devserver_epoch !== row.slot_epoch || !Array.isArray(row.idle_devservers))
      return;
    const admitted = Boolean(ownerRunId && row.current_run_id !== ownerRunId);
    if (admitted && !admits?.(row))
      throw new Error('Slot owner changed before dev server re-prepare');
    const assertOwner = async () => {
      const current = await this.deps.row(slotId);
      if (
        !current ||
        current.slot_epoch !== row.slot_epoch ||
        !sameSlotField(current.current_run_id, row.current_run_id) ||
        current.phase === 'releasing' ||
        !sameSlotField(current.handoff_run_id, row.handoff_run_id) ||
        (admitted && !admits?.(current))
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
      await this.deps.ready(slotId, resource.id, ownerRunId, assertOwner);
    }
    await assertOwner();
    if (
      !(await this.deps.write(slotId, row, { idle_devservers: null, idle_devserver_epoch: null }))
    )
      throw new Error('Slot owner changed during dev server re-prepare');
  }
}
