import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import {
  Events,
  Methods,
  type RuntimeCapabilityCatalogEntry,
  type RuntimeCapabilityLease,
  type RuntimeCapabilityLifecyclePayload,
  type RuntimeCapabilityReleaseResult,
  type RuntimeCapabilityStatusResult,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

const ACTIVE_LEASE_STATES = new Set<RuntimeCapabilityLease['state']>([
  'queued',
  'acquiring',
  'acquired',
  'releasing',
]);

@customElement('runtime-capabilities-panel')
export class RuntimeCapabilitiesPanel extends LitElement {
  @property({ type: String }) slotId = '';

  @state() private status: RuntimeCapabilityStatusResult | null = null;
  @state() private error = '';
  @state() private loading = false;
  @state() private releasingLeaseId = '';

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

  private async release(entry: RuntimeCapabilityCatalogEntry, lease: RuntimeCapabilityLease) {
    this.releasingLeaseId = lease.id;
    try {
      const result = await gateway.request<RuntimeCapabilityReleaseResult>(
        Methods.RUNTIME_CAPABILITY_RELEASE,
        {
          slotId: this.slotId,
          ownerRunId: lease.owner.runId,
          capabilityId: entry.id,
          leaseId: lease.id,
        },
        30_000,
      );
      if (!result.ok) {
        throw new Error(result.failures.map((failure) => failure.reason).join('; '));
      }
      await this.refresh();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.releasingLeaseId = '';
    }
  }

  private leasesFor(entry: RuntimeCapabilityCatalogEntry): RuntimeCapabilityLease[] {
    return (this.status?.leases ?? []).filter((lease) => lease.capabilityId === entry.id);
  }

  private activeLease(entry: RuntimeCapabilityCatalogEntry): RuntimeCapabilityLease | undefined {
    const leases = this.leasesFor(entry);
    for (let index = leases.length - 1; index >= 0; index -= 1) {
      const lease = leases[index];
      if (lease && ACTIVE_LEASE_STATES.has(lease.state)) return lease;
    }
    return undefined;
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
    const active = this.activeLease(entry);
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
    const displayedLease = active ?? (latest?.state === 'error' ? latest : undefined);
    const health =
      displayedLease?.health.state === 'healthy'
        ? 'Healthy'
        : titleCase(displayedLease?.health.state);
    return html`
      <article
        data-capability-id=${entry.id}
        data-capability-state=${displayState.toLowerCase()}
        data-capability-owner=${owner ?? 'none'}
      >
        <div class="summary">
          <div>
            <strong>${entry.label}</strong>
            <code>${entry.id}</code>
          </div>
          <div class="badges">
            ${planned ? html`<span class="badge planned">Planned</span>` : nothing}
            <span class="badge state">${displayState}</span>
            <span class="badge cost">${titleCase(entry.cost.class)} cost</span>
          </div>
        </div>
        <div class="details">
          <span><b>Owner</b> ${owner ?? 'No active owner'}</span>
          <span><b>Health</b> ${health || 'Not acquired'}</span>
          <span><b>Sharing</b> ${titleCase(entry.sharePolicy)}</span>
          <span><b>Provider</b> v${entry.version} · ${entry.provenance.digest.slice(0, 8)}</span>
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
        ${actionable
          ? html`
              <button
                class="release"
                data-testid=${`runtime-capability-release-${entry.id}`}
                ?disabled=${this.releasingLeaseId === actionable.id}
                @click=${() => this.release(entry, actionable)}
              >
                ${this.releasingLeaseId === actionable.id
                  ? 'Releasing…'
                  : actionable.state === 'error'
                    ? `Retry release ${entry.label}`
                    : `Release ${entry.label}`}
              </button>
            `
          : nothing}
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
    .effects {
      margin-top: 8px;
      color: var(--color-text-muted, #8f98a6);
      font-size: 10px;
    }
    ul {
      margin: 3px 0 0;
      padding-left: 16px;
    }
    .release {
      margin-top: 8px;
      padding: 5px 8px;
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
