import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import {
  isTerminalRunStatus,
  monitoredPRKey,
  type PRMonitor,
  type PRMonitorRepair,
  type QueueItem,
  type Run,
} from '@farmslot/protocol';

import {
  addItem,
  getQueueSnapshot,
  persistQueueNow,
  removeQueueItemInternalNow,
  tryDispatchNext,
} from '../backlog/dispatch-queue.js';
import {
  type PRQueueAdmissionHooks,
  type PRQueuePreparation,
  runOwnsPR,
} from '../backlog/pr-admission.js';
import { resolvePRExecution, verifyPRRepairExecution } from '../backlog/pr-execution.js';
import { getAllRuns, runRecordPath } from '../runs/store.js';

import { monitorRepairIsOpen, monitorRepairRefusal } from './repair-plan.js';
import type { PRMonitoringService } from './service.js';
import type { PRMonitorStore } from './store.js';

function workId(repair: PRMonitorRepair): string {
  return `repair:${repair.id}`;
}
function repairRunRevisions(): Map<string, string> {
  const revisions = new Map<string, string[]>();
  for (const run of getAllRuns()) {
    if (run.prWork?.kind !== 'repair') continue;
    const key = monitoredPRKey(run.prWork.pr);
    const values = revisions.get(key) ?? [];
    values.push(
      JSON.stringify([
        run.id,
        run.status,
        run.completedAt,
        run.engineState?.operatorForceCompleted,
      ]),
    );
    revisions.set(key, values);
  }
  return new Map([...revisions].map(([key, values]) => [key, JSON.stringify(values.sort())]));
}
function fingerprint(monitor: PRMonitor, repair: PRMonitorRepair): string {
  const incidents = monitor.incidents
    .filter((item) => repair.incidentIds.includes(item.id))
    .map((item) => [
      item.id,
      item.resolvedAt,
      item.handledAt,
      item.resumeCondition,
      item.attemptCount,
      item.snoozedUntil,
      item.lastAttemptAt,
    ]);
  return createHash('sha256')
    .update(
      JSON.stringify([
        monitor.lifecycle,
        monitor.config,
        monitor.observationError,
        monitor.observation?.headSha,
        monitor.observation?.repairAccess,
        repair,
        incidents,
      ]),
    )
    .digest('hex');
}

export class PRRepairDispatcher implements PRQueueAdmissionHooks {
  private timer?: ReturnType<typeof setInterval>;
  private reconciling?: Promise<void>;
  private reconciledRunRevisions = new Map<string, string>();
  private readonly proofs = new Map<
    string,
    { fingerprint: string; checkedAt: number; selection: string }
  >();
  error?: string;

  constructor(
    private readonly store: PRMonitorStore,
    private readonly monitors: Pick<PRMonitoringService, 'refresh'>,
    private readonly authorized: (ownerId: string) => boolean,
    private readonly changed: (monitor: PRMonitor) => void,
    private readonly resolveExecution: typeof resolvePRExecution = resolvePRExecution,
    private readonly verifyExecution: typeof verifyPRRepairExecution = verifyPRRepairExecution,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), 10_000);
    this.timer.unref();
    this.wake();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  wake(): void {
    void this.reconcile().then(
      () => {
        this.error = undefined;
      },
      (error: unknown) => {
        // The API exposes persistence/system faults; later ticks retry without publishing partial state.
        this.error = error instanceof Error ? error.message : String(error);
      },
    );
  }
  reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.reconcileOnce().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async observeRuns(): Promise<void> {
    for (const original of this.store.snapshot().monitors) {
      const monitor = this.store.get(original.id, original.ownerId);
      for (const repair of monitor.repairs ?? []) {
        const run = getAllRuns().find((entry) => entry.prWork?.id === workId(repair));
        if (!run) continue;
        if (!existsSync(runRecordPath(run.id))) continue;
        await this.observeRun(monitor, repair, run);
        const orphan = getQueueSnapshot().find((entry) => entry.prWork?.id === workId(repair));
        if (orphan) await removeQueueItemInternalNow(orphan.id, 'pr-repair-run-recovered');
      }
    }
  }

  private async reconcileOnce(): Promise<void> {
    const runRevisions = repairRunRevisions();
    await this.observeRuns();
    const revisions = new Map(
      this.store.snapshot().monitors.map((monitor) => [monitor.id, monitor.revision]),
    );
    await this.store.reconcileRepairHistory();
    this.reconciledRunRevisions = runRevisions;
    for (const monitor of this.store.snapshot().monitors)
      if (monitor.revision !== revisions.get(monitor.id)) this.changed(monitor);
    for (const original of this.store.snapshot().monitors) {
      let monitor = this.store.get(original.id, original.ownerId);
      const running = (monitor.repairs ?? []).some((repair) =>
        getAllRuns().some(
          (run) => run.prWork?.id === workId(repair) && !isTerminalRunStatus(run.status),
        ),
      );
      if (running) {
        monitor = this.store.get(monitor.id, monitor.ownerId);
        for (const pending of (monitor.repairs ?? []).filter(
          (entry) =>
            monitorRepairIsOpen(entry) &&
            !entry.runId &&
            entry.mode === 'automatic' &&
            !getAllRuns().some((run) => run.prWork?.id === workId(entry)),
        )) {
          await this.update(monitor, pending, {
            state: 'cancelled',
            completedAt: new Date().toISOString(),
            queueItemId: undefined,
            waitingReason:
              'An existing repair run resumed; incidents will be reassessed after it finishes',
          });
          const row = getQueueSnapshot().find((entry) => entry.prWork?.id === workId(pending));
          if (row) await removeQueueItemInternalNow(row.id, 'pr-repair-owner-resumed');
        }
        continue;
      }
      if (this.authorized(monitor.ownerId))
        await this.store.ensureRepair(monitor.id, monitor.ownerId);
      const previousRevision = monitor.revision;
      monitor = this.store.get(monitor.id, monitor.ownerId);
      if (monitor.revision !== previousRevision) this.changed(monitor);
      const repair = monitor.repairs?.find(monitorRepairIsOpen);
      if (!repair || repair.runId) continue;
      let queued = getQueueSnapshot().find((entry) => entry.prWork?.id === workId(repair));
      const disabled =
        monitor.lifecycle !== 'active' ||
        (repair.mode === 'automatic' && monitor.config.policy.mode !== 'automatic-repair');
      const resolved = repair.incidentIds.every((id) =>
        monitor.incidents.some(
          (incident) => incident.id === id && (incident.resolvedAt || incident.handledAt),
        ),
      );
      if (disabled || resolved) {
        await this.update(monitor, repair, {
          state: 'cancelled',
          completedAt: new Date().toISOString(),
          queueItemId: undefined,
          waitingReason: disabled
            ? 'Monitoring policy stopped this repair'
            : 'Requested issues are no longer actionable',
        });
        if (queued) await removeQueueItemInternalNow(queued.id, 'pr-repair-withdrawn');
        continue;
      }
      if ((!queued && repair.queueItemId) || queued?.status === 'cancelled') {
        await this.update(
          monitor,
          repair,
          {
            state: 'cancelled',
            completedAt: new Date().toISOString(),
            queueItemId: undefined,
            waitingReason: 'Repair dispatch was removed',
          },
          { resumeCondition: 'Repair dispatch was removed; request repair explicitly to resume' },
        );
        if (queued) await removeQueueItemInternalNow(queued.id, 'pr-repair-cancelled');
        continue;
      }
      const reason = this.refusal(monitor, repair);
      if (reason) {
        await this.suspend(monitor, repair, queued, reason);
        continue;
      }
      const execution = await this.resolveExecution(repair.project, monitor.config.pr.repo, [
        repair.execution,
      ]);
      if (!execution.choices.length) {
        await this.suspend(monitor, repair, queued, execution.errors.join('; '));
        continue;
      }
      const latest = this.store.get(monitor.id, monitor.ownerId);
      const current = latest.repairs?.find((entry) => entry.id === repair.id);
      if (!current || fingerprint(latest, current) !== fingerprint(monitor, repair)) continue;
      if (getAllRuns().some((run) => run.prWork?.id === workId(repair))) continue;
      if (
        queued &&
        (queued.project !== repair.project ||
          queued.prWork?.headSha !== repair.headSha ||
          !isDeepStrictEqual(queued.prWork?.incidentIds, repair.incidentIds))
      ) {
        await this.update(monitor, repair, { state: 'pending', queueItemId: undefined });
        await removeQueueItemInternalNow(queued.id, 'pr-repair-remapped');
        queued = undefined;
      }
      const choice = execution.choices[0];
      const item =
        queued ??
        addItem(
          {
            prWork: {
              kind: 'repair',
              id: workId(repair),
              sourceId: monitor.id,
              pr: monitor.config.pr,
              headSha: repair.headSha,
              incidentIds: [...repair.incidentIds],
            },
            flowType: 'pr-complete',
            project: repair.project,
            ticketOrPr: `${monitor.config.pr.repo}#${monitor.config.pr.number}`,
            runner: choice.runner,
            model: choice.model,
            effort: choice.effort,
            allowedSlots: [...new Set(execution.choices.map((entry) => entry.slotId))],
            autoDispatch: false,
            initialContext: `Handle these observed PR incidents without changing monitoring policy:\n${monitor.incidents
              .filter((incident) => repair.incidentIds.includes(incident.id))
              .map(
                (incident) => `${incident.id}: ${incident.signal.summary}\n${incident.signal.url}`,
              )
              .join('\n')}`,
          },
          { kind: 'principal', principalId: monitor.ownerId },
        );
      await persistQueueNow();
      const after = this.store.get(monitor.id, monitor.ownerId);
      const pending = after.repairs?.find((entry) => entry.id === repair.id);
      if (!pending) {
        await removeQueueItemInternalNow(item.id, 'pr-repair-policy-changed');
        continue;
      }
      const changedReason = this.refusal(after, pending);
      if (changedReason) {
        await this.suspend(after, pending, item, changedReason);
        continue;
      }
      if (pending.queueItemId !== item.id || pending.state !== 'queued')
        await this.update(after, pending, {
          queueItemId: item.id,
          state: 'queued',
          waitingReason: 'Awaiting an allowed slot and model',
        });
    }
    if (
      getQueueSnapshot().some((item) => item.prWork?.kind === 'repair' && item.status === 'queued')
    )
      await tryDispatchNext();
  }

  private lookup(item: QueueItem): { monitor: PRMonitor; repair: PRMonitorRepair } | undefined {
    if (item.prWork?.kind !== 'repair') return undefined;
    const monitor = this.store
      .snapshot()
      .monitors.find((entry) => entry.id === item.prWork?.sourceId);
    const repair = monitor?.repairs?.find((entry) => workId(entry) === item.prWork?.id);
    return monitor && repair ? { monitor, repair } : undefined;
  }
  private refusal(monitor: PRMonitor, repair: PRMonitorRepair): string | undefined {
    if (!this.authorized(monitor.ownerId)) return 'Repair owner no longer has execution authority';
    const key = monitoredPRKey(monitor.config.pr);
    if (repairRunRevisions().get(key) !== this.reconciledRunRevisions.get(key))
      return 'Repair run outcomes changed; awaiting shared history reconciliation';
    const reason = monitorRepairRefusal(monitor, repair);
    if (reason) return reason;
    if (monitor.config.pr.host.toLowerCase() !== 'github.com')
      return 'Project execution does not bind this GitHub host';
    const run = getAllRuns().find((entry) => runOwnsPR(entry, monitor.config.pr, repair.project));
    if (run) return `Waiting for PR execution owned by run ${run.id}`;
    const other = getQueueSnapshot().find(
      (entry) =>
        entry.prWork?.kind === 'repair' &&
        entry.prWork.sourceId !== monitor.id &&
        entry.status !== 'cancelled' &&
        monitoredPRKey(entry.prWork.pr) === monitoredPRKey(monitor.config.pr),
    );
    if (other) return 'Another subscription has already queued repair for this PR';
    return undefined;
  }
  async prepare(item: QueueItem): Promise<PRQueuePreparation> {
    const context = this.lookup(item);
    if (!context || context.repair.queueItemId !== item.id || context.repair.state !== 'queued')
      return { ready: false, reason: 'Repair queue linkage is not ready' };
    if (
      item.project !== context.repair.project ||
      item.prWork?.headSha !== context.repair.headSha ||
      !isDeepStrictEqual(item.prWork?.incidentIds, context.repair.incidentIds)
    )
      return {
        ready: false,
        reason: 'Repair head or project changed; queue replacement is pending',
      };
    const reason = this.refusal(context.monitor, context.repair);
    if (reason) return { ready: false, reason };
    const result = await this.resolveExecution(
      context.repair.project,
      context.monitor.config.pr.repo,
      [context.repair.execution],
    );
    return result.choices.length
      ? { ready: true, choices: result.choices }
      : { ready: false, reason: result.errors.join('; ') };
  }
  async refreshBeforeCreate(item: QueueItem): Promise<void> {
    const initial = this.lookup(item);
    if (!initial) throw new Error('Repair request is unavailable');
    const startedAt = Date.now();
    await this.monitors.refresh(initial.monitor.id, initial.monitor.ownerId);
    const current = this.lookup(item);
    if (
      !current ||
      !current.monitor.observation ||
      Date.parse(current.monitor.observation.checkedAt) < startedAt
    )
      throw new Error('Fresh repair observations are not available yet');
    const expected = fingerprint(current.monitor, current.repair);
    const prepared = await this.prepare(item);
    if (!prepared.ready) throw new Error(prepared.reason);
    try {
      if (!item.slotId || !current.monitor.observation.repairAccess?.headBranch)
        throw new Error('Selected slot and head branch must be known before repair');
      await this.verifyExecution(
        item.slotId,
        current.monitor.config.account,
        current.monitor.config.pr.repo,
        current.monitor.observation.repairAccess.headBranch,
      );
    } catch (error) {
      const latest = this.lookup(item);
      if (latest && expected === fingerprint(latest.monitor, latest.repair))
        await this.update(latest.monitor, latest.repair, {
          state: 'blocked',
          waitingReason: error instanceof Error ? error.message : String(error),
          nextAdmissionAt: new Date(
            Date.now() + latest.monitor.config.pollIntervalMs,
          ).toISOString(),
        });
      throw error;
    }
    const latest = this.lookup(item);
    if (!latest || expected !== fingerprint(latest.monitor, latest.repair))
      throw new Error('Repair policy or evidence changed during admission');
    const selection = JSON.stringify([item.slotId, item.runner, item.model, item.effort]);
    if (
      !prepared.choices.some(
        (choice) =>
          JSON.stringify([choice.slotId, choice.runner, choice.model, choice.effort]) === selection,
      )
    )
      throw new Error('Selected repair execution is no longer authorized');
    this.proofs.set(item.id, { fingerprint: expected, checkedAt: Date.now(), selection });
  }
  assertCurrent(item: QueueItem): void {
    const current = this.lookup(item);
    const proof = this.proofs.get(item.id);
    if (
      !current ||
      !proof ||
      Date.now() - proof.checkedAt > 60_000 ||
      proof.fingerprint !== fingerprint(current.monitor, current.repair) ||
      proof.selection !== JSON.stringify([item.slotId, item.runner, item.model, item.effort])
    )
      throw new Error('Repair admission changed; revalidate before dispatch');
    const reason = this.refusal(current.monitor, current.repair);
    if (reason) throw new Error(reason);
  }
  async created(item: QueueItem, run: Run): Promise<void> {
    const current = this.lookup(item);
    if (!current) throw new Error('Repair request is unavailable');
    await this.update(
      current.monitor,
      current.repair,
      { state: 'running', runId: run.id, waitingReason: undefined },
      { countAttempt: true, frozenIncidentIds: run.prWork?.incidentIds },
    );
    this.proofs.delete(item.id);
  }
  private async suspend(
    monitor: PRMonitor,
    repair: PRMonitorRepair,
    queued: QueueItem | undefined,
    reason: string,
  ): Promise<void> {
    await this.update(monitor, repair, {
      state: 'blocked',
      queueItemId: undefined,
      waitingReason: reason,
    });
    if (queued) await removeQueueItemInternalNow(queued.id, 'pr-repair-suspended');
  }
  private async update(
    monitor: PRMonitor,
    repair: PRMonitorRepair,
    patch: Parameters<PRMonitorStore['updateRepair']>[3],
    options?: Parameters<PRMonitorStore['updateRepair']>[4],
  ): Promise<void> {
    const changed = await this.store.updateRepair(
      monitor.id,
      monitor.ownerId,
      repair.id,
      patch,
      options,
    );
    if (changed.revision !== monitor.revision) this.changed(changed);
  }
  private async observeRun(monitor: PRMonitor, repair: PRMonitorRepair, run: Run): Promise<void> {
    if (!run.prWork?.incidentIds?.length) {
      await this.update(
        monitor,
        repair,
        {
          runId: run.id,
          state: isTerminalRunStatus(run.status) ? 'finished' : 'blocked',
          waitingReason: 'Repair run lacks frozen incident bindings; inspect the linked run',
        },
        {
          resumeCondition: 'Inspect the previous repair before explicitly resuming these incidents',
        },
      );
      return;
    }
    if (!repair.runId) {
      await this.update(
        monitor,
        repair,
        { runId: run.id, state: 'running' },
        { countAttempt: true, frozenIncidentIds: run.prWork?.incidentIds },
      );
      monitor = this.store.get(monitor.id, monitor.ownerId);
      repair = monitor.repairs!.find((entry) => entry.id === repair.id)!;
    }
    if (isTerminalRunStatus(run.status)) {
      if (!monitorRepairIsOpen(repair)) return;
      const forced = run.engineState?.operatorForceCompleted === true;
      await this.update(
        monitor,
        repair,
        {
          state: run.status === 'cancelled' ? 'cancelled' : 'finished',
          completedAt: run.completedAt ?? new Date().toISOString(),
          waitingReason:
            run.status === 'done' ? undefined : (run.error ?? `Repair run ${run.status}`),
        },
        {
          handledFeedback: run.status === 'done' && !forced,
          ...(run.status === 'cancelled' || forced
            ? {
                resumeCondition:
                  'Previous repair was stopped by an operator; request repair explicitly after the blocker is resolved',
              }
            : {}),
        },
      );
    } else {
      const decision = [...run.decisions].reverse().find((entry) => !entry.resolvedAt);
      const blocked =
        run.status === 'blocked' || run.status === 'human-gating' || run.status === 'paused';
      await this.update(monitor, repair, {
        state: blocked ? 'blocked' : 'running',
        waitingReason: blocked
          ? decision?.description || 'Resolve the linked run decision before repair can continue'
          : undefined,
      });
    }
  }
}
