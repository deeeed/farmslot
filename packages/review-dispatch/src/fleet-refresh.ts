import {
  Events,
  type FleetRefreshScheduledEvent,
  type FleetRefreshSlotsResult,
  type FleetRefreshSlotStatus,
  type FleetRefreshSlotUpdateEvent,
  type FleetRefreshSummaryEvent,
  type FleetStatusResult,
  Methods,
  type ScriptOutput,
  type SlotRecoveryEligibility,
  slotRecoveryEligibility,
  type SlotRefreshResult,
  type SlotStatus,
  type SlotWorkspaceIdentity,
  slotWorkspaceIdentity,
} from '@farmslot/protocol';

export interface FleetRefreshClient {
  contextKey(): string;
  request<T>(method: string, params?: unknown, timeout?: number): Promise<T>;
  subscribe(event: string, callback: (payload: unknown) => void): () => void;
}

export interface FleetWorkspaceRow {
  slotId: string;
  branch: string;
  owner: string;
  publication: string;
  behind: string;
  referenceTime: string;
  action: string;
  warning: string;
  eligibility: SlotRecoveryEligibility;
}

/** Used by both fleet cards and both progress renderers. */
export function fleetWorkspaceRow(slot: SlotStatus): FleetWorkspaceRow {
  const work = slot.workspace;
  const defaultBranch = work?.defaultBranch ?? 'main';
  const currentRun = work ? work.currentRunId : slot.currentRunId;
  const eligibility = slotRecoveryEligibility(slot);
  const owners = [
    currentRun ? `Run ${currentRun.slice(0, 8)}` : null,
    (work ? work.cleanupRunId : slot.cleanupRunId)
      ? `Cleanup ${(work ? work.cleanupRunId : slot.cleanupRunId)!.slice(0, 8)}`
      : null,
    (work ? work.handoffRunId : slot.handoffRunId)
      ? `Handoff ${(work ? work.handoffRunId : slot.handoffRunId)!.slice(0, 8)}`
      : null,
  ].filter((value): value is string => !!value);
  return {
    slotId: slot.slot,
    branch: work?.branch ?? slot.branch ?? 'Unknown branch',
    owner: owners.length ? owners.join(' / ') : 'Unowned',
    publication: eligibility.reason === 'unknown' ? 'unknown' : (work?.publication ?? 'unknown'),
    behind:
      eligibility.reason === 'unknown' || work?.behind == null
        ? `Behind ${defaultBranch} unknown`
        : `${work.behind} behind ${defaultBranch}${work.remoteAdvanced ? ' · remote advanced' : ''}`,
    referenceTime:
      work?.defaultFetchedAt && Number.isFinite(Date.parse(work.defaultFetchedAt))
        ? `Fetched ${new Date(work.defaultFetchedAt).toISOString().slice(0, 16).replace('T', ' ')}Z`
        : 'Fetch time unknown',
    action:
      eligibility.reason === 'unknown' && (!work || work.publication === 'unknown')
        ? 'Inspect workspace'
        : work?.recovery
          ? 'Retry release and update to main'
          : 'Release and update to main',
    warning: eligibility.confirmationRequired
      ? `${work?.dirtyCount ?? 0} changed files, ${work?.unpublishedCount ?? 0} unpublished commits on ${work?.branch ?? slot.branch}`
      : (eligibility.detail ?? slot.workspaceError ?? ''),
    eligibility,
  };
}

export function fleetRecoverySummary(slots: readonly SlotStatus[]): {
  count: number;
  canInspect: boolean;
} {
  const eligibility = slots.map((slot) => slotRecoveryEligibility(slot));
  return {
    count: eligibility.filter((row) => row.bulkAllowed).length,
    canInspect: eligibility.some((row) => row.bulkInspectable),
  };
}

export interface FleetRefreshRow extends FleetWorkspaceRow {
  slot: SlotStatus;
  status: FleetRefreshSlotStatus | 'idle';
  detail: string;
  log: string[];
}
export interface FleetDiscardConfirmation {
  slotId: string;
  warning: string;
  identity: SlotWorkspaceIdentity;
}

/** One state machine for CC and Companion. Clients only render and forward presses. */
export class FleetRefreshViewModel {
  rows: FleetRefreshRow[] = [];
  phase: 'loading' | 'review' | 'running' | 'done' | 'error' = 'loading';
  error = '';
  summary: FleetRefreshSummaryEvent | null = null;
  confirmation: FleetDiscardConfirmation | null = null;
  private listeners = new Set<() => void>();
  private unsubscribers: Array<() => void> = [];
  private scope: ReadonlySet<string> | null = null;
  private requestId = '';
  private bulkRunning = false;
  get canCancel(): boolean {
    return this.phase === 'running' && this.bulkRunning;
  }
  private perSlotIds = new Map<string, string>();
  private activeTargets = new Set<string>();
  private loadGeneration = 0;
  private inspectedContext: string | undefined;
  constructor(
    private readonly client: FleetRefreshClient,
    private readonly makeId: () => string,
  ) {}
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  get bulkCount(): number {
    return this.rows.filter((row) => row.eligibility.bulkAllowed).length;
  }
  async load(slotIds?: readonly string[]): Promise<void> {
    const generation = ++this.loadGeneration;
    const context = this.client.contextKey();
    this.inspectedContext = undefined;
    this.rows = [];
    this.summary = null;
    this.detach();
    this.scope = slotIds ? new Set(slotIds) : null;
    this.phase = 'loading';
    this.error = '';
    this.confirmation = null;
    this.changed();
    try {
      const { fleet } = await this.client.request<FleetStatusResult>(Methods.FLEET_STATUS, {});
      if (generation !== this.loadGeneration) return;
      if (context !== this.client.contextKey())
        throw new Error('Farm connection changed; inspect again');
      this.inspectedContext = context;
      this.rows = fleet.slots
        .filter((slot) => !this.scope || this.scope.has(slot.slot))
        .map((slot) => ({ ...fleetWorkspaceRow(slot), slot, status: 'idle', detail: '', log: [] }));
      this.phase = 'review';
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.phase = 'error';
    }
    this.changed();
  }
  private sameContext(): boolean {
    if (this.inspectedContext !== undefined && this.inspectedContext === this.client.contextKey())
      return true;
    this.rows = [];
    this.confirmation = null;
    this.phase = 'error';
    this.error = 'Farm connection changed; inspect again';
    this.changed();
    return false;
  }
  cancelConfirmation(): void {
    this.confirmation = null;
    this.changed();
  }
  async release(slotId: string): Promise<void> {
    if (!this.sameContext()) return;
    const row = this.rows.find((value) => value.slotId === slotId);
    if (!row) return;
    if (row.status === 'failed') {
      await this.load(this.rows.map((value) => value.slotId));
      const fresh = this.rows.find((value) => value.slotId === slotId);
      if (fresh?.eligibility.allowed) await this.release(slotId);
      return;
    }
    if (row.eligibility.reason === 'unknown') {
      const releaseRequested = row.action !== 'Inspect workspace';
      await this.load(this.rows.map((value) => value.slotId));
      const fresh = this.rows.find((value) => value.slotId === slotId);
      if (releaseRequested && fresh?.eligibility.allowed) await this.release(slotId);
      return;
    }
    if (!row.eligibility.allowed || !row.slot.workspace) return;
    if (row.eligibility.confirmationRequired) {
      this.confirmation = {
        slotId,
        warning: row.warning,
        identity: slotWorkspaceIdentity(row.slot.workspace),
      };
      this.changed();
      return;
    }
    await this.releaseOne(slotId, 'safe', slotWorkspaceIdentity(row.slot.workspace));
  }
  async confirmDiscard(): Promise<void> {
    if (!this.sameContext()) return;
    const confirmation = this.confirmation;
    if (!confirmation) return;
    this.confirmation = null;
    this.changed();
    await this.releaseOne(confirmation.slotId, 'force', confirmation.identity);
  }
  private async refreshRows(): Promise<void> {
    if (!this.sameContext()) return;
    const { fleet } = await this.client.request<FleetStatusResult>(Methods.FLEET_STATUS, {});
    if (!this.sameContext()) return;
    const current = new Map(fleet.slots.map((slot) => [slot.slot, slot]));
    this.rows = this.rows.map((row) => {
      const slot = current.get(row.slotId);
      return slot ? { ...row, ...fleetWorkspaceRow(slot), slot } : row;
    });
    this.changed();
  }
  private update(slotId: string, fields: Partial<FleetRefreshRow>): void {
    this.rows = this.rows.map((row) => (row.slotId === slotId ? { ...row, ...fields } : row));
    this.changed();
  }
  private setPerSlotIds(ids: Record<string, string>): void {
    for (const [slotId, id] of Object.entries(ids))
      if (this.activeTargets.has(slotId)) this.perSlotIds.set(id, slotId);
  }
  private attach(requestId: string): void {
    this.detach();
    this.requestId = requestId;
    this.unsubscribers.push(
      this.client.subscribe(Events.FLEET_REFRESH_SCHEDULED, (payload) => {
        const event = payload as FleetRefreshScheduledEvent;
        if (event.requestId !== requestId || !this.sameContext()) return;
        this.setPerSlotIds(event.perSlotRequestIds);
      }),
    );
    this.unsubscribers.push(
      this.client.subscribe(Events.FLEET_REFRESH_SLOT_UPDATE, (payload) => {
        const event = payload as FleetRefreshSlotUpdateEvent;
        if (event.requestId !== requestId || !this.sameContext()) return;
        this.update(event.slotId, {
          status: event.status,
          detail: event.detail ?? event.reason ?? '',
        });
      }),
    );
    this.unsubscribers.push(
      this.client.subscribe(Events.FLEET_REFRESH_SUMMARY, (payload) => {
        const event = payload as FleetRefreshSummaryEvent;
        if (event.requestId !== requestId || !this.sameContext()) return;
        this.summary = event;
        this.bulkRunning = false;
        void this.refreshRows()
          .then(() => {
            if (event.requestId !== this.requestId || !this.sameContext()) return;
            this.phase = 'done';
            this.detach();
            this.changed();
          })
          .catch((error: unknown) => {
            if (event.requestId !== this.requestId || !this.sameContext()) return;
            this.error = error instanceof Error ? error.message : String(error);
            this.rows = this.rows.map((row) => {
              const slot = { ...row.slot, workspace: undefined, workspaceError: this.error };
              return { ...row, ...fleetWorkspaceRow(slot), slot };
            });
            this.phase = 'error';
            this.detach();
            this.changed();
          });
        this.changed();
      }),
    );
    this.unsubscribers.push(
      this.client.subscribe(Events.SCRIPT_OUTPUT, (payload) => {
        const event = payload as ScriptOutput;
        const slotId = this.perSlotIds.get(event.requestId);
        const row = this.rows.find((value) => value.slotId === slotId);
        if (row)
          this.update(row.slotId, {
            log: [...row.log, ...event.data.split('\n').filter(Boolean)].slice(-100),
          });
      }),
    );
  }
  private async releaseOne(
    slotId: string,
    mode: 'safe' | 'force',
    identity: SlotWorkspaceIdentity,
  ): Promise<void> {
    if (!this.sameContext()) return;
    const requestId = this.makeId();
    this.bulkRunning = false;
    this.activeTargets = new Set([slotId]);
    this.attach(requestId);
    this.perSlotIds = new Map([[requestId, slotId]]);
    this.phase = 'running';
    this.update(slotId, { status: 'running', detail: '', log: [] });
    try {
      const result = await this.client.request<SlotRefreshResult>(
        Methods.SLOT_REFRESH,
        { slotId, mode, release: true, expectedWorkspace: identity, requestId },
        30 * 60_000,
      );
      if (!this.sameContext()) {
        this.detach();
        return;
      }
      this.update(slotId, {
        status: result.refreshed ? 'refreshed' : 'failed',
        detail: result.detail ?? result.reason ?? 'Ready on main',
      });
      this.phase = 'done';
      await this.refreshRows();
    } catch (error) {
      this.update(slotId, {
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
      this.phase = 'done';
    }
    this.detach();
    this.changed();
  }
  async releaseIdle(): Promise<void> {
    if (!this.sameContext()) return;
    // Freeze exact logical membership before the request. No bulk force path.
    const targets = this.rows
      .filter((row) => row.eligibility.bulkAllowed && row.slot.workspace)
      .map((row) => ({
        slotId: row.slotId,
        mode: 'safe' as const,
        release: true,
        expectedWorkspace: slotWorkspaceIdentity(row.slot.workspace!),
      }));
    if (!targets.length) return;
    const requestId = this.makeId();
    this.bulkRunning = true;
    this.attach(requestId);
    this.activeTargets = new Set(targets.map((target) => target.slotId));
    this.perSlotIds = new Map();
    for (const target of targets)
      this.update(target.slotId, { status: 'pending', detail: '', log: [] });
    this.phase = 'running';
    this.changed();
    try {
      const result = await this.client.request<FleetRefreshSlotsResult>(
        Methods.FLEET_REFRESH_SLOTS,
        { requestId, slots: targets },
        30 * 60_000,
      );
      if (!this.sameContext()) return;
      if (result.requestId !== requestId) throw new Error('Bulk request identity changed');
      this.setPerSlotIds(result.perSlotRequestIds);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.phase = 'error';
      this.detach();
      this.changed();
    }
  }
  async cancel(): Promise<void> {
    if (!this.canCancel || !this.sameContext()) return;
    try {
      await this.client.request(Methods.FLEET_REFRESH_SLOTS_CANCEL, { requestId: this.requestId });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.changed();
    }
  }
  private detach(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
  }
  dispose(): void {
    ++this.loadGeneration;
    this.detach();
    this.listeners.clear();
  }
}
