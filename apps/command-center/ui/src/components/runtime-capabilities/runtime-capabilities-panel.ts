import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  Events,
  Methods,
  type RuntimeCapabilityAcquireResult,
  type RuntimeCapabilityCatalogEntry,
  type RuntimeCapabilityLease,
  type RuntimeCapabilityLifecyclePayload,
  type RuntimeCapabilityReleaseResult,
  type RuntimeCapabilityStatusResult,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import {
  projectRuntimeCapabilityLeases,
  type RuntimeCapabilityRecoveryAction,
  runtimeCapabilityRecoveryActions,
  type RuntimeCapabilityRetentionView,
  runtimeCapabilityRetentionView,
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
   * Stop the provider (ADR-054). `keepWarm: false` is deliberate: an operator
   * pressing this in Slot View means "this process should not be running", and
   * the historical default would have left it alive until its keep-warm
   * deadline while the panel said the lease was released.
   */
  private async release(
    entry: RuntimeCapabilityCatalogEntry,
    lease: RuntimeCapabilityLease,
  ): Promise<void> {
    await this.runRecovery(entry.id, 'release', async () => {
      const result = await gateway.request<RuntimeCapabilityReleaseResult>(
        Methods.RUNTIME_CAPABILITY_RELEASE,
        {
          slotId: this.slotId,
          ownerRunId: lease.owner.runId,
          capabilityId: entry.id,
          leaseId: lease.id,
          keepWarm: false,
          ...(lease.state === 'error' ? { force: true } : {}),
        },
        30_000,
      );
      if (!result.ok) {
        throw new Error(result.failures.map((failure) => failure.reason).join('; '));
      }
    });
  }

  /**
   * Acquire the capability for the run bound to this slot, through the same RPC
   * a worker uses. `revalidateHealth` makes a dead warm provider fail here
   * instead of being reused as if it were healthy.
   */
  private async acquire(entry: RuntimeCapabilityCatalogEntry, ownerRunId: string): Promise<void> {
    await this.runRecovery(entry.id, 'acquire', async () => {
      const result = await gateway.request<RuntimeCapabilityAcquireResult>(
        Methods.RUNTIME_CAPABILITY_ACQUIRE,
        {
          slotId: this.slotId,
          capabilityId: entry.id,
          ownerRunId,
          revalidateHealth: true,
          proofRequirement: {
            capabilityId: entry.id,
            reason: 'operator recovery from Slot View',
            mode: 'state',
          },
        },
        120_000,
      );
      if (!result.ok) {
        throw new Error(`Acquire refused: ${result.conflict.reason}`);
      }
    });
  }

  /** Stop the provider, then acquire it again for the same owner. */
  private async restart(
    entry: RuntimeCapabilityCatalogEntry,
    lease: RuntimeCapabilityLease,
  ): Promise<void> {
    const ownerRunId = lease.owner.runId;
    await this.runRecovery(entry.id, 'restart', async () => {
      const released = await gateway.request<RuntimeCapabilityReleaseResult>(
        Methods.RUNTIME_CAPABILITY_RELEASE,
        {
          slotId: this.slotId,
          ownerRunId,
          capabilityId: entry.id,
          leaseId: lease.id,
          keepWarm: false,
          force: true,
        },
        30_000,
      );
      if (!released.ok) {
        throw new Error(released.failures.map((failure) => failure.reason).join('; '));
      }
      const acquired = await gateway.request<RuntimeCapabilityAcquireResult>(
        Methods.RUNTIME_CAPABILITY_ACQUIRE,
        {
          slotId: this.slotId,
          capabilityId: entry.id,
          ownerRunId,
          revalidateHealth: true,
          proofRequirement: {
            capabilityId: entry.id,
            reason: 'operator restart from Slot View',
            mode: 'state',
          },
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

  private async runRecovery(
    capabilityId: string,
    action: RuntimeCapabilityRecoveryAction,
    perform: () => Promise<void>,
  ): Promise<void> {
    this.busyAction = { capabilityId, action };
    try {
      await perform();
      await this.refresh();
    } catch (error) {
      // The failure is surfaced, never swallowed: the panel would otherwise
      // re-render an unchanged row that reads as a successful no-op.
      this.error = error instanceof Error ? error.message : String(error);
      await this.refresh();
    } finally {
      this.busyAction = null;
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
          ${recoveryActions.includes('release') && (actionable ?? stateLease)
            ? html`
                <button
                  class="release"
                  data-testid=${`runtime-capability-release-${entry.id}`}
                  ?disabled=${busy !== null}
                  @click=${() => this.release(entry, (actionable ?? stateLease)!)}
                >
                  ${busy === 'release'
                    ? 'Stopping…'
                    : (actionable ?? stateLease)!.state === 'error'
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
      background: #1b3a2c;
      color: #8ce0b4;
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
