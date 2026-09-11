import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import {
  assertPRMonitorConfig,
  monitoredPRKey,
  type PRMonitor,
  type PRMonitorConfig,
  type PRMonitorIncident,
  type PRMonitorLifecycle,
  type PRMonitorObservation,
  type PRMonitorRepair,
  type PRProjectMonitorPolicy,
} from '@farmslot/protocol';

import { writeAtomicJSON } from '../core/atomic-json.js';

import { reconcilePRMonitorIncidents } from './incidents.js';
import { type ManualRepairSelection, planMonitorRepair } from './repair-plan.js';
import { decodeMonitorStore } from './store-schema.js';

export interface PRMonitorStoreData {
  version: 1;
  revision: number;
  monitors: PRMonitor[];
  recoveryBoundaries?: Record<string, string>;
  projectPolicies?: PRProjectMonitorPolicy[];
  publicationEnrollments?: {
    ownerId: string;
    project: string;
    runId: string;
    prKey: string;
    monitorId: string;
  }[];
}

function subscriptionKey(ownerId: string, config: PRMonitorConfig): string {
  return JSON.stringify([
    monitoredPRKey(config.pr),
    ownerId,
    config.teamId ?? null,
    config.account.host.toLowerCase(),
    config.account.login.toLowerCase(),
  ]);
}

/** One instance per gateway. No state is published until its atomic write succeeds. */
export class PRMonitorStore {
  private data: PRMonitorStoreData;
  private pending: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly file: string,
    data: PRMonitorStoreData,
  ) {
    this.data = data;
  }

  static async load(file: string): Promise<PRMonitorStore> {
    let contents: string;
    try {
      contents = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A new installation has no subscriptions. Malformed/unreadable existing files fail startup.
      return new PRMonitorStore(file, { version: 1, revision: 0, monitors: [] });
    }
    return new PRMonitorStore(file, decodeMonitorStore(JSON.parse(contents)));
  }

  list(ownerId: string): PRMonitor[] {
    return structuredClone(this.data.monitors.filter((monitor) => monitor.ownerId === ownerId));
  }

  projectPolicies(ownerId: string): PRProjectMonitorPolicy[] {
    return structuredClone(
      (this.data.projectPolicies ?? []).filter((policy) => policy.ownerId === ownerId),
    );
  }

  async saveProjectPolicy(
    ownerId: string,
    project: string,
    enabled: boolean,
    config: PRProjectMonitorPolicy['config'],
    revision?: number,
  ): Promise<PRProjectMonitorPolicy> {
    assertPRMonitorConfig({
      ...config,
      project,
      pr: { host: config.account.host, repo: 'validation/validation', number: 1 },
    });
    const settings = structuredClone(config);
    return this.change((data) => {
      const existing = data.projectPolicies?.find(
        (policy) => policy.project === project && policy.ownerId === ownerId,
      );
      if (existing && existing.revision !== revision)
        throw new Error('Project monitoring policy changed; refresh before editing');
      if (!existing && revision !== undefined)
        throw new Error('Project monitoring policy is unavailable');
      const now = new Date().toISOString();
      const policy: PRProjectMonitorPolicy = {
        ownerId,
        project,
        revision: (existing?.revision ?? 0) + 1,
        enabled,
        config: settings,
        activatedAt: existing?.enabled && enabled ? existing.activatedAt : now,
        updatedAt: now,
      };
      data.projectPolicies = (data.projectPolicies ?? [])
        .filter((item) => item.project !== project || item.ownerId !== ownerId)
        .concat(policy);
      return policy;
    });
  }

  async enrollPublication(
    ownerId: string,
    project: string,
    policyRevision: number,
    run: { id: string; project: string },
    publication: import('@farmslot/protocol').PRPublicationRecord,
    authorized: () => boolean,
  ): Promise<PRMonitor | undefined> {
    const origin = structuredClone(run);
    const event = structuredClone(publication);
    return this.change((data) => {
      const policy = data.projectPolicies?.find(
        (entry) => entry.ownerId === ownerId && entry.project === project,
      );
      if (
        !policy?.enabled ||
        policy.revision !== policyRevision ||
        origin.project !== project ||
        event.publishedAt < policy.activatedAt ||
        !authorized()
      )
        return undefined;
      if (event.pr.host.toLowerCase() !== policy.config.account.host.toLowerCase())
        throw new Error('Publication host does not match the selected account');
      const prKey = monitoredPRKey(event.pr);
      const receipts = (data.publicationEnrollments ??= []);
      const existing = receipts.find(
        (entry) =>
          entry.ownerId === ownerId &&
          entry.project === project &&
          entry.runId === origin.id &&
          entry.prKey === prKey,
      );
      if (existing) return data.monitors.find((entry) => entry.id === existing.monitorId);
      const monitor = this.subscribeRecord(
        data,
        ownerId,
        { ...policy.config, project, pr: event.pr },
        origin.id,
      );
      receipts.push({ ownerId, project, runId: origin.id, prKey, monitorId: monitor.id });
      return monitor;
    });
  }

  /** Scheduler access only. Network methods must use the principal-filtered list/get paths. */
  snapshot(): PRMonitorStoreData {
    return structuredClone(this.data);
  }

  get(id: string, ownerId: string): PRMonitor {
    return structuredClone(this.find(this.data, id, ownerId));
  }

  async subscribe(
    ownerId: string,
    config: PRMonitorConfig,
    originatingRunId?: string,
  ): Promise<PRMonitor> {
    const settings = structuredClone(config);
    return this.change((data) => this.subscribeRecord(data, ownerId, settings, originatingRunId));
  }

  async enrollRule(
    ownerId: string,
    config: PRMonitorConfig,
    isCurrent: () => boolean,
  ): Promise<PRMonitor | undefined> {
    const settings = structuredClone(config);
    return this.change((data) =>
      isCurrent() ? this.subscribeRecord(data, ownerId, settings) : undefined,
    );
  }

  private subscribeRecord(
    data: PRMonitorStoreData,
    ownerId: string,
    config: PRMonitorConfig,
    originatingRunId?: string,
  ): PRMonitor {
    assertPRMonitorConfig(config);
    if (!ownerId.trim()) throw new Error('An authenticated owner is required');
    const normalized = structuredClone(config);
    normalized.pr.host = normalized.pr.host.toLowerCase();
    normalized.pr.repo = normalized.pr.repo.toLowerCase();
    normalized.account.host = normalized.account.host.toLowerCase();
    normalized.account.login = normalized.account.login.toLowerCase();
    const key = subscriptionKey(ownerId, normalized);
    const existing = data.monitors.find(
      (item) => subscriptionKey(item.ownerId, item.config) === key,
    );
    if (existing) {
      if (originatingRunId && !existing.originatingRunIds.includes(originatingRunId)) {
        existing.originatingRunIds.push(originatingRunId);
        this.touch(existing);
      }
      return existing;
    }
    const now = new Date().toISOString();
    const monitor: PRMonitor = {
      id: randomUUID(),
      revision: 1,
      ownerId,
      config: normalized,
      lifecycle: 'active',
      createdAt: now,
      updatedAt: now,
      originatingRunIds: originatingRunId ? [originatingRunId] : [],
      incidents: [],
      nextCheckAt: now,
    };
    data.monitors.push(monitor);
    return monitor;
  }

  async configure(
    id: string,
    ownerId: string,
    revision: number,
    config: PRMonitorConfig,
  ): Promise<PRMonitor> {
    assertPRMonitorConfig(config);
    const requested = structuredClone(config);
    return this.change((data) => {
      const monitor = this.find(data, id, ownerId, revision);
      if (subscriptionKey(ownerId, requested) !== subscriptionKey(ownerId, monitor.config)) {
        throw new Error(
          'PR, team and source account identify a subscription and cannot be changed',
        );
      }
      monitor.config = requested;
      for (const repair of monitor.repairs ?? []) if (!repair.runId) delete repair.nextAdmissionAt;
      monitor.observationGeneration = (monitor.observationGeneration ?? 0) + 1;
      this.touch(monitor);
      return monitor;
    });
  }

  async setLifecycle(
    id: string,
    ownerId: string,
    revision: number,
    lifecycle: Exclude<PRMonitorLifecycle, 'finished'>,
  ): Promise<PRMonitor> {
    if (!['active', 'paused', 'stopped'].includes(lifecycle))
      throw new Error('Invalid monitor lifecycle');
    return this.change((data) => {
      const monitor = this.find(data, id, ownerId, revision);
      monitor.lifecycle = lifecycle;
      monitor.observationGeneration = (monitor.observationGeneration ?? 0) + 1;
      if (lifecycle === 'active') monitor.nextCheckAt = new Date().toISOString();
      else delete monitor.nextCheckAt;
      this.touch(monitor);
      return monitor;
    });
  }

  async observe(
    id: string,
    ownerId: string,
    expectedRevision: number,
    result: { observation: PRMonitorObservation } | { error: string; checkedAt: string },
    expectedObservationGeneration?: number,
    canObserve: () => boolean = () => true,
  ): Promise<PRMonitor | null> {
    const update = structuredClone(result);
    return this.change((data) => {
      const monitor = this.find(data, id, ownerId);
      // An in-flight provider read must not overwrite an operator's pause or policy edit.
      const stale =
        expectedObservationGeneration === undefined
          ? monitor.revision !== expectedRevision
          : (monitor.observationGeneration ?? 0) !== expectedObservationGeneration;
      if (stale || monitor.lifecycle !== 'active' || !canObserve()) return null;
      const checkedAt = 'observation' in update ? update.observation.checkedAt : update.checkedAt;
      if (!Number.isFinite(Date.parse(checkedAt))) throw new Error('Invalid observation timestamp');
      if (monitor.observation && checkedAt < monitor.observation.checkedAt) return null;
      monitor.nextCheckAt = new Date(
        Date.parse(checkedAt) + monitor.config.pollIntervalMs,
      ).toISOString();
      if ('error' in update) {
        monitor.observationError = update.error;
      } else {
        // Collection time is not provider event time. Another subscription may
        // already have confirmed recovery for this exact old incident even if
        // our delayed response is stamped later. Close known predecessors before
        // choosing chains, then mark any newly encountered historical incidents.
        const recoveredIds = new Map<string, string>();
        for (const other of data.monitors) {
          if (monitoredPRKey(other.config.pr) !== monitoredPRKey(monitor.config.pr)) continue;
          for (const incident of other.incidents) {
            if (
              incident.repairChainClosedAt &&
              incident.repairChainClosedAt > (recoveredIds.get(incident.id) ?? '')
            )
              recoveredIds.set(incident.id, incident.repairChainClosedAt);
          }
        }
        const inheritRecovery = () => {
          for (const incident of monitor.incidents) {
            const recoveredAt = recoveredIds.get(incident.id);
            if (recoveredAt && recoveredAt > (incident.repairChainClosedAt ?? ''))
              incident.repairChainClosedAt = recoveredAt;
          }
        };
        inheritRecovery();
        monitor.incidents = reconcilePRMonitorIncidents(monitor.incidents, update.observation);
        inheritRecovery();
        const boundaries = (data.recoveryBoundaries ??= {});
        const issueKey = (incident: PRMonitorIncident) => {
          const signal = incident.signal;
          return `${monitoredPRKey(monitor.config.pr)}:${signal.kind}:${signal.kind === 'check' ? (signal.checkName ?? signal.key) : signal.kind}`;
        };
        for (const incident of monitor.incidents) {
          if (incident.repairChainClosedAt)
            boundaries[issueKey(incident)] = [
              boundaries[issueKey(incident)] ?? '',
              incident.repairChainClosedAt,
            ]
              .filter(Boolean)
              .sort()
              .at(-1)!;
        }
        for (const incident of monitor.incidents) {
          const boundary = boundaries[issueKey(incident)];
          if (boundary && incident.firstObservedAt <= boundary && !incident.repairChainClosedAt)
            incident.repairChainClosedAt = boundary;
        }
        // Recovery is shared accounting evidence for this PR, like attempts.
        // A subscriber missing the passing poll must not later bridge a new
        // failure back into the closed chain when it catches up.
        for (const recovered of monitor.incidents.filter(
          (incident) => incident.repairChainClosedAt,
        )) {
          for (const other of data.monitors) {
            if (
              other.id === monitor.id ||
              monitoredPRKey(other.config.pr) !== monitoredPRKey(monitor.config.pr)
            )
              continue;
            let changed = false;
            for (const incident of other.incidents) {
              const sameIssue =
                incident.signal.kind === recovered.signal.kind &&
                (incident.signal.kind === 'conflict' ||
                  (incident.signal.kind === 'check' &&
                    (incident.signal.checkName ?? incident.signal.key) ===
                      (recovered.signal.checkName ?? recovered.signal.key)));
              if (!sameIssue || incident.firstObservedAt > recovered.repairChainClosedAt!) continue;
              if (
                !incident.repairChainClosedAt ||
                incident.repairChainClosedAt < recovered.repairChainClosedAt!
              ) {
                incident.repairChainClosedAt = recovered.repairChainClosedAt;
                changed = true;
              }
            }
            if (changed) this.touch(other);
          }
        }
        monitor.observation = update.observation;
        delete monitor.observationError;
        if (update.observation.state !== 'open') {
          monitor.lifecycle = 'finished';
          delete monitor.nextCheckAt;
        }
      }
      this.touch(monitor);
      return monitor;
    });
  }

  async acknowledge(
    id: string,
    ownerId: string,
    revision: number,
    incidentId: string,
    snoozedUntil?: string,
  ): Promise<PRMonitor> {
    if (
      snoozedUntil !== undefined &&
      (!Number.isFinite(Date.parse(snoozedUntil)) || Date.parse(snoozedUntil) <= Date.now())
    ) {
      throw new Error('Snooze must end in the future');
    }
    return this.change((data) => {
      const monitor = this.find(data, id, ownerId, revision);
      const incident = monitor.incidents.find((item) => item.id === incidentId);
      if (!incident) throw new Error('Incident not found');
      incident.acknowledgedAt = new Date().toISOString();
      if (snoozedUntil) incident.snoozedUntil = new Date(snoozedUntil).toISOString();
      this.touch(monitor);
      return monitor;
    });
  }

  async ensureRepair(
    id: string,
    ownerId: string,
    manual?: ManualRepairSelection,
    assertMutable?: () => void,
  ): Promise<PRMonitorRepair | undefined> {
    const selection = manual ? structuredClone(manual) : undefined;
    return this.change((data) => {
      if (selection) assertMutable?.();
      const monitor = this.find(data, id, ownerId);
      const before = structuredClone(monitor);
      const repair = planMonitorRepair(monitor, selection);
      if (!isDeepStrictEqual(before, monitor)) this.touch(monitor);
      return repair;
    });
  }

  /** Share execution deduplication, never credentials, report contents or another owner's run links. */
  async reconcileRepairHistory(): Promise<void> {
    await this.change((data) => {
      // Subscriptions can first observe different attempts in the same failure
      // chain. Join their chains only where the same incident proves overlap.
      // Check names alone would also join failures after confirmed recovery.
      const parents = new Map<string, string>();
      const root = (key: string): string => {
        const parent = parents.get(key);
        if (!parent || parent === key) return key;
        const result = root(parent);
        parents.set(key, result);
        return result;
      };
      const incidentKey = (monitor: PRMonitor, id: string) =>
        `${monitoredPRKey(monitor.config.pr)}:${id}`;
      for (const monitor of data.monitors) {
        for (const incident of monitor.incidents) {
          if (!incident.repairChainId) continue;
          const member = root(incidentKey(monitor, incident.id));
          const chain = root(incidentKey(monitor, incident.repairChainId));
          if (member !== chain) parents.set(member, chain);
        }
      }
      const historyKey = (monitor: PRMonitor, incident: PRMonitorIncident) =>
        root(incidentKey(monitor, incident.id));
      const history = new Map<
        string,
        { runs: Set<string>; lastAttemptAt?: string; handledAt?: string }
      >();
      for (const monitor of data.monitors) {
        for (const incident of monitor.incidents) {
          const key = historyKey(monitor, incident);
          const entry = history.get(key) ?? { runs: new Set<string>() };
          for (const repair of monitor.repairs ?? [])
            if (repair.runId && repair.incidentIds.includes(incident.id))
              entry.runs.add(repair.runId);
          if (
            incident.lastAttemptAt &&
            (!entry.lastAttemptAt || incident.lastAttemptAt > entry.lastAttemptAt)
          )
            entry.lastAttemptAt = incident.lastAttemptAt;
          if (incident.handledAt && (!entry.handledAt || incident.handledAt > entry.handledAt))
            entry.handledAt = incident.handledAt;
          history.set(key, entry);
        }
      }
      for (const monitor of data.monitors) {
        // Execution history belongs to these known incident revisions even while provider
        // observations are stale. Fresh provider reads must not erase repair limits or handling.
        const manual = monitor.repairs?.some(
          (repair) =>
            repair.mode === 'manual' && repair.state !== 'finished' && repair.state !== 'cancelled',
        );
        let changed = false;
        for (const incident of monitor.incidents) {
          const entry = history.get(historyKey(monitor, incident));
          if (!entry) continue;
          if (entry.runs.size > incident.attemptCount) {
            incident.attemptCount = entry.runs.size;
            changed = true;
          }
          if (
            entry.lastAttemptAt &&
            (!incident.lastAttemptAt || incident.lastAttemptAt < entry.lastAttemptAt)
          ) {
            incident.lastAttemptAt = entry.lastAttemptAt;
            changed = true;
          }
          if (
            !manual &&
            !incident.handledAt &&
            entry.handledAt &&
            (incident.signal.kind === 'review' || incident.signal.kind === 'feedback')
          ) {
            incident.handledAt = entry.handledAt;
            incident.waitingReason =
              'This feedback revision was handled by a prior authorized repair';
            changed = true;
          }
        }
        if (changed) this.touch(monitor);
      }
    });
  }

  async updateRepair(
    id: string,
    ownerId: string,
    repairId: string,
    patch: Partial<
      Pick<
        PRMonitorRepair,
        'state' | 'queueItemId' | 'runId' | 'waitingReason' | 'completedAt' | 'nextAdmissionAt'
      >
    >,
    options: {
      countAttempt?: boolean;
      resumeCondition?: string;
      handledFeedback?: boolean;
      frozenIncidentIds?: string[];
    } = {},
  ): Promise<PRMonitor> {
    const update = structuredClone(patch);
    options = structuredClone(options);
    return this.change((data) => {
      const monitor = this.find(data, id, ownerId);
      const repair = monitor.repairs?.find((entry) => entry.id === repairId);
      if (!repair) throw new Error('Repair request not found');
      const before = structuredClone(monitor);
      if (repair.runId && update.runId && repair.runId !== update.runId)
        throw new Error('Repair request already has a run');
      if (options.frozenIncidentIds) {
        if (repair.runId && !isDeepStrictEqual(repair.incidentIds, options.frozenIncidentIds))
          throw new Error('Repair run incident bindings are immutable');
        repair.incidentIds = options.frozenIncidentIds;
      }
      if (options.countAttempt && !update.runId)
        throw new Error('Counting a repair attempt requires its run identity');
      if (options.countAttempt && !repair.runId) {
        for (const incident of monitor.incidents.filter((entry) =>
          repair.incidentIds.includes(entry.id),
        )) {
          incident.attemptCount += 1;
          incident.lastAttemptAt = new Date().toISOString();
          incident.runId = update.runId;
        }
      }
      Object.assign(repair, update);
      for (const incident of monitor.incidents.filter((entry) =>
        repair.incidentIds.includes(entry.id),
      )) {
        if (update.queueItemId) incident.queueItemId = update.queueItemId;
        if (options.resumeCondition) {
          incident.resumeCondition = options.resumeCondition;
          incident.waitingReason = options.resumeCondition;
        }
        if (
          options.handledFeedback &&
          (incident.signal.kind === 'review' || incident.signal.kind === 'feedback')
        ) {
          incident.handledAt = new Date().toISOString();
          incident.waitingReason = 'Repair completed; awaiting reviewer resolution';
        }
      }
      if (!isDeepStrictEqual(before, monitor)) this.touch(monitor);
      return monitor;
    });
  }

  private find(
    data: PRMonitorStoreData,
    id: string,
    ownerId: string,
    revision?: number,
  ): PRMonitor {
    const monitor = data.monitors.find((item) => item.id === id && item.ownerId === ownerId);
    if (!monitor) throw new Error('Monitor not found');
    if (revision !== undefined && monitor.revision !== revision) {
      throw new Error('Monitor changed; refresh before editing');
    }
    return monitor;
  }

  private touch(monitor: PRMonitor): void {
    monitor.revision += 1;
    monitor.updatedAt = new Date().toISOString();
  }

  private change<T>(mutate: (data: PRMonitorStoreData) => T): Promise<T> {
    const operation = async () => {
      const draft = structuredClone(this.data);
      const result = mutate(draft);
      if (isDeepStrictEqual(draft, this.data)) return structuredClone(result);
      draft.revision += 1;
      decodeMonitorStore(draft);
      await writeAtomicJSON(this.file, draft);
      this.data = draft;
      return structuredClone(result);
    };
    // The failed transaction rejects to its caller and leaves memory unchanged.
    // A later mutation may retry persistence rather than inheriting that rejection.
    const result = this.pending.then(operation, operation);
    this.pending = result;
    return result;
  }
}
