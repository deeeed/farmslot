import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  MachineParkRecord,
  MachinePauseMode,
  MachinePausePreviewResult,
  MachinePauseRestoreResult,
  MachinePauseSelector,
  MachinePauseStatusResult,
  ResourcePressureMachine,
} from '@farmslot/protocol';

import {
  eligibleRunIds,
  EMPTY_MACHINE_PAUSE_SELECTOR,
  machineParkRecordSummary,
  machinePauseMutationDisabled,
  machinePressurePercent,
  reviewedPauseTargets,
  reviewedRestoreTargets,
  selectedRejectedRunCount,
  selectorForAllEligible,
  selectorForRunToggle,
} from './machine-pause-dialog-model.js';
import { machinePauseDialogStyles } from './machine-pause-dialog-styles.js';
import {
  pressureBytes,
  pressureOwnershipLabel,
  pressureProcessCpu,
  pressureProcessName,
  pressureSampleAge,
  visiblePressureGroups,
} from './machine-pressure-model.js';

export type MachinePauseBusyAction = 'loading' | 'preview' | 'execute' | 'restore' | null;

@customElement('machine-pause-dialog')
export class MachinePauseDialog extends LitElement {
  @property({ type: Boolean }) open = false;
  @property() machine = '';
  @property() mode: MachinePauseMode = 'orchestration';
  @property({ attribute: false }) preview?: MachinePausePreviewResult;
  @property({ attribute: false }) status?: MachinePauseStatusResult;
  @property({ attribute: false }) restorePreview?: MachinePauseRestoreResult;
  @property({ attribute: false }) busy: MachinePauseBusyAction = null;
  @property() actionError = '';
  @property({ type: Boolean }) connectionStale = false;

  @state() private confirmed = false;

  static override styles = machinePauseDialogStyles;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this.onKeydown);
  }

  override disconnectedCallback() {
    document.removeEventListener('keydown', this.onKeydown);
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has('preview')) {
      const previous = changed.get('preview') as MachinePausePreviewResult | undefined;
      if (this.preview?.previewId !== previous?.previewId) {
        this.confirmed = false;
      }
    }
    if (changed.has('restorePreview')) {
      const previous = changed.get('restorePreview') as MachinePauseRestoreResult | undefined;
      if (this.restorePreview?.previewId !== previous?.previewId) {
        this.confirmed = false;
      }
    }
    if (changed.has('mode') || changed.has('machine')) this.confirmed = false;
  }

  private onKeydown = (event: KeyboardEvent) => {
    if (this.open && event.key === 'Escape' && !this.busy) this.close();
  };

  private close() {
    this.dispatchEvent(new CustomEvent('machine-pause-close', { bubbles: true, composed: true }));
  }

  private selectMode(mode: MachinePauseMode) {
    if (this.mode === mode || this.busy) return;
    this.dispatchEvent(
      new CustomEvent('machine-pause-mode-change', {
        detail: { mode },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private refresh() {
    this.dispatchEvent(new CustomEvent('machine-pause-refresh', { bubbles: true, composed: true }));
  }

  private changeSelection(scope: 'pause' | 'restore', selector: MachinePauseSelector) {
    this.confirmed = false;
    this.dispatchEvent(
      new CustomEvent('machine-pause-selection-change', {
        detail: { scope, selector },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private executePause() {
    if (!this.preview || !this.confirmed || this.connectionStale || this.busy) return;
    const reviewedTargets = reviewedPauseTargets(this.preview);
    if (reviewedTargets.length === 0) return;
    this.dispatchEvent(
      new CustomEvent('machine-pause-execute', {
        detail: {
          machine: this.machine,
          mode: this.mode,
          previewId: this.preview.previewId,
          reviewedTargets,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private executeRestore() {
    if (!this.restorePreview || !this.confirmed || this.connectionStale || this.busy) return;
    const reviewedTargets = reviewedRestoreTargets(this.restorePreview);
    if (reviewedTargets.length === 0) return;
    this.dispatchEvent(
      new CustomEvent('machine-pause-restore', {
        detail: {
          machine: this.machine,
          previewId: this.restorePreview.previewId,
          reviewedTargets,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    if (!this.open) return nothing;
    const pressure = this.currentPressure;
    const pauseTargets = reviewedPauseTargets(this.preview);
    const restoreTargets = reviewedRestoreTargets(this.restorePreview);
    const pauseSelectionBlocked = selectedRejectedRunCount(this.preview?.runs ?? []) > 0;
    const restoreSelectionBlocked = selectedRejectedRunCount(this.restorePreview?.runs ?? []) > 0;
    const pauseDisabled = machinePauseMutationDisabled({
      reviewedTargetCount: pauseTargets.length,
      selectedRejectedCount: pauseSelectionBlocked ? 1 : 0,
      confirmed: this.confirmed,
      busy: !!this.busy,
      connectionStale: this.connectionStale,
    });
    const restoreDisabled = machinePauseMutationDisabled({
      reviewedTargetCount: restoreTargets.length,
      selectedRejectedCount: restoreSelectionBlocked ? 1 : 0,
      confirmed: this.confirmed,
      busy: !!this.busy,
      connectionStale: this.connectionStale,
    });
    return html`
      <div class="mpd-backdrop" data-testid="machine-pause-dialog" @click=${this.onBackdropClick}>
        <section
          class="mpd-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="machine-pause-title"
          @click=${(event: Event) => event.stopPropagation()}
        >
          <header class="mpd-header">
            <div>
              <div id="machine-pause-title" class="mpd-title">${this.machine} run relief</div>
              <div class="mpd-subtitle">
                Backend eligibility, resource manifests, durable pause, and selective restore
              </div>
            </div>
            <div class="mpd-footer-actions">
              <button class="mpd-button" ?disabled=${!!this.busy} @click=${this.refresh}>
                Refresh
              </button>
              <button class="mpd-close" ?disabled=${!!this.busy} @click=${this.close}>Close</button>
            </div>
          </header>

          <div class="mpd-body">
            ${this.connectionStale
              ? html`<div class="mpd-banner stale" data-testid="machine-pause-stale">
                  Reconnecting to the gateway. The last durable snapshot remains visible; actions
                  stay disabled until status and previews are refetched.
                </div>`
              : nothing}
            ${this.actionError
              ? html`<div class="mpd-banner error" data-testid="machine-pause-action-error">
                  ${this.actionError}
                </div>`
              : nothing}
            ${this.busy === 'loading'
              ? html`<div class="mpd-banner">Loading machine pause state…</div>`
              : nothing}
            ${this.renderPressureSummary(pressure)} ${this.renderProcessDetails(pressure)}

            <div class="mpd-tabs" role="tablist" aria-label="Pause mode">
              <button
                class="mpd-tab ${this.mode === 'orchestration' ? 'active' : ''}"
                role="tab"
                aria-selected=${this.mode === 'orchestration'}
                ?disabled=${!!this.busy}
                @click=${() => this.selectMode('orchestration')}
              >
                <strong>Pause orchestration</strong>
                <span class="mpd-tab-copy">
                  Park pipeline progress while the worker and its resources keep running.
                </span>
              </button>
              <button
                class="mpd-tab ${this.mode === 'release' ? 'active' : ''}"
                role="tab"
                aria-selected=${this.mode === 'release'}
                ?disabled=${!!this.busy}
                @click=${() => this.selectMode('release')}
              >
                <strong>Pause & release</strong>
                <span class="mpd-tab-copy">
                  Stop only the reviewed worker session and observed-running manifest resources.
                </span>
              </button>
            </div>

            ${this.renderPausePreview()} ${this.renderRestorePreview()}
            ${this.renderDurableStatus()}
          </div>

          <footer class="mpd-footer">
            <label class="mpd-confirm">
              <input
                type="checkbox"
                .checked=${this.confirmed}
                ?disabled=${!!this.busy || this.connectionStale}
                @change=${(event: Event) => {
                  this.confirmed = (event.currentTarget as HTMLInputElement).checked;
                }}
              />
              I reviewed the selected runs, recovery policies, and affected resources.
            </label>
            <div class="mpd-footer-actions">
              ${(this.restorePreview?.runs.length ?? 0) > 0
                ? html`<button
                    class="mpd-button primary"
                    data-testid="machine-pause-restore-execute"
                    ?disabled=${restoreDisabled}
                    @click=${this.executeRestore}
                  >
                    ${this.busy === 'restore' ? 'Restoring…' : `Restore ${restoreTargets.length}`}
                  </button>`
                : nothing}
              <button
                class="mpd-button danger"
                data-testid="machine-pause-execute"
                ?disabled=${pauseDisabled}
                @click=${this.executePause}
              >
                ${this.busy === 'execute'
                  ? 'Executing…'
                  : `${this.mode === 'release' ? 'Pause & release' : 'Pause'} ${pauseTargets.length}`}
              </button>
            </div>
          </footer>
        </section>
      </div>
    `;
  }

  private get currentPressure(): ResourcePressureMachine | undefined {
    return this.status?.pressure ?? this.restorePreview?.pressure ?? this.preview?.pressure;
  }

  private renderPressureSummary(pressure: ResourcePressureMachine | undefined) {
    const latest = pressure?.history.at(-1);
    return html`<div class="mpd-summary" data-testid="machine-pause-pressure">
      ${[
        ['CPU', machinePressurePercent(latest?.pressure.cpu)],
        ['Memory', machinePressurePercent(latest?.pressure.memory)],
        ['Load / core', machinePressurePercent(latest?.pressure.load1)],
        ['Pressure', pressure?.severity ?? 'awaiting sample'],
      ].map(
        ([label, value]) =>
          html`<div class="mpd-card mpd-stat">
            <span class="mpd-stat-label">${label}</span>
            <span class="mpd-stat-value">${value}</span>
          </div>`,
      )}
    </div>`;
  }

  private renderProcessDetails(pressure: ResourcePressureMachine | undefined) {
    if (!pressure) return nothing;
    const process = pressure.processAttribution;
    const groups = visiblePressureGroups(process.groups, 12);
    return html`<section class="mpd-section" data-testid="machine-pause-processes">
      <div class="mpd-section-head">
        <span class="mpd-section-title">Attributed processes</span>
        <span class="mpd-muted">
          ${process.sampledProcesses
            ? `${process.sampledProcesses}/${process.totalProcesses} sampled · ${pressureSampleAge(process.sampledAt)}`
            : (process.unavailableReason ?? 'awaiting process inventory')}
        </span>
      </div>
      <div class="mpd-processes">
        ${groups.map(
          (group) =>
            html`<div class="mpd-process">
              <div>
                <div class="mpd-process-title">${pressureProcessName(group.topExecutable)}</div>
                <div class="mpd-process-meta">
                  ${pressureOwnershipLabel(group.classification)} · ${group.confidence} confidence ·
                  ${group.processCount} processes
                </div>
              </div>
              <span>${pressureProcessCpu(group.cpuPercent)}</span>
              <span>${pressureBytes(group.topRssBytes)}</span>
              <span class="mpd-process-meta">
                ${group.runId ?? group.slotId ?? group.tmuxTarget ?? group.evidence.join(', ')}
              </span>
            </div>`,
        )}
        ${groups.length === 0
          ? html`<div class="mpd-banner">
              ${process.unavailableReason ?? 'No attributed processes in this sample.'}
            </div>`
          : nothing}
      </div>
      ${process.truncated || process.omittedGroups > 0
        ? html`<div class="mpd-muted">
            Bounded inventory: ${process.omittedGroups} lower-pressure group(s) omitted.
          </div>`
        : nothing}
      <div class="mpd-muted" data-testid="machine-pause-unmapped-note">
        System / unmapped means no verified Farmslot run, slot, or resource owns that process tree;
        it is never cleanup-eligible.
      </div>
    </section>`;
  }

  private renderPausePreview() {
    const preview = this.preview;
    if (!preview) return html`<div class="mpd-banner">Loading pause preview…</div>`;
    const eligible = eligibleRunIds(preview.runs);
    const selectedRejected = selectedRejectedRunCount(preview.runs);
    return html`<section class="mpd-section" data-testid="machine-pause-preview">
      <div class="mpd-section-head">
        <span class="mpd-section-title">
          Pause preview · ${preview.eligibleCount} eligible · ${preview.rejectedCount} rejected
        </span>
        <div class="mpd-selection-actions">
          <button
            class="mpd-link-button"
            ?disabled=${eligible.size === 0 || !!this.busy}
            @click=${() => this.changeSelection('pause', selectorForAllEligible(preview.runs))}
          >
            Select all eligible
          </button>
          <button
            class="mpd-link-button"
            ?disabled=${!preview.runs.some((run) => run.selected) || !!this.busy}
            @click=${() => this.changeSelection('pause', EMPTY_MACHINE_PAUSE_SELECTOR)}
          >
            Clear
          </button>
        </div>
      </div>
      ${selectedRejected > 0
        ? html`<div class="mpd-banner warning">
            ${selectedRejected} selected run(s) are backend-rejected. Use Select all eligible or
            Clear before execution.
          </div>`
        : nothing}
      <div class="mpd-runs">
        ${preview.runs.map((run) => this.renderPreviewRun(run))}
        ${preview.runs.length === 0
          ? html`<div class="mpd-banner">No runs on this machine are pause candidates.</div>`
          : nothing}
      </div>
    </section>`;
  }

  private renderPreviewRun(run: MachinePausePreviewResult['runs'][number]) {
    const resources = run.resourceManifest.resources;
    const capabilityLeases = run.resourceManifest.capabilityLeases;
    return html`<label class="mpd-run ${run.eligibility.eligible ? '' : 'rejected'}">
      <input
        type="checkbox"
        .checked=${run.selected}
        ?disabled=${!run.eligibility.eligible || !!this.busy}
        @change=${(event: Event) => {
          this.changeSelection(
            'pause',
            selectorForRunToggle(
              this.preview?.runs ?? [],
              run.runId,
              (event.currentTarget as HTMLInputElement).checked,
            ),
          );
        }}
      />
      <div>
        <div class="mpd-run-title">${run.runId}</div>
        <div class="mpd-run-meta">
          ${run.slotId ?? 'no slot'} · generation ${run.generation} · ${run.status}
          ${run.currentStep ? ` · ${run.currentStep.name}` : ''}
        </div>
      </div>
      <div>
        <div class="mpd-policy">${this.recoveryPolicyLabel(run.recoveryPolicy)}</div>
        <div class=${run.eligibility.eligible ? 'mpd-run-meta' : 'mpd-reason'}>
          ${run.eligibility.reason}
        </div>
      </div>
      <div class="mpd-resources">
        ${[
          ...resources.map((resource) => `${resource.label} (${resource.resourceId})`),
          ...capabilityLeases.map((lease) => `capability ${lease.capabilityId}`),
        ].join(', ') ||
        (this.mode === 'orchestration'
          ? 'Worker and resources remain running.'
          : 'No running manifest resources or capability leases were observed.')}
      </div>
    </label>`;
  }

  private recoveryPolicyLabel(
    policy: MachinePausePreviewResult['runs'][number]['recoveryPolicy'],
  ): string {
    if (policy.kind === 'orchestration-only') return 'orchestration-only recovery';
    if (policy.supported) return `${policy.runnerId} session reload`;
    return policy.reason ?? `${policy.runnerId} session reload unsupported`;
  }

  private renderRestorePreview() {
    const preview = this.restorePreview;
    if (!preview || preview.runs.length === 0) return nothing;
    const eligible = eligibleRunIds(preview.runs);
    const selectedRejected = selectedRejectedRunCount(preview.runs);
    return html`<section class="mpd-section" data-testid="machine-pause-restore-preview">
      <div class="mpd-section-head">
        <span class="mpd-section-title">Selective restore</span>
        <div class="mpd-selection-actions">
          <button
            class="mpd-link-button"
            ?disabled=${eligible.size === 0 || !!this.busy}
            @click=${() => this.changeSelection('restore', selectorForAllEligible(preview.runs))}
          >
            Select all eligible
          </button>
          <button
            class="mpd-link-button"
            ?disabled=${!preview.runs.some((run) => run.selected) || !!this.busy}
            @click=${() => this.changeSelection('restore', EMPTY_MACHINE_PAUSE_SELECTOR)}
          >
            Clear
          </button>
        </div>
      </div>
      ${selectedRejected > 0
        ? html`<div class="mpd-banner warning">
            ${selectedRejected} selected restore(s) are backend-rejected. Narrow the selection
            before execution.
          </div>`
        : nothing}
      <div class="mpd-runs">
        ${preview.runs.map(
          (run) =>
            html`<label class="mpd-run ${run.eligibility.eligible ? '' : 'rejected'}">
              <input
                type="checkbox"
                .checked=${run.selected}
                ?disabled=${!run.eligibility.eligible || !!this.busy}
                @change=${(event: Event) => {
                  this.changeSelection(
                    'restore',
                    selectorForRunToggle(
                      this.restorePreview?.runs ?? [],
                      run.runId,
                      (event.currentTarget as HTMLInputElement).checked,
                    ),
                  );
                }}
              />
              <div>
                <div class="mpd-run-title">${run.runId}</div>
                <div class="mpd-run-meta">
                  ${run.record.slotId} · ${run.record.mode} · generation ${run.generation}
                </div>
              </div>
              <span class="mpd-phase ${run.record.phase}">${run.record.phase}</span>
              <div>
                <div class="mpd-resources">
                  ${run.record.resourceManifest.resources.length} manifest resource(s) ·
                  ${run.record.resourceManifest.capabilityLeases.length} capability lease(s)
                </div>
                <div class=${run.eligibility.eligible ? 'mpd-run-meta' : 'mpd-reason'}>
                  ${run.eligibility.reason}
                </div>
              </div>
            </label>`,
        )}
      </div>
    </section>`;
  }

  private renderDurableStatus() {
    const records = this.status?.records ?? [];
    if (records.length === 0) return nothing;
    return html`<section class="mpd-section" data-testid="machine-pause-status">
      <div class="mpd-section-title">Durable operation status</div>
      <div class="mpd-runs">${records.map((record) => this.renderRecord(record))}</div>
    </section>`;
  }

  private renderRecord(record: MachineParkRecord) {
    const residualResources = record.residuals.resources.filter(
      (resource) => resource.state !== 'stopped',
    );
    return html`<div class="mpd-run ${record.errors.length > 0 ? 'error' : ''}">
      <span></span>
      <div>
        <div class="mpd-run-title">${record.runId}</div>
        <div class="mpd-run-meta">
          ${record.slotId} · ${record.mode} · updated ${pressureSampleAge(record.updatedAt)}
        </div>
      </div>
      <div>
        <div class="mpd-phase ${record.phase}">${machineParkRecordSummary(record)}</div>
        ${record.errors.map(
          (error) =>
            html`<div class="mpd-action-error">
              ${error.phase} · ${error.action} · ${error.code}:
              ${error.message}${error.retryable ? ' (retryable)' : ''}
            </div>`,
        )}
      </div>
      <div>
        ${record.residuals.runner !== 'stopped' || residualResources.length > 0
          ? html`<div class="mpd-residuals">
              Residual runner: ${record.residuals.runner}; resources:
              ${residualResources.length > 0
                ? residualResources
                    .map((resource) => `${resource.resourceId} ${resource.state}`)
                    .join(', ')
                : 'none'}
            </div>`
          : html`<div class="mpd-resources">No residual worker or resources reported.</div>`}
      </div>
    </div>`;
  }

  private onBackdropClick = () => {
    if (!this.busy) this.close();
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'machine-pause-dialog': MachinePauseDialog;
  }
}
