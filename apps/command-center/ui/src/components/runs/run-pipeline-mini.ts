import { css, html, LitElement, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import type { FlowType, Run, RunStep } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';
import {
  activePublicationReviewLabel,
  compactHumanGateLabel,
  reviewSegmentLabel,
} from '../../utils/review-gate-display.js';

import {
  computePackageRefreshStatus,
  pipelineStepTone,
  pipelineToneColor,
  publicationReviewVerdictStatus,
} from './run-pipeline-status.js';
import { effectiveStepStatus, formatDuration } from './run-utils.js';

interface MiniSegment {
  name: string;
  status: RunStep['status'];
  title: string;
  /** Optional outputs for tone (e.g. review verdict → orange for issues). */
  outputs?: Record<string, unknown>;
  detail?: string;
}

@customElement('run-pipeline-mini')
export class RunPipelineMini extends LitElement {
  @property({ attribute: false }) run?: Run;
  @property({ attribute: false }) steps: RunStep[] = [];
  @property() flowType: FlowType = 'fix-bug';

  static styles = css`
    :host {
      display: inline-flex;
      gap: 2px;
      align-items: center;
      min-width: 0;
      width: fit-content;
      max-width: 100%;
    }
    .bars {
      display: flex;
      gap: 2px;
      align-items: center;
      flex: 0 1 auto;
      min-width: 0;
    }
    .seg {
      height: 4px;
      min-width: 8px;
      max-width: 24px;
      width: clamp(8px, 1.4vw, 18px);
      flex: 0 1 clamp(8px, 1.4vw, 18px);
      border-radius: 2px;
    }
    @keyframes mini-pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.4;
      }
    }
    .seg.running {
      animation: mini-pulse 1.5s ease-in-out infinite;
    }
    .seg.pending {
      opacity: 0.32;
      outline: 1px solid rgba(156, 163, 175, 0.18);
    }
    .seg.done {
      opacity: 0.86;
    }
    .seg.failed {
      opacity: 1;
    }
    .seg.warn {
      opacity: 1;
    }
    .active-label {
      color: ${unsafeCSS('#9ca3af')};
      font-size: 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 140px;
      margin-left: 4px;
      flex: 0 1 auto;
    }
  `;

  render() {
    const isCancelled = this.run?.status === 'cancelled';
    const segments = this.buildSegments();
    if (isCancelled) {
      for (const seg of segments) {
        seg.status = effectiveStepStatus(seg.status, 'cancelled');
      }
    }
    const runningIndex = segments.reduce(
      (latest, segment, index) => (segment.status === 'running' ? index : latest),
      -1,
    );
    const nextIndex = segments.findIndex((segment) => segment.status === 'pending');
    const labelIndex =
      runningIndex >= 0 ? runningIndex : nextIndex >= 0 ? nextIndex : segments.length - 1;
    const active = segments[labelIndex];
    const remaining = active
      ? segments.slice(labelIndex + 1).filter((segment) => segment.status === 'pending').length
      : 0;
    return html`
      <div class="bars">
        ${segments.map((segment) => {
          const tone = pipelineStepTone(
            {
              name: segment.name,
              status: segment.status,
              detail: segment.detail,
              outputs: segment.outputs,
            },
            { runError: this.run?.error },
          );
          const toneClass = tone === 'warn' ? 'warn' : segment.status;
          return html`
            <span
              class="seg ${toneClass}"
              style="background:${unsafeCSS(pipelineToneColor(tone))}"
              title=${segment.title}
            ></span>
          `;
        })}
      </div>
      ${isCancelled
        ? html`<span class="active-label" style="color:${unsafeCSS(colors.statusWarn)}"
            >cancelled</span
          >`
        : active
          ? html`<span class="active-label" title=${active.title}
              >${this.shortName(active.name)}${remaining ? ` +${remaining}` : ''}</span
            >`
          : null}
    `;
  }

  private buildSegments(): MiniSegment[] {
    const run = this.run;
    const sourceSteps = (run?.steps ?? this.steps).filter((step) => step.status !== 'skipped');
    const preGateReviews = this.reviewSegments('dispatch', 'pre-gate review');
    const waitingForPreGateReviews = preGateReviews.some(
      (segment) => segment.status === 'running' || segment.status === 'pending',
    );
    const segments: MiniSegment[] = [];
    for (const step of sourceSteps) {
      const displayStep = this.pipelineDisplayStep(step, waitingForPreGateReviews);
      segments.push({
        name: displayStep.name,
        status: displayStep.status,
        title: this.segmentTitle(displayStep),
        outputs: displayStep.outputs as Record<string, unknown> | undefined,
        detail: displayStep.detail,
      });
      if (step.name === 'self-review') {
        segments.push(...preGateReviews);
      }
      if (step.name === 'human-gate') {
        const extraReviews = this.reviewSegments('human-gate', 'requested review');
        segments.push(...extraReviews);
        if (extraReviews.length > 0) {
          // Shared with canvas: stay pending while re-review/fix is in flight,
          // even if earlier loops ended in issues/failed.
          const lastReview =
            [...extraReviews].reverse().find((s) => s.outputs?.verdict) ??
            extraReviews[extraReviews.length - 1];
          const lastVerdict =
            typeof lastReview?.outputs?.verdict === 'string'
              ? lastReview.outputs.verdict
              : undefined;
          const refreshStatus = computePackageRefreshStatus(
            extraReviews.map((s) => s.status),
            this.run,
          );
          segments.push({
            name: 'package refresh',
            status: refreshStatus,
            title:
              refreshStatus === 'pending'
                ? 'package refresh: waiting for review/fix before rebuild'
                : 'package refresh: rebuild package after requested review',
            outputs: lastVerdict ? { lastReviewVerdict: lastVerdict } : undefined,
            detail:
              refreshStatus === 'pending'
                ? 'waiting for review/fix before package rebuild'
                : undefined,
          });
        }
      }
    }
    return segments;
  }

  private pipelineDisplayStep(step: RunStep, waitingForPreGateReviews: boolean): RunStep {
    if (!waitingForPreGateReviews) return step;
    if (step.name !== 'complete' && step.name !== 'human-gate') return step;
    return {
      ...step,
      status: 'pending',
      detail: step.name === 'complete' ? 'waiting for reviews' : 'waiting for package',
      startedAt: undefined,
      completedAt: undefined,
      durationMs: undefined,
    };
  }

  private reviewSegments(source: 'dispatch' | 'human-gate', label: string): MiniSegment[] {
    const publishGate = (this.run?.engineState as any)?.publishGate as
      | Record<string, any>
      | undefined;
    if (!publishGate) return [];
    const requestedBy =
      publishGate.reviewDepth?.requestedBy === 'human-gate' ? 'human-gate' : 'dispatch';
    const pendingPlan = Array.isArray(publishGate.pendingReviewPlan)
      ? (publishGate.pendingReviewPlan as Array<Record<string, unknown>>)
      : [];
    const segments: MiniSegment[] = [];
    if (pendingPlan.length > 0 && requestedBy === source) {
      segments.push(...this.planSegments(pendingPlan, label));
    }
    const reviews = Array.isArray(publishGate.independentReviews)
      ? (publishGate.independentReviews as Array<Record<string, unknown>>)
      : [];
    const minimum = Number(publishGate.reviewDepth?.minimumIndependentReviews ?? 1);
    for (const review of reviews) {
      const reviewLaneSource = review.source === 'human-gate' ? 'human-gate' : 'dispatch';
      const loopNumber = Number(review.loopNumber ?? 0);
      if (reviewLaneSource !== source) continue;
      if (source === 'dispatch' && loopNumber <= minimum && review.crossRunner !== true) continue;
      const runner =
        typeof review.runner === 'string' && review.runner.trim()
          ? review.runner.trim()
          : 'reviewer';
      const verdict = typeof review.verdict === 'string' ? review.verdict : '';
      // Shared with canvas: issues → failed+warn (orange), terminal failed → red.
      const status = publicationReviewVerdictStatus(verdict);
      const order = Math.max(1, source === 'dispatch' ? loopNumber - minimum : segments.length + 1);
      const reviewSource =
        review.source === 'human-gate'
          ? 'human-gate'
          : review.source === 'self-review'
            ? 'self-review'
            : 'dispatch';
      const segmentName = reviewSegmentLabel(
        {
          source: reviewSource,
          crossRunner: review.crossRunner === true,
        },
        order,
      );
      segments.push({
        name: segmentName,
        status,
        title: `${segmentName}: ${runner}${verdict ? ` / ${verdict}` : ''}`,
        outputs: verdict ? { verdict } : undefined,
      });
    }
    const active = this.activeReviewSegment(source, label);
    if (active && !segments.some((segment) => segment.name === active.name)) segments.push(active);
    const activeContextLabel =
      source === 'human-gate' ? activePublicationReviewLabel(this.run) : null;
    if (activeContextLabel && !segments.some((segment) => segment.status === 'running')) {
      segments.push({
        name: activeContextLabel,
        status: 'running',
        title: `${activeContextLabel}: running`,
      });
    }
    if (segments.length <= 5) return segments;
    let activeIndex = -1;
    segments.forEach((segment, index) => {
      if (segment.status === 'running') activeIndex = index;
    });
    return activeIndex >= 5
      ? [...segments.slice(0, 4), segments[activeIndex]]
      : segments.slice(0, 5);
  }

  private planSegments(plan: Array<Record<string, unknown>>, label: string): MiniSegment[] {
    return plan.slice(0, 5).map((item, index) => {
      const runner =
        typeof item.runner === 'string' && item.runner.trim() ? item.runner.trim() : 'same';
      const model = typeof item.model === 'string' && item.model.trim() ? item.model.trim() : '';
      return {
        name: `${label} ${index + 1}`,
        status: 'pending' as const,
        title: `${label} ${index + 1}: ${runner}${model ? ` / ${model}` : ''}`,
      };
    });
  }

  private activeReviewSegment(
    source: 'dispatch' | 'human-gate',
    label: string,
  ): MiniSegment | null {
    const carrier = this.run?.steps.find((step) => {
      if (step.status !== 'running' || typeof step.detail !== 'string') return false;
      return /Running (dispatch|human-gate) ([\w.-]+) review \((\d+)\/(\d+)\)/i.test(step.detail);
    });
    if (!carrier?.detail) return null;
    const match = carrier.detail.match(
      /Running (dispatch|human-gate) ([\w.-]+) review \((\d+)\/(\d+)\)/i,
    );
    if (!match) return null;
    const activeSource = match[1].toLowerCase() === 'human-gate' ? 'human-gate' : 'dispatch';
    if (activeSource !== source) return null;
    const runner = match[2];
    const order = Math.max(1, Number(match[3]) || 1);
    return {
      name: `${label} ${order}`,
      status: 'running',
      title: `${label} ${order}: ${runner} / running`,
    };
  }

  private segmentTitle(step: RunStep): string {
    const outputs = step.outputs as Record<string, unknown> | undefined;
    const parts = [`${step.name}: ${step.status}`];
    if (step.durationMs) parts.push(formatDuration(step.durationMs));
    if (step.detail) parts.push(step.detail);
    if (step.name === 'complete' && outputs?.packageHash) {
      parts.push(`package ${String(outputs.packageHash).slice(0, 12)}`);
      parts.push(`review ${outputs.reviewSatisfied ? 'satisfied' : 'pending'}`);
    }
    if (step.name === 'human-gate' && outputs?.resolvedAction) {
      parts.push(`resolved ${outputs.resolvedAction}`);
    }
    if (step.name === 'finalize' && outputs?.publicationStatus) {
      parts.push(`publish ${outputs.publicationStatus}`);
    }
    return parts.join(' · ');
  }

  private shortName(name: string): string {
    if (name === 'human-gate') return compactHumanGateLabel(this.run);
    return name
      .replace('self-review', 'self review')
      .replace('ci-watch', 'CI')
      .replace('find-slot', 'slot')
      .replace('write-task', 'task');
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'run-pipeline-mini': RunPipelineMini;
  }
}
