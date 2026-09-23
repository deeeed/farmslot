import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  FsReadResult,
  Run,
  RuntimeCapabilityAcquireResult,
  RuntimeCapabilityStatusResult,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import {
  type BlockedWorkerProofPlan,
  blockedWorkerProofPlanPath,
  blockedWorkerSignalPath,
  canResumeBlockedWorkerMonitor,
  parseBlockedWorkerProofPlan,
} from './blocked-run-recovery-model.js';

@customElement('blocked-run-recovery')
export class BlockedRunRecovery extends LitElement {
  @property({ attribute: false }) run!: Run;
  @property({ attribute: false }) replayMonitor!: () => void | Promise<void>;
  @property({ type: Boolean }) disabled = false;

  @state() private plan: BlockedWorkerProofPlan | null = null;
  @state() private planError = '';
  @state() private signal: unknown = null;
  @state() private status: RuntimeCapabilityStatusResult | null = null;
  @state() private error = '';
  @state() private busy = false;

  static styles = css`
    :host {
      display: block;
      margin: 12px 0;
    }
    section {
      border: 1px solid #8077a4;
      border-radius: 6px;
      padding: 12px;
    }
    h3 {
      font-size: 13px;
      margin: 0 0 8px;
    }
    p {
      font-size: 12px;
      line-height: 1.5;
      margin: 6px 0;
    }
    .actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 10px;
    }
    button {
      cursor: pointer;
      font: inherit;
    }
    button:disabled {
      cursor: default;
      opacity: 0.5;
    }
    a {
      color: inherit;
    }
    .error {
      color: #e88;
    }
  `;

  protected updated(changed: Map<string, unknown>): void {
    const previous = changed.get('run') as Run | undefined;
    if (
      changed.has('run') &&
      (this.run?.id !== previous?.id || this.run?.status !== previous?.status)
    ) {
      void this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    const run = this.run;
    const path = blockedWorkerProofPlanPath(run);
    this.plan = null;
    this.planError = '';
    this.signal = null;
    this.status = null;
    this.error = '';
    const signalPath = blockedWorkerSignalPath(run);
    if (!path || !signalPath || !run.slotId) return;
    try {
      const result = await gateway.request<FsReadResult>(Methods.FS_READ, {
        slotId: run.slotId,
        path,
      });
      if (this.run.id !== run.id) return;
      this.plan = parseBlockedWorkerProofPlan(result.content, run);
    } catch (error) {
      if (this.run.id !== run.id) return;
      this.planError = error instanceof Error ? error.message : String(error);
    }
    try {
      const status = await gateway.request<RuntimeCapabilityStatusResult>(
        Methods.RUNTIME_CAPABILITY_STATUS,
        { slotId: run.slotId },
      );
      if (this.run.id !== run.id) return;
      this.status = status;
    } catch (error) {
      if (this.run.id !== run.id) return;
      this.error = error instanceof Error ? error.message : String(error);
    }
    try {
      const signal = await gateway.request<FsReadResult>(Methods.FS_READ, {
        slotId: run.slotId,
        path: signalPath,
      });
      if (this.run.id === run.id) this.signal = JSON.parse(signal.content);
    } catch (error) {
      if (this.run.id === run.id)
        this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private requirementsReady(): boolean {
    if (!this.plan) return false;
    return this.plan.requirements.every((requirement) =>
      this.status?.leases.some(
        (lease) =>
          lease.capabilityId === requirement.capabilityId &&
          lease.owner.runId === this.run.id &&
          lease.state === 'acquired' &&
          lease.health.state === 'healthy',
      ),
    );
  }

  private async acquireProof(): Promise<void> {
    if (!this.plan || !this.run.slotId || this.busy) return;
    const run = this.run;
    this.busy = true;
    this.error = '';
    try {
      for (const requirement of this.plan.requirements) {
        const result = await gateway.request<RuntimeCapabilityAcquireResult>(
          Methods.RUNTIME_CAPABILITY_ACQUIRE,
          {
            slotId: run.slotId,
            ownerRunId: run.id,
            ownerFamilyId: run.familyId,
            capabilityId: requirement.capabilityId,
            proofRequirement: requirement,
            parameters: requirement.parameters,
            revalidateHealth: true,
          },
          120_000,
        );
        if (!result.ok) throw new Error(result.conflict.reason);
      }
      const status = await gateway.request<RuntimeCapabilityStatusResult>(
        Methods.RUNTIME_CAPABILITY_STATUS,
        { slotId: run.slotId },
      );
      if (this.run.id === run.id) this.status = status;
      if (!this.requirementsReady()) {
        throw new Error('Proof providers are not healthy. Check the slot resource panel.');
      }
    } catch (error) {
      if (this.run.id === run.id)
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }

  protected render() {
    const run = this.run;
    if (!run || run.status !== 'blocked' || run.metrics.disposition !== 'blocked') return nothing;
    const ready = this.requirementsReady();
    const unresolved =
      this.plan?.requirements.filter((requirement) =>
        this.status?.leases.some(
          (lease) =>
            lease.capabilityId === requirement.capabilityId &&
            lease.owner.runId === run.id &&
            lease.state === 'error' &&
            lease.cleanupFailure,
        ),
      ) ?? [];
    const freshSignal = canResumeBlockedWorkerMonitor(run, this.signal);
    return html`
      <section data-testid="blocked-run-recovery" aria-label="Recover blocked worker">
        <h3>Recover this worker</h3>
        <p>
          Keep the existing branch and runner session. Fix the blocker, then have the worker run
          <code>./mark start</code> before resuming monitoring.
        </p>
        ${this.plan
          ? html`<p>
              Proof resources:
              ${this.plan.requirements.map((requirement) => requirement.capabilityId).join(', ')}.
              ${ready
                ? 'Leases are healthy.'
                : unresolved.length
                  ? 'Cleanup is unresolved. Retry stop in slot resources after the worker finishes using them, then acquire here.'
                  : 'Acquire them from this authenticated view.'}
            </p>`
          : this.planError
            ? html`<p>Proof plan unavailable: ${this.planError}</p>`
            : nothing}
        <div class="actions">
          ${this.plan && !ready && !unresolved.length
            ? html`<button
                data-testid="blocked-run-acquire-proof"
                ?disabled=${this.busy || this.disabled}
                @click=${this.acquireProof}
              >
                ${this.busy ? 'Acquiring…' : 'Acquire proof resources'}
              </button>`
            : nothing}
          ${run.slotId
            ? html`<a
                href=${`#slot/${encodeURIComponent(run.slotId)}?activity=info&runId=${encodeURIComponent(run.id)}`}
                >Open worker and resources</a
              >`
            : nothing}
          <button data-testid="blocked-run-refresh" ?disabled=${this.busy} @click=${this.refresh}>
            Check readiness
          </button>
          <button
            data-testid="blocked-run-retry-monitor"
            ?disabled=${this.disabled || this.busy || !freshSignal || !ready}
            @click=${this.replayMonitor}
          >
            Resume monitoring
          </button>
        </div>
        ${!freshSignal
          ? html`<p>
              Waiting for a new worker signal. A retry before <code>./mark start</code> would
              re-read the old blocked result.
            </p>`
          : nothing}
        ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'blocked-run-recovery': BlockedRunRecovery;
  }
}
