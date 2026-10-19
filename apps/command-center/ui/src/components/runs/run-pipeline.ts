import { html, LitElement, nothing, type PropertyValues, svg } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import type {
  AcceptanceCriterionRef,
  AcceptanceEvidenceLink,
  AcceptanceStatusLedger,
  Run,
  RunCancelResult,
  RunStep,
  RunStepDisplayStatus,
  TaskProgressStructured,
} from '@farmslot/protocol';
import {
  deriveRunLifecycleView,
  failedRunCancelEffects,
  isTerminalRunStatus,
  Methods,
  runStepDisplayStatus,
} from '@farmslot/protocol';

import '../progress-tracker/progress-tracker.js';

import { gateway } from '../../gateway-client.js';
import {
  type AcceptanceEvidenceOpen,
  acceptancePanelInputs,
  acceptancePanelStyles,
  renderAcceptancePanel,
} from '../progress-tracker/acceptance-panel.js';
import { SubtaskOpenState } from '../progress-tracker/subtask-block.js';
import type { FileTransferUiEntry } from '../shared/file-transfer-progress-model.js';
import {
  primaryTransferForRun,
  retainFileTransferStore,
  subscribeFileTransferStore,
} from '../shared/file-transfer-progress-store.js';

import { isRunWorking } from './run-detail-model.js';
import {
  activeTaskProgressStepId,
  ciWatchOutputsForRun,
  computeLayout,
  currentPipelineNodeId,
  effectiveTaskProgressForRun,
  isInlineCiFixActiveFromOutputs,
  pipelineDetachedProgressVisible,
  type PipelineLayout,
} from './run-pipeline-model.js';
import {
  renderPipelineControls,
  renderReviewRecoveryStatus,
  renderRunPipelineSummary,
} from './run-pipeline-panels.js';
import {
  renderCompletePipelineNode,
  renderFinalizePipelineNode,
  renderHumanGatePipelineNode,
  renderMonitorPipelineNode,
  renderPackageRefreshPipelineNode,
  renderPublicationReviewPipelineNode,
  renderReviewPipelineNode,
  type RunPipelineSpecialNodeRenderContext,
} from './run-pipeline-special-node-renderers.js';
import { runPipelineStyles } from './run-pipeline-styles.js';
import {
  renderDefaultPipelineNode,
  renderPipelineArrow,
  renderPipelineDecisions,
  renderPipelineDefs,
  renderPipelineFocus,
  renderPipelineLanes,
  renderPublicationReviewLoops,
  renderReviewLoop,
} from './run-pipeline-svg-renderers.js';

@customElement('run-pipeline')
export class RunPipeline extends LitElement {
  private readonly subtaskOpen = new SubtaskOpenState();
  @property({ attribute: false }) run!: Run;
  @property({ attribute: false }) taskProgress?: TaskProgressStructured;
  /** The run's acceptance ledger (ADR-060); the panel is hidden without one. */
  @property({ attribute: false }) evidenceModel?: EvidenceReviewModel | null;
  @property({ attribute: false }) acceptanceStatus?: AcceptanceStatusLedger | null;
  /** Registered criteria, so one still awaiting a verdict gets a row of its own. */
  @property({ attribute: false }) acceptanceCriteria?: AcceptanceCriterionRef[] | null;
  /** Why the ledger could not be read, when it could not. */
  @property({ attribute: false }) acceptanceStatusError?: string | null;
  /** Manifest-linked criteria for a run with no ledger; shown as evidence linked. */
  @property({ attribute: false }) acceptanceEvidenceLinks?: AcceptanceEvidenceLink[] | null;
  /** Why the evidence manifest behind that fallback could not be read. */
  @property({ attribute: false }) acceptanceEvidenceLinksError?: string | null;
  /** Turns a task-dir relative evidence path into a link the host can serve. */
  @property({ attribute: false }) acceptanceEvidenceHref?: (evidencePath: string) => string;
  /** Opens a clicked acceptance evidence file in the host's viewer. */
  @property({ attribute: false }) acceptanceEvidenceOpen?: (open: AcceptanceEvidenceOpen) => void;
  @property() selectedStepName?: string;
  /** Run detail's header already shows a blocked run's reason, so the status row leaves it out. */
  @property({ type: Boolean, attribute: 'reason-in-header' }) reasonInHeader = false;
  @state() private monitorExpanded = false;
  /**
   * Command Center opens an unsettled child on first sight (this panel exists
   * to watch work in flight); after that the viewer's own expand/collapse wins,
   * so a progress update cannot reopen what they closed. Scoped by run: this
   * element is reused when run detail swaps the run, and `runChanged` resets
   * only the state it knows about.
   */
  @state() private autoExpandDone = false;
  @state() private cancelPending = false;
  @state() private transferProgress: FileTransferUiEntry | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private _unsubTransfer: (() => void) | null = null;
  private _releaseTransfer: (() => void) | null = null;

  static styles = [runPipelineStyles, acceptancePanelStyles];

  willUpdate(changed: PropertyValues) {
    if (changed.has('run')) {
      const previous = changed.get('run') as Run | undefined;
      const runChanged = previous?.id !== this.run?.id;
      const terminal = this.run ? isTerminalRunStatus(this.run.status) : false;
      if (runChanged || terminal) this.cancelPending = false;
      if (runChanged) this.transferProgress = primaryTransferForRun(this.run?.id);
    }
    if (!this.autoExpandDone && (changed.has('run') || changed.has('taskProgress'))) {
      if (this._activeTaskProgress()) {
        this.monitorExpanded = true;
        this.autoExpandDone = true;
      }
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this.elapsedTimer = setInterval(() => this.requestUpdate(), 1000);
    this._releaseTransfer = retainFileTransferStore();
    this._unsubTransfer = subscribeFileTransferStore(() => {
      this.transferProgress = primaryTransferForRun(this.run?.id);
    });
    this.transferProgress = primaryTransferForRun(this.run?.id);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    this._unsubTransfer?.();
    this._unsubTransfer = null;
    this._releaseTransfer?.();
    this._releaseTransfer = null;
  }

  private _vis(step: RunStep): RunStepDisplayStatus {
    return runStepDisplayStatus(this.run, step);
  }

  render() {
    if (!this.run) return nothing;
    const layout = computeLayout(this.run);
    const activityLabel =
      this.reasonInHeader && this.run.status === 'blocked'
        ? undefined
        : deriveRunLifecycleView(this.run).activityLabel;
    const isActive = !isTerminalRunStatus(this.run.status);
    const recovery = this.run.engineState?.publishGate?.reviewRecovery;
    const showRecovery = Boolean(recovery && recovery.status !== 'recovered');

    return html`
      <div class="pipeline-wrap">
        ${activityLabel
          ? html`<div class="pipeline-status-row">
              <span role="status" class="pipeline-activity" title=${activityLabel}
                >${activityLabel}</span
              >
              ${isActive && !showRecovery ? this.renderControls() : nothing}
            </div>`
          : nothing}
        ${showRecovery
          ? html`
              <div class="pipeline-status-row">
                ${renderReviewRecoveryStatus(this.run)}
                ${isActive ? this.renderControls() : nothing}
              </div>
            `
          : isActive && !activityLabel
            ? this.renderControls()
            : nothing}
        <svg
          viewBox="0 0 ${layout.width} ${layout.height}"
          width="${layout.width}"
          class="pipeline-svg"
          preserveAspectRatio="xMinYMin meet"
        >
          ${this.renderSvgContent(layout)}
        </svg>
        ${this.renderRunSummary()}
        ${this.transferProgress?.state === 'running'
          ? html`
              <div
                class="pipeline-transfer-strip"
                data-testid="pipeline-transfer-strip"
                title=${this.transferProgress.path}
              >
                <span class="pipeline-transfer-label"
                  >${this.transferProgress.phase === 'mirror'
                    ? 'mirroring'
                    : this.transferProgress.phase === 'upload'
                      ? 'uploading'
                      : 'transferring'}</span
                >
                <span class="pipeline-transfer-meta"
                  >${this.transferProgress.label ?? this.transferProgress.path.split('/').pop()} ·
                  ${this.transferProgress.totalBytes > 0
                    ? `${Math.min(
                        100,
                        Math.round(
                          (this.transferProgress.bytesTransferred /
                            this.transferProgress.totalBytes) *
                            100,
                        ),
                      )}%`
                    : '…'}${this.transferProgress.filesTotal
                    ? ` · ${this.transferProgress.filesCompleted ?? 0}/${this.transferProgress.filesTotal} files`
                    : ''}</span
                >
              </div>
            `
          : nothing}
        ${this.monitorExpanded &&
        this._activeTaskProgress() &&
        pipelineDetachedProgressVisible(this.run, this.selectedStepName, this._activeTaskProgress())
          ? this.renderProgressPanel()
          : nothing}
        ${this.renderAcceptancePanel()}
      </div>
    `;
  }

  private _selectStep(step: RunStep): void {
    this.dispatchEvent(
      new CustomEvent('step-select', { detail: { step }, bubbles: true, composed: true }),
    );
  }

  private renderSvgContent(layout: PipelineLayout) {
    const nodeMap = new Map(layout.nodes.map((n) => [n.id, n]));
    const specialNodeContext = this._specialNodeContext();
    return svg`
      ${renderPipelineDefs()}
      ${renderPipelineLanes(layout)}
      ${layout.arrows.map((a, i) => renderPipelineArrow(a, this._vis(layout.nodes[i].step)))}
      ${layout.nodes.map((n) =>
        n.id === 'monitor'
          ? renderMonitorPipelineNode(n, specialNodeContext)
          : n.id === 'review'
            ? renderReviewPipelineNode(n, specialNodeContext)
            : n.id === 'complete'
              ? renderCompletePipelineNode(n, specialNodeContext)
              : n.id === 'package-refresh'
                ? renderPackageRefreshPipelineNode(n, specialNodeContext)
                : n.id.includes('publication-review-')
                  ? renderPublicationReviewPipelineNode(n, specialNodeContext)
                  : n.id === 'human-gate'
                    ? renderHumanGatePipelineNode(n, specialNodeContext)
                    : n.id === 'finalize'
                      ? renderFinalizePipelineNode(n, specialNodeContext)
                      : renderDefaultPipelineNode(n, {
                          run: this.run,
                          visibleStatus: this._vis(n.step),
                          onStepSelect: (step) => this._selectStep(step),
                        }),
      )}
      ${renderReviewLoop(nodeMap, (step) => this._vis(step))}
      ${renderPublicationReviewLoops(layout.nodes, (step) => this._vis(step))}
      ${renderPipelineDecisions(this.run, nodeMap)}
      ${renderPipelineFocus({
        nodes: layout.nodes,
        selectedStepName: this.selectedStepName,
        currentNodeId: currentPipelineNodeId(this.run),
      })}
    `;
  }

  private _specialNodeContext(): RunPipelineSpecialNodeRenderContext {
    return {
      run: this.run,
      visibleStatus: (step) => this._vis(step),
      inlineCiFixActive: this._isInlineCIFixActive(),
      monitorTaskProgress: this._monitorTaskProgress(),
      reviewTaskProgress: this._reviewTaskProgress(),
      transferProgress: this.transferProgress,
      toggleProgressPanel: () => {
        this.monitorExpanded = !this.monitorExpanded;
      },
      onStepSelect: (step) => this._selectStep(step),
    };
  }

  private renderControls() {
    return renderPipelineControls(
      this.run,
      {
        pause: () => this.handlePause(),
        resume: () => this.handleResume(),
        cancel: () => this.handleCancel(),
      },
      { cancelPending: this.cancelPending },
    );
  }

  private renderRunSummary() {
    return renderRunPipelineSummary(this.run);
  }

  /**
   * The acceptance ledger sits beside the progress panel, not under a step: it is
   * the run's proof record for the whole task directory. Always visible when the
   * run has one, because whether the criteria are proven is the question the
   * operator opens run detail to answer.
   */
  private renderAcceptancePanel() {
    const inputs = acceptancePanelInputs(this);
    if (!inputs) return nothing;
    const { ledger, ...options } = inputs;
    return renderAcceptancePanel(ledger, {
      ...options,
      showOccurrences: true,
      openOccurrence: (traceIndex) =>
        this.dispatchEvent(
          new CustomEvent('recipe-proof', {
            detail: { traceIndex },
            bubbles: true,
            composed: true,
          }),
        ),
      ...(this.acceptanceEvidenceHref ? { evidenceHref: this.acceptanceEvidenceHref } : {}),
      ...(this.acceptanceEvidenceOpen ? { openEvidence: this.acceptanceEvidenceOpen } : {}),
    });
  }

  private renderProgressPanel() {
    const progress = this._activeTaskProgress();
    if (!progress) return nothing;
    return html`<progress-tracker
      .structured=${progress}
      .openScope=${this.subtaskOpen.scope(this.run?.id)}
      .activeStep=${this._activeTaskProgressStepId()}
      .activeTaskBasename=${this.run.activeTaskFile?.split('/').pop()}
      .runId=${this.run.id}
      .runActive=${isRunWorking(this.run)}
      closable
      @progress-close=${() => {
        this.monitorExpanded = false;
      }}
    ></progress-tracker>`;
  }

  private _isInlineCIFixActive(): boolean {
    return isInlineCiFixActiveFromOutputs(ciWatchOutputsForRun(this.run));
  }

  private _effectiveTaskProgress(): TaskProgressStructured | undefined {
    return effectiveTaskProgressForRun(this.run, this.taskProgress);
  }

  private _monitorTaskProgress(): TaskProgressStructured | undefined {
    return this._activeTaskProgressStepId() === 'monitor'
      ? this._effectiveTaskProgress()
      : undefined;
  }

  private _reviewTaskProgress(): TaskProgressStructured | undefined {
    return this._activeTaskProgressStepId() === 'review'
      ? this._effectiveTaskProgress()
      : undefined;
  }

  private _activeTaskProgress(): TaskProgressStructured | undefined {
    const activeStep = this._activeTaskProgressStepId();
    return activeStep ? this._effectiveTaskProgress() : undefined;
  }

  private _activeTaskProgressStepId(): 'monitor' | 'review' | 'ci-watch' | 'human-gate' | null {
    return activeTaskProgressStepId(this.run, this.taskProgress);
  }

  private async handlePause() {
    try {
      await gateway.request(Methods.RUN_PAUSE, { runId: this.run.id });
    } catch (err) {
      console.error('Failed to pause run:', err);
      alert(`Pause failed: ${(err as Error).message}`);
    }
  }

  private async handleResume() {
    try {
      await gateway.request(Methods.RUN_RESUME, { runId: this.run.id });
    } catch (err) {
      console.error('Failed to resume run:', err);
      alert(`Resume failed: ${(err as Error).message}`);
    }
  }

  private async handleCancel() {
    if (this.cancelPending) return;
    this.cancelPending = true;
    try {
      const result = await gateway.request<RunCancelResult>(Methods.RUN_CANCEL, {
        runId: this.run.id,
      });
      // The run reaching `cancelled` does not mean teardown finished. Silence here
      // would tell the operator the stop fully landed while a slot stays claimed.
      const failed = failedRunCancelEffects(result.effects);
      if (failed.length) {
        alert(
          `Run cancelled, but part of the teardown failed:\n${failed
            .map((effect) => `${effect.name}: ${effect.detail ?? 'failed'}`)
            .join('\n')}`,
        );
      }
    } catch (err) {
      this.cancelPending = false;
      console.error('Failed to cancel run:', err);
      alert(`Cancel failed: ${(err as Error).message}`);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'run-pipeline': RunPipeline;
  }
}
