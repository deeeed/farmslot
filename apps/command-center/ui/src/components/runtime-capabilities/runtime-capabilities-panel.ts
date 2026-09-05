import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  Events,
  Methods,
  type RuntimeCapabilityAcquireResult,
  type RuntimeCapabilityCatalogEntry,
  type RuntimeCapabilityLease,
  type RuntimeCapabilityLifecyclePayload,
  type RuntimeCapabilityProofRequirement,
  type RuntimeCapabilityReleaseResult,
  type RuntimeCapabilityStatusResult,
  type RuntimeCapabilityStopWarmResult,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors } from '../../styles/theme-tokens.js';

import {
  projectRuntimeCapabilityLeases,
  type RuntimeCapabilityRecoveryAction,
  runtimeCapabilityRecoveryActions,
  type RuntimeCapabilityRetentionView,
  runtimeCapabilityRetentionView,
  runtimeCapabilityStopUsesWarmPath,
  type RuntimeCapabilityStopWarmView,
  stopWarmOutcomeView,
} from './runtime-capabilities-panel-model.js';

@customElement('runtime-capabilities-panel')
export class RuntimeCapabilitiesPanel extends LitElement {
  @property({ type: String }) slotId = '';
  /**
   * Run that owns recovery actions taken from this panel. Acquire needs an owner
   * run id, so without one the panel offers only what it can honestly perform.
   */
  @property({ type: String }) runId = '';

  @state() private status: RuntimeCapabilityStatusResult | null = null;
  @state() private error = '';
  @state() private loading = false;
  /** Capability id currently running a recovery action, with which action it is. */
  @state() private busyAction: {
    capabilityId: string;
    action: RuntimeCapabilityRecoveryAction;
  } | null = null;
  /** Last recovery-action failure. Kept out of `error` so a refresh cannot erase it. */
  @state() private actionError = '';
  /**
   * Latest `runtime.capability.stopWarm` outcome, keyed by slot AND capability.
   * Capability alone let one slot's answer render against another slot's row
   * after the operator navigated. Held separately from the fetch state so a
   * refresh cannot erase the Gateway's answer.
   */
  @state() private stopWarmViews: Record<string, RuntimeCapabilityStopWarmView | undefined> = {};

  private refreshPending = false;
  private unsubscribeEvent: (() => void) | null = null;
  private unsubscribeConnection: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeEvent = gateway.subscribe<RuntimeCapabilityLifecyclePayload>(
      Events.RUNTIME_CAPABILITY_LIFECYCLE,
      ({ event }) => {
        if (event.slotId === this.slotId) void this.refresh();
      },
    );
    this.unsubscribeConnection = gateway.onConnectionChange((connection) => {
      if (connection === 'connected') void this.refresh();
    });
    if (gateway.connectionState === 'connected') void this.refresh();
  }

  disconnectedCallback(): void {
    this.unsubscribeEvent?.();
    this.unsubscribeConnection?.();
    this.unsubscribeEvent = null;
    this.unsubscribeConnection = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('slotId') && this.slotId && gateway.connectionState === 'connected') {
      void this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    if (!this.slotId) return;
    if (this.loading) {
      this.refreshPending = true;
      return;
    }
    const requestedSlotId = this.slotId;
    this.loading = true;
    try {
      const status = await gateway.request<RuntimeCapabilityStatusResult>(
        Methods.RUNTIME_CAPABILITY_STATUS,
        { slotId: requestedSlotId },
      );
      if (requestedSlotId === this.slotId) {
        this.status = status;
        this.error = '';
      } else {
        this.refreshPending = true;
      }
    } catch (error) {
      if (requestedSlotId === this.slotId) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.loading = false;
      if (this.refreshPending) {
        this.refreshPending = false;
        void this.refresh();
      }
    }
  }

  /**
   * Stop a provider this run still holds.
   *
   * Only offered for a lease the Gateway will act on: `runtime.capability.release`
   * skips leases that are already released, so offering this for a warm provider
   * would report success while the process kept running.
   *
   * `keepWarm: false` is deliberate — an operator pressing Stop means "this
   * process should not be running", not "release ownership and leave it up".
   * `force` is never sent from here: it bypasses the provenance guard, which is
   * a decision the operator has to make explicitly, not a default.
   */
  private async release(
    entry: RuntimeCapabilityCatalogEntry,
    lease: RuntimeCapabilityLease,
  ): Promise<void> {
    // Captured before the first RPC: `this.slotId` is a mutable property, and an
    // operator switching slots mid-action would otherwise retarget it.
    const slotId = this.slotId;
    const ownerRunId = lease.owner.runId;
    await this.runRecovery(entry.id, 'release', slotId, async () => {
      const result = await gateway.request<RuntimeCapabilityReleaseResult>(
        Methods.RUNTIME_CAPABILITY_RELEASE,
        {
          slotId,
          ownerRunId,
          capabilityId: entry.id,
          leaseId: lease.id,
          keepWarm: false,
        },
        30_000,
      );
      if (!result.ok) {
        throw new Error(result.failures.map((failure) => failure.reason).join('; '));
      }
      // A release the Gateway silently skipped is not a stop. Say so rather than
      // letting the row re-render unchanged and read as success.
      if (!result.released.some((released) => released.id === lease.id)) {
        throw new Error(
          `The Gateway did not release lease ${lease.id}; the provider may still be running.`,
        );
      }
    });
  }

  /**
   * Stop a warm provider — a released lease whose process is still up.
   *
   * This is a different RPC from `release` on purpose: release filters released
   * leases and returns success without touching the process. `deferred` is a
   * refusal to render as-is, not an error: something still running depends on
   * this provider.
   */
  /** Namespaced so an answer can only ever render against the slot it came from. */
  private stopWarmKey(slotId: string, capabilityId: string): string {
    return `${slotId}::${capabilityId}`;
  }

  private async stopWarm(entry: RuntimeCapabilityCatalogEntry): Promise<void> {
    const slotId = this.slotId;
    await this.runRecovery(entry.id, 'release', slotId, async () => {
      const result = await gateway.request<RuntimeCapabilityStopWarmResult>(
        Methods.RUNTIME_CAPABILITY_STOP_WARM,
        { slotId, capabilityId: entry.id },
        60_000,
      );
      const view = stopWarmOutcomeView(result);
      this.stopWarmViews = {
        ...this.stopWarmViews,
        [this.stopWarmKey(slotId, entry.id)]: view,
      };
      // A refusal or a failed cleanup is the Gateway's answer, shown on the row.
      // Only a genuine transport/protocol fault belongs in the action error.
      if (view.tone === 'error' && result.outcome === 'failed') {
        throw new Error(view.note ?? 'Stopping the warm provider failed.');
      }
    });
  }

  /**
   * The proof requirement this capability was acquired under, from the owner's
   * stored plan. Restart and operator acquire reuse it rather than inventing
   * one, so a visual capability is not silently reacquired as state-only.
   */
  private proofRequirementFor(
    capabilityId: string,
    ownerRunId: string,
  ): RuntimeCapabilityProofRequirement | null {
    const plan = this.status?.proofPlans?.[ownerRunId];
    return plan?.requirements.find((entry) => entry.capabilityId === capabilityId) ?? null;
  }

  /**
   * Acquire the capability for the run bound to this slot, through the same RPC
   * a worker uses. `revalidateHealth` makes a dead warm provider fail here
   * instead of being reused as if it were healthy.
   */
  private async acquire(entry: RuntimeCapabilityCatalogEntry, ownerRunId: string): Promise<void> {
    const slotId = this.slotId;
    const requirement = this.proofRequirementFor(entry.id, ownerRunId);
    await this.runRecovery(entry.id, 'acquire', slotId, async () => {
      if (!requirement) {
        throw new Error(
          `No stored proof plan for ${entry.id} on run ${ownerRunId}; the Gateway has no recorded reason or mode to acquire it under.`,
        );
      }
      const result = await gateway.request<RuntimeCapabilityAcquireResult>(
        Methods.RUNTIME_CAPABILITY_ACQUIRE,
        {
          slotId,
          capabilityId: entry.id,
          ownerRunId,
          revalidateHealth: true,
          proofRequirement: requirement,
        },
        120_000,
      );
      if (!result.ok) {
        throw new Error(`Acquire refused: ${result.conflict.reason}`);
      }
    });
  }

  /**
   * Stop the provider and acquire it again for the same owner, reusing the
   * parameters and proof requirement it was originally acquired under. Slot and
   * owner are captured up front so a slot switch between the two calls cannot
   * reacquire one slot's capability against another.
   */
  private async restart(
    entry: RuntimeCapabilityCatalogEntry,
    lease: RuntimeCapabilityLease,
  ): Promise<void> {
    const slotId = this.slotId;
    const ownerRunId = lease.owner.runId;
    const parameters = lease.parameters;
    const requirement = this.proofRequirementFor(entry.id, ownerRunId);
    await this.runRecovery(entry.id, 'restart', slotId, async () => {
      if (!requirement) {
        throw new Error(
          `No stored proof plan for ${entry.id} on run ${ownerRunId}; restarting would have to invent the reason and mode it runs under.`,
        );
      }
      const released = await gateway.request<RuntimeCapabilityReleaseResult>(
        Methods.RUNTIME_CAPABILITY_RELEASE,
        {
          slotId,
          ownerRunId,
          capabilityId: entry.id,
          leaseId: lease.id,
          keepWarm: false,
        },
        30_000,
      );
      if (!released.ok) {
        throw new Error(released.failures.map((failure) => failure.reason).join('; '));
      }
      // `ok` alone is not proof this lease went away: the Gateway skips leases
      // it will not act on and still reports success. Reacquiring on top of a
      // provider that never stopped is exactly the duplicate this must avoid.
      if (!released.released.some((entry) => entry.id === lease.id)) {
        const retained = released.retained.find((entry) => entry.id === lease.id);
        throw new Error(
          `The Gateway did not release lease ${lease.id}, so the provider was not restarted: ${
            retained?.cleanupFailure ?? 'it was not among the released leases'
          }`,
        );
      }
      const acquired = await gateway.request<RuntimeCapabilityAcquireResult>(
        Methods.RUNTIME_CAPABILITY_ACQUIRE,
        {
          slotId,
          capabilityId: entry.id,
          ownerRunId,
          revalidateHealth: true,
          proofRequirement: requirement,
          ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
        },
        120_000,
      );
      if (!acquired.ok) {
        throw new Error(
          `Restart stopped the provider but re-acquire was refused: ${acquired.conflict.reason}`,
        );
      }
    });
  }

  /**
   * Run one recovery action and keep its outcome visible.
   *
   * The action error is held separately from the fetch error: `refresh()` clears
   * its own error on success, which used to erase the very failure the operator
   * needed to read.
   */
  private async runRecovery(
    capabilityId: string,
    action: RuntimeCapabilityRecoveryAction,
    slotId: string,
    perform: () => Promise<void>,
  ): Promise<void> {
    this.busyAction = { capabilityId, action };
    this.actionError = '';
    try {
      await perform();
    } catch (error) {
      this.actionError = `${action} ${capabilityId}: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.busyAction = null;
      // Only refresh the slot the action targeted; the operator may have moved.
      if (slotId === this.slotId) await this.refresh();
    }
  }

  private leasesFor(entry: RuntimeCapabilityCatalogEntry): RuntimeCapabilityLease[] {
    return (this.status?.leases ?? []).filter((lease) => lease.capabilityId === entry.id);
  }

  private activeLease(entry: RuntimeCapabilityCatalogEntry): RuntimeCapabilityLease | undefined {
    const { providerHolder, queuedReservations } = projectRuntimeCapabilityLeases(
      this.leasesFor(entry),
    );
    return providerHolder ?? queuedReservations.at(-1);
  }

  private latestLease(entry: RuntimeCapabilityCatalogEntry): RuntimeCapabilityLease | undefined {
    return this.leasesFor(entry).at(-1);
  }

  private planned(entry: RuntimeCapabilityCatalogEntry): boolean {
    return Object.values(this.status?.proofPlans ?? {}).some((plan) =>
      plan.requirements.some((requirement) => requirement.capabilityId === entry.id),
    );
  }

  private orderedCatalog(): RuntimeCapabilityCatalogEntry[] {
    return [...(this.status?.catalog ?? [])].sort((left, right) => {
      const priority = (entry: RuntimeCapabilityCatalogEntry) =>
        this.actionableLease(entry) ? 0 : this.planned(entry) ? 1 : 2;
      return priority(left) - priority(right);
    });
  }

  private actionableLease(
    entry: RuntimeCapabilityCatalogEntry,
  ): RuntimeCapabilityLease | undefined {
    const active = this.activeLease(entry);
    if (active) return active;
    const latest = this.latestLease(entry);
    return latest?.state === 'error' && latest.cleanupFailure ? latest : undefined;
  }

  protected render() {
    const catalog = this.orderedCatalog();
    return html`
      <section data-testid="runtime-capabilities-panel" aria-label="Runtime capabilities">
        <header>
          <div>
            <h3>Runtime capabilities</h3>
            <p>Proof resources are acquired after a run declares its plan.</p>
          </div>
          <button class="refresh" @click=${() => this.refresh()} ?disabled=${this.loading}>
            ${this.loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </header>
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
        ${this.actionError
          ? html`<div class="error" role="alert" data-testid="runtime-capability-action-error">
              ${this.actionError}
            </div>`
          : nothing}
        ${catalog.length === 0 && !this.loading
          ? html`<div class="empty">No runtime capabilities configured for this project.</div>`
          : html` <div class="list">${catalog.map((entry) => this.renderCapability(entry))}</div> `}
      </section>
    `;
  }

  private renderCapability(entry: RuntimeCapabilityCatalogEntry) {
    const { providerHolder, queuedReservations } = projectRuntimeCapabilityLeases(
      this.leasesFor(entry),
    );
    const active = providerHolder ?? queuedReservations.at(-1);
    const latest = this.latestLease(entry);
    const actionable = this.actionableLease(entry);
    const planned = this.planned(entry);
    const displayState = active
      ? active.state === 'acquired'
        ? 'Acquired'
        : titleCase(active.state)
      : latest?.state === 'released'
        ? 'Released'
        : latest?.state === 'error'
          ? 'Error'
          : planned
            ? 'Planned'
            : entry.availability.state === 'unavailable'
              ? 'Unavailable'
              : 'Available';
    const owner = actionable?.owner.runId;
    const displayedLease = providerHolder ?? (latest?.state === 'error' ? latest : undefined);
    const health =
      displayedLease?.health.state === 'healthy'
        ? 'Healthy'
        : titleCase(displayedLease?.health.state);
    const queuedOwners = queuedReservations.map((lease) => lease.owner.runId).join(', ');
    // Lease state and provider state are separate facts (ADR-054): a released
    // lease inside its keep-warm window still has a live process behind it.
    const stateLease = providerHolder ?? latest;
    const view: RuntimeCapabilityRetentionView = runtimeCapabilityRetentionView({
      entry,
      lease: stateLease,
      planned,
      nowMs: Date.now(),
    });
    const ownerRunId = providerHolder?.owner.runId || this.runId;
    const recoveryActions = runtimeCapabilityRecoveryActions({
      view,
      lease: stateLease,
      hasOwnerRunId: Boolean(ownerRunId),
      available: entry.availability.state === 'available',
    });
    const busy = this.busyAction?.capabilityId === entry.id ? this.busyAction.action : null;
    // Warm rows go to stopWarm; held rows go to release. Different RPCs.
    const usesWarmStop = runtimeCapabilityStopUsesWarmPath(view, stateLease);
    const stopWarmView = this.stopWarmViews[this.stopWarmKey(this.slotId, entry.id)];
    return html`
      <article
        data-capability-id=${entry.id}
        data-capability-state=${displayState.toLowerCase()}
        data-capability-owner=${owner ?? 'none'}
        data-provider-holder-count=${providerHolder ? '1' : '0'}
        data-queued-lease-count=${String(queuedReservations.length)}
        data-lease-state=${view.leaseLabel.toLowerCase()}
        data-observed-state=${view.observedState}
        data-warm-until=${view.warmUntil ?? ''}
      >
        <div class="summary">
          <div>
            <strong>${entry.label}</strong>
            <code>${entry.id}</code>
          </div>
          <div class="badges">
            ${planned ? html`<span class="badge planned">Planned</span>` : nothing}
            <span class="badge state" data-testid=${`runtime-capability-lease-${entry.id}`}
              >Lease ${displayState}</span
            >
            <span class="badge observed" data-testid=${`runtime-capability-observed-${entry.id}`}
              >Provider ${view.observedLabel}</span
            >
            ${queuedReservations.length > 0
              ? html`<span class="badge queued">${queuedReservations.length} queued</span>`
              : nothing}
            <span class="badge cost">${titleCase(entry.cost.class)} cost</span>
          </div>
        </div>
        <div class="details">
          <span
            ><b>${providerHolder ? 'Provider owner' : 'Owner'}</b> ${owner ??
            'No active owner'}</span
          >
          <span><b>Health</b> ${health || 'Not acquired'}</span>
          ${view.warmUntil
            ? html`<span data-testid=${`runtime-capability-warm-until-${entry.id}`}
                ><b>Warm until</b> ${view.warmUntil}</span
              >`
            : nothing}
          <span class="queue" data-testid=${`runtime-capability-reason-${entry.id}`}
            ><b>Why</b> ${view.retentionReason}</span
          >
          <span><b>Sharing</b> ${titleCase(entry.sharePolicy)}</span>
          <span><b>Provider</b> v${entry.version} · ${entry.provenance.digest.slice(0, 8)}</span>
          ${queuedReservations.length > 0
            ? html`<span class="queue"><b>Queued reservations</b> ${queuedOwners}</span>`
            : nothing}
        </div>
        <div class="effects">
          <b>Release effects</b>
          <ul>
            ${entry.releaseEffects.map((effect) => html`<li>${effect}</li>`)}
          </ul>
        </div>
        ${latest?.cleanupFailure
          ? html`<div class="error" role="alert">Cleanup failed: ${latest.cleanupFailure}</div>`
          : nothing}
        ${!active && entry.availability.state === 'unavailable'
          ? html`<div class="error">Unavailable: ${entry.availability.reason}</div>`
          : nothing}
        ${view.warmWindowOpen
          ? html`<div class="warm-note" data-testid=${`runtime-capability-warm-note-${entry.id}`}>
              Warm: the lease is released but the process stays up for reuse until
              ${view.warmUntil ?? 'its deadline'}.
            </div>`
          : nothing}
        ${stopWarmView?.note
          ? html`<div
              class=${stopWarmView.tone === 'error' ? 'error' : 'warm-note'}
              role=${stopWarmView.tone === 'error' ? 'alert' : 'status'}
              data-testid=${`runtime-capability-stopwarm-${entry.id}`}
              data-outcome-tone=${stopWarmView.tone}
              data-observed-state=${stopWarmView.observedState}
            >
              ${stopWarmView.note}
            </div>`
          : nothing}
        <div class="recovery">
          ${recoveryActions.includes('acquire')
            ? html`
                <button
                  data-testid=${`runtime-capability-acquire-${entry.id}`}
                  ?disabled=${busy !== null}
                  @click=${() => this.acquire(entry, ownerRunId)}
                >
                  ${busy === 'acquire' ? 'Acquiring…' : `Acquire ${entry.label}`}
                </button>
              `
            : nothing}
          ${recoveryActions.includes('restart') && stateLease
            ? html`
                <button
                  data-testid=${`runtime-capability-restart-${entry.id}`}
                  ?disabled=${busy !== null}
                  @click=${() => this.restart(entry, stateLease)}
                >
                  ${busy === 'restart' ? 'Restarting…' : `Restart ${entry.label}`}
                </button>
              `
            : nothing}
          ${recoveryActions.includes('release') && (usesWarmStop || actionable || stateLease)
            ? html`
                <button
                  class="release"
                  data-testid=${`runtime-capability-release-${entry.id}`}
                  ?disabled=${busy !== null}
                  @click=${() =>
                    usesWarmStop
                      ? this.stopWarm(entry)
                      : this.release(entry, (actionable ?? stateLease)!)}
                >
                  ${busy === 'release'
                    ? 'Stopping…'
                    : usesWarmStop
                      ? `Stop warm ${entry.label}`
                      : (actionable ?? stateLease)?.state === 'error'
                        ? `Retry stop ${entry.label}`
                        : `Stop ${entry.label}`}
                </button>
              `
            : nothing}
        </div>
      </article>
    `;
  }

  static styles = css`
    :host {
      display: block;
      color: var(--color-text-primary, #e7e9ee);
    }
    section {
      margin: 8px 12px 12px;
      border: 1px solid var(--color-border, #303640);
      border-radius: 8px;
      background: var(--color-bg-secondary, #171b22);
      overflow: hidden;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 12px;
      border-bottom: 1px solid var(--color-border, #303640);
    }
    h3 {
      margin: 0;
      font-size: 13px;
    }
    p {
      margin: 3px 0 0;
      color: var(--color-text-muted, #8f98a6);
      font-size: 11px;
    }
    button {
      border: 1px solid var(--color-border, #394150);
      border-radius: 5px;
      background: var(--color-bg-card, #202630);
      color: inherit;
      cursor: pointer;
      font-size: 11px;
    }
    button:disabled {
      cursor: wait;
      opacity: 0.6;
    }
    .refresh {
      align-self: center;
      padding: 5px 8px;
    }
    .list {
      display: grid;
      gap: 8px;
      padding: 10px;
    }
    article {
      padding: 10px;
      border: 1px solid var(--color-border, #303640);
      border-radius: 6px;
      background: var(--color-bg-card, #1d222b);
    }
    .summary {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    strong,
    code {
      display: block;
    }
    strong {
      font-size: 12px;
    }
    code {
      margin-top: 2px;
      color: var(--color-text-muted, #8f98a6);
      font-size: 10px;
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 4px;
    }
    .badge {
      align-self: flex-start;
      padding: 2px 6px;
      border-radius: 999px;
      background: #303845;
      color: #d9dee7;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .planned {
      background: #163b66;
      color: #83c5ff;
    }
    .cost {
      background: #4b2d16;
      color: #ffc17b;
    }
    .queued {
      background: #4c3b12;
      color: #ffe08a;
    }
    .details {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 4px 12px;
      margin-top: 9px;
      color: var(--color-text-secondary, #b5bdc9);
      font-size: 10px;
    }
    .details b,
    .effects b {
      color: var(--color-text-primary, #e7e9ee);
    }
    .queue {
      grid-column: 1 / -1;
    }
    .effects {
      margin-top: 8px;
      color: var(--color-text-muted, #8f98a6);
      font-size: 10px;
    }
    ul {
      margin: 3px 0 0;
      padding-left: 16px;
    }
    .warm-note {
      margin-top: 8px;
      padding: 6px 8px;
      border-radius: 4px;
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.statusWarn)};
      font-size: 10px;
      line-height: 1.45;
    }
    .recovery {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .recovery button {
      padding: 5px 8px;
    }
    .observed {
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.statusOk)};
    }
    .release {
      border-color: #74443e;
      color: #ffaaa0;
    }
    .error,
    .empty {
      margin: 10px;
      padding: 8px;
      border-radius: 5px;
      color: var(--color-text-muted, #8f98a6);
      font-size: 11px;
    }
    .error {
      background: #4d2020;
      color: #ffb0aa;
    }
  `;
}

function titleCase(value?: string): string {
  if (!value) return '';
  return `${value.charAt(0).toUpperCase()}${value.slice(1).replaceAll('-', ' ')}`;
}

declare global {
  interface HTMLElementTagNameMap {
    'runtime-capabilities-panel': RuntimeCapabilitiesPanel;
  }
}
