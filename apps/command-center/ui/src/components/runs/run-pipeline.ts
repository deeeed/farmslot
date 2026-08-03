import { html, LitElement, nothing, type PropertyValues, svg } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  Run,
  RunCancelResult,
  RunStep,
  RunStepStatus,
  TaskProgressStructured,
} from '@farmslot/protocol';
import { failedRunCancelEffects, Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import {
  activeTaskProgressStepId,
  ciWatchOutputsForRun,
  computeLayout,
  effectiveTaskProgressForRun,
  isInlineCiFixActiveFromOutputs,
  type PipelineLayout,
} from './run-pipeline-model.js';
import {
  renderPipelineControls,
  renderPipelineProgressPanel,
  renderRunPipelineSummary,
} from './run-pipeline-panels.js';
import {
  renderCompletePipelineNode,
  renderFinalizePipelineNode,
  renderHumanGatePipelineNode,
  renderMonitorPipelineNode,
  renderPackageRefreshPipelineNode,
  renderPublicationReviewPipelineNode,
  renderSelfReviewPipelineNode,
  type RunPipelineSpecialNodeRenderContext,
} from './run-pipeline-special-node-renderers.js';
import { runPipelineStyles } from './run-pipeline-styles.js';
import {
  renderDefaultPipelineNode,
  renderPipelineArrow,
  renderPipelineDecisions,
  renderPipelineDefs,
  renderPipelineLanes,
  renderPublicationReviewLoops,
  renderSelfReviewLoop,
} from './run-pipeline-svg-renderers.js';
import { effectiveStepStatus } from './run-utils.js';

@customElement('run-pipeline')
export class RunPipeline extends LitElement {
  @property({ attribute: false }) run!: Run;
  @property({ attribute: false }) taskProgress?: TaskProgressStructured;
  @state() private monitorExpanded = false;
  @state() private autoExpandDone = false;
  @state() private cancelPending = false;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;

  static styles = runPipelineStyles;

  willUpdate(changed: PropertyValues) {
    if (changed.has('run')) {
      const previous = changed.get('run') as Run | undefined;
      const runChanged = previous?.id !== this.run?.id;
      const terminal = ['done', 'failed', 'cancelled'].includes(this.run?.status ?? '');
      if (runChanged || terminal) this.cancelPending = false;
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
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }

  private _vis(status: RunStepStatus): RunStepStatus {
    return effectiveStepStatus(status, this.run?.status ?? '');
  }

  render() {
    if (!this.run) return nothing;
    const layout = computeLayout(this.run);
    const isActive = !['done', 'failed', 'cancelled'].includes(this.run.status);

    return html`
      <div class="pipeline-wrap">
        ${isActive ? this.renderControls() : nothing}
        <svg
          viewBox="0 0 ${layout.width} ${layout.height}"
          width="${layout.width}"
          class="pipeline-svg"
          preserveAspectRatio="xMinYMin meet"
        >
          ${this.renderSvgContent(layout)}
        </svg>
        ${this.renderRunSummary()}
        ${this.monitorExpanded && this._activeTaskProgress() ? this.renderProgressPanel() : nothing}
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
      ${layout.arrows.map((a) => renderPipelineArrow(a, this._vis(a.status as RunStepStatus)))}
      ${layout.nodes.map((n) =>
        n.id === 'monitor'
          ? renderMonitorPipelineNode(n, specialNodeContext)
          : n.id === 'self-review'
            ? renderSelfReviewPipelineNode(n, specialNodeContext)
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
                          visibleStatus: this._vis(n.step.status),
                          onStepSelect: (step) => this._selectStep(step),
                        }),
      )}
      ${renderSelfReviewLoop(nodeMap, (step) => this._vis(step.status))}
      ${renderPublicationReviewLoops(layout.nodes, (step) => this._vis(step.status))}
      ${renderPipelineDecisions(this.run, nodeMap)}
    `;
  }

  private _specialNodeContext(): RunPipelineSpecialNodeRenderContext {
    return {
      run: this.run,
      visibleStatus: (step) => this._vis(step.status),
      inlineCiFixActive: this._isInlineCIFixActive(),
      monitorTaskProgress: this._monitorTaskProgress(),
      selfReviewTaskProgress: this._selfReviewTaskProgress(),
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

  private renderProgressPanel() {
    const progress = this._activeTaskProgress();
    if (!progress) return nothing;
    return renderPipelineProgressPanel(
      progress,
      this._activeTaskProgressStepId(),
      () => {
        this.monitorExpanded = false;
      },
      this.run.activeTaskFile?.split('/').pop(),
    );
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

  private _selfReviewTaskProgress(): TaskProgressStructured | undefined {
    return this._activeTaskProgressStepId() === 'self-review'
      ? this._effectiveTaskProgress()
      : undefined;
  }

  private _activeTaskProgress(): TaskProgressStructured | undefined {
    const activeStep = this._activeTaskProgressStepId();
    return activeStep ? this._effectiveTaskProgress() : undefined;
  }

  private _activeTaskProgressStepId(): 'monitor' | 'self-review' | 'ci-watch' | null {
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
