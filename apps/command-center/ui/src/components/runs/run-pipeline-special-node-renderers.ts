import { nothing, svg } from 'lit';

import type { Run, RunStep, RunStepStatus, TaskProgressStructured } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';
import {
  type FileTransferUiEntry,
  formatPipelineTransferMeta,
  transferForPipelineNode,
  transferPercent as fileTransferPercent,
} from '../shared/file-transfer-progress-model.js';

import { NODE_H, type NodePos } from './run-pipeline-model.js';
import {
  pipelineStepTone,
  pipelineToneColor,
  pipelineToneFillStroke,
} from './run-pipeline-status.js';
import { formatDuration, formatElapsed, stepStatusColor } from './run-utils.js';

export interface RunPipelineSpecialNodeRenderContext {
  run: Run;
  visibleStatus: (step: RunStep) => RunStepStatus;
  inlineCiFixActive: boolean;
  monitorTaskProgress: TaskProgressStructured | undefined;
  selfReviewTaskProgress: TaskProgressStructured | undefined;
  /** Active/recent file transfer for this run (mirror/upload during package refresh). */
  transferProgress?: FileTransferUiEntry | null;
  toggleProgressPanel: () => void;
  onStepSelect: (step: RunStep) => void;
}

export function renderMonitorPipelineNode(n: NodePos, ctx: RunPipelineSpecialNodeRenderContext) {
  const step = n.step;
  const inlineFixActive = ctx.inlineCiFixActive;
  const vis = ctx.visibleStatus(step);
  const isRunning = vis === 'running' || inlineFixActive;
  const isDone = vis === 'done';
  const isFailed = vis === 'failed';
  const isPending = vis === 'pending';

  const fillColor = isDone
    ? `${colors.statusOk}12`
    : isRunning
      ? '#3b82f618'
      : isFailed
        ? `${colors.statusFail}12`
        : 'transparent';
  const strokeColor = isDone
    ? `${colors.statusOk}66`
    : isRunning
      ? '#3b82f6'
      : isFailed
        ? colors.statusFail
        : `${colors.textMuted}33`;

  const elapsed = step.durationMs
    ? formatDuration(step.durationMs)
    : step.startedAt
      ? formatElapsed(step.startedAt)
      : '';

  const tp = ctx.monitorTaskProgress;
  const hasProgress = !!tp && tp.totalSteps > 0;
  const pct = hasProgress ? (tp!.completedSteps / tp!.totalSteps) * 100 : 0;
  const progressW = n.w - 20;
  const fillW = hasProgress ? (pct / 100) * progressW : 0;
  const clickable = isRunning && hasProgress;

  return svg`
    <g class="${isRunning ? 'node-running-anim' : ''}"
       transform="translate(${n.x}, ${n.y})"
       style="opacity: ${isPending ? 0.4 : 1}; cursor: pointer"
       @click=${() => {
         if (clickable) {
           ctx.toggleProgressPanel();
         }
         ctx.onStepSelect(n.step);
       }}>
      <rect width="${n.w}" height="${NODE_H}" rx="6"
            fill="${fillColor}" stroke="${strokeColor}"/>
      <text class="node-label" x="8" y="11"
            dominant-baseline="central"
            fill="${colors.textPrimary}">
        monitor
      </text>
      ${
        elapsed
          ? svg`
        <text class="node-elapsed" x="${n.w - 8}" y="11"
              text-anchor="end" dominant-baseline="central"
              fill="${colors.textMuted}">
          ${elapsed}
        </text>
      `
          : nothing
      }
      ${
        hasProgress
          ? svg`
        <rect class="progress-bg" x="8" y="22" width="${progressW}" height="4"
              fill="${colors.bgSurface}" rx="2"/>
        <rect class="progress-fill" x="8" y="22" width="${fillW}" height="4"
              fill="${isRunning ? '#3b82f6' : isDone ? colors.statusOk : colors.textMuted}" rx="2"/>
        <text class="node-count" x="${n.w / 2}" y="32"
              text-anchor="middle" dominant-baseline="central"
              fill="${colors.textMuted}">
          ${tp!.completedSteps}/${tp!.totalSteps}
        </text>
      `
          : svg`
        ${
          !isPending
            ? svg`
          <text class="node-meta" x="${n.w / 2}" y="27"
                text-anchor="middle" dominant-baseline="central"
                fill="${stepStatusColor(vis)}">
            ${isDone ? 'v' : isRunning ? '*' : isFailed ? 'x' : ''}
          </text>
        `
            : nothing
        }
      `
      }
    </g>
  `;
}

export function renderSelfReviewPipelineNode(n: NodePos, ctx: RunPipelineSpecialNodeRenderContext) {
  const step = n.step;
  const vis = ctx.visibleStatus(step);
  const isRunning = vis === 'running';
  const isDone = vis === 'done';
  const isFailed = vis === 'failed';
  const isPending = vis === 'pending';
  const isSkipped = vis === 'skipped';
  // Shared tone map with mini (issues → orange unless maxRetriesExhausted).
  const tone = pipelineStepTone(step, { runError: ctx.run.error });
  const toneColors = pipelineToneFillStroke(tone);

  const fillColor =
    isDone || isRunning || isFailed || isSkipped
      ? isSkipped && tone === 'muted'
        ? `${colors.textMuted}12`
        : toneColors.fill
      : 'transparent';
  const strokeColor =
    isDone || isRunning || isFailed || isSkipped
      ? isSkipped && tone === 'muted'
        ? `${colors.textMuted}66`
        : toneColors.stroke
      : `${colors.textMuted}33`;

  const elapsed = step.durationMs
    ? formatDuration(step.durationMs)
    : step.startedAt
      ? formatElapsed(step.startedAt)
      : '';

  const detail = step.detail ?? '';
  const tp = ctx.selfReviewTaskProgress;
  const progressMatch = detail.match(/(\d+)\/(\d+)/);
  const done = tp?.completedSteps ?? (progressMatch ? parseInt(progressMatch[1], 10) : 0);
  const total = tp?.totalSteps ?? (progressMatch ? parseInt(progressMatch[2], 10) : 0);
  const hasProgress = total > 0;
  const progressW = n.w - 20;
  const fillW = hasProgress ? (done / total) * progressW : 0;
  const clickable = isRunning && hasProgress;

  const outputs = step.outputs ?? {};

  // Check for retry (outputs.retryCount > 0 or detail contains "Fix:")
  const retryCount = typeof outputs.retryCount === 'number' ? outputs.retryCount : 0;
  const hasRetry = retryCount > 0 || detail.startsWith('Fix:');
  const phase = detail.startsWith('Fix:') ? 'fix' : 'review';

  // Verdict badge for done state
  const verdict = typeof outputs.verdict === 'string' ? outputs.verdict : undefined;
  const maxRetries = typeof outputs.maxRetries === 'number' ? outputs.maxRetries : undefined;
  const maxRetriesExhausted = outputs.maxRetriesExhausted === true;
  const verdictColor =
    verdict === 'pass' ? colors.statusOk : verdict === 'issues' ? pipelineToneColor(tone) : '';

  return svg`
    <g class="${isRunning ? 'node-running-anim' : ''}"
       transform="translate(${n.x}, ${n.y})"
       style="opacity: ${isPending ? 0.4 : isSkipped ? 0.72 : 1}; cursor: pointer"
       @click=${() => {
         if (clickable) {
           ctx.toggleProgressPanel();
         }
         ctx.onStepSelect(n.step);
       }}>
      <rect width="${n.w}" height="${NODE_H}" rx="6"
            fill="${fillColor}" stroke="${strokeColor}"/>
      <text class="node-label" x="8" y="11"
            dominant-baseline="central"
            fill="${colors.textPrimary}">
        self-review${hasRetry ? ` (${phase})` : ''}
      </text>
      ${
        elapsed
          ? svg`
        <text class="node-elapsed" x="${n.w - 8}" y="11"
              text-anchor="end" dominant-baseline="central"
              fill="${colors.textMuted}">
          ${elapsed}
        </text>
      `
          : nothing
      }
      ${
        hasProgress
          ? svg`
        <rect class="progress-bg" x="8" y="22" width="${progressW}" height="4"
              fill="${colors.bgSurface}" rx="2"/>
        <rect class="progress-fill" x="8" y="22" width="${fillW}" height="4"
              fill="${isRunning ? '#3b82f6' : isDone ? colors.statusOk : colors.textMuted}" rx="2"/>
        <text class="node-count" x="${n.w / 2}" y="32"
              text-anchor="middle" dominant-baseline="central"
              fill="${colors.textMuted}">
          ${done}/${total}
        </text>
      `
          : isFailed && maxRetriesExhausted
            ? svg`
        <text class="node-meta" x="${n.w / 2}" y="27"
              text-anchor="middle" dominant-baseline="central"
              fill="${pipelineToneColor('fail')}">
          ! MAX RETRIES (${retryCount}${maxRetries !== undefined ? `/${maxRetries}` : ''})
        </text>
      `
            : isFailed && verdict === 'issues'
              ? svg`
        <text class="node-meta" x="${n.w / 2}" y="27"
              text-anchor="middle" dominant-baseline="central"
              fill="${pipelineToneColor(tone)}">
          ! ISSUES${retryCount > 0 ? ` (${retryCount}x)` : ''}
        </text>
      `
              : isDone && verdictColor
                ? svg`
        <text class="node-meta" x="${n.w / 2}" y="27"
              text-anchor="middle" dominant-baseline="central"
              fill="${verdictColor}">
          ${verdict === 'pass' ? 'v PASS' : verdict === 'issues' ? '! ISSUES' : 'v'}
        </text>
      `
                : isSkipped
                  ? svg`
        <text class="node-meta" x="${n.w / 2}" y="27"
              text-anchor="middle" dominant-baseline="central"
              fill="${colors.textMuted}">
          - skipped
        </text>
      `
                  : svg`
        ${
          !isPending && !isDone
            ? svg`
          <text class="node-meta" x="${n.w / 2}" y="27"
                text-anchor="middle" dominant-baseline="central"
                fill="${stepStatusColor(vis)}">
            ${isRunning ? '*' : isFailed ? 'x' : ''}
          </text>
        `
            : nothing
        }
      `
      }
      ${
        hasRetry
          ? svg`
        <g transform="translate(${n.w - 18}, 2)">
          <path d="M6,0 A6,6 0 1,1 0,6" fill="none"
                stroke="${isRunning ? '#3b82f6' : colors.textMuted}" stroke-width="1.5"/>
          <path d="M-1,3 L0,6 L3,5" fill="none"
                stroke="${isRunning ? '#3b82f6' : colors.textMuted}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
      `
          : nothing
      }
    </g>
  `;
}

function stepTiming(step: RunStep): string {
  if (step.durationMs) return formatDuration(step.durationMs);
  if (step.startedAt && step.completedAt) {
    const ms = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime();
    return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : '';
  }
  return step.startedAt ? formatElapsed(step.startedAt) : '';
}

export function renderPublicationReviewPipelineNode(
  n: NodePos,
  ctx: RunPipelineSpecialNodeRenderContext,
) {
  const step = n.step;
  const vis = ctx.visibleStatus(step);
  const isRunning = vis === 'running';
  const isDone = vis === 'done';
  const isFailed = vis === 'failed';
  const isPending = vis === 'pending';
  // Shared with mini: issues → orange (warn), terminal failed → red.
  const tone = pipelineStepTone(step, { runError: ctx.run.error });
  const accent = '#a78bfa';
  const { fill: toneFill, stroke: toneStroke } = pipelineToneFillStroke(tone);
  const fillColor =
    tone === 'ok' || tone === 'warn' || tone === 'fail' || tone === 'running'
      ? toneFill
      : isRunning
        ? `${accent}1f`
        : `${accent}0c`;
  const strokeColor =
    tone === 'ok' || tone === 'warn' || tone === 'fail' || tone === 'running'
      ? toneStroke
      : isRunning
        ? accent
        : `${accent}55`;
  const statusLabel = isPending
    ? 'pre-gate'
    : isRunning
      ? 'running'
      : tone === 'warn'
        ? 'issues'
        : isDone
          ? 'done'
          : isFailed
            ? 'failed'
            : '';
  const timing = stepTiming(step);
  const metaColor =
    tone === 'warn' || tone === 'fail' || tone === 'ok'
      ? pipelineToneColor(tone)
      : colors.textSecondary;
  return svg`
    <g class="${isRunning ? 'node-running-anim' : ''}"
       transform="translate(${n.x}, ${n.y})"
       style="opacity: ${isPending ? 0.72 : 1}; cursor: pointer"
       @click=${() => ctx.onStepSelect(n.step)}>
      <rect width="${n.w}" height="${NODE_H}" rx="6"
            fill="${fillColor}" stroke="${strokeColor}"/>
      <text class="node-label" x="8" y="11"
            dominant-baseline="central"
            fill="${colors.textPrimary}">
        ${n.label ?? 'review'}
      </text>
      <text class="node-meta" x="${n.w - 8}" y="11"
            text-anchor="end" dominant-baseline="central"
            fill="${accent}">
        ${timing || statusLabel}
      </text>
      <text class="node-meta" x="${n.w / 2}" y="27"
            text-anchor="middle" dominant-baseline="central"
            fill="${metaColor}">
        ${(n.meta ?? step.detail ?? '').slice(0, 22)}
      </text>
    </g>
  `;
}

export function renderPackageRefreshPipelineNode(
  n: NodePos,
  ctx: RunPipelineSpecialNodeRenderContext,
) {
  const vis = ctx.visibleStatus(n.step);
  const isDone = vis === 'done';
  const isFailed = vis === 'failed';
  const isPending = vis === 'pending';
  const transfer = transferForPipelineNode(ctx.transferProgress, 'package-refresh');
  const transferActive = transfer?.state === 'running';
  const tone = pipelineStepTone(n.step, { runError: ctx.run.error });
  const { fill: fillColor, stroke: strokeColor } = transferActive
    ? { fill: '#3b82f618', stroke: '#3b82f6' }
    : tone === 'ok' || tone === 'warn' || tone === 'fail'
      ? pipelineToneFillStroke(tone)
      : { fill: '#3b82f610', stroke: '#3b82f688' };
  const timing = stepTiming(n.step);
  const metaLabel = transfer
    ? formatPipelineTransferMeta(transfer)
    : isDone
      ? 'updated'
      : isPending
        ? 'waiting on review'
        : tone === 'warn'
          ? 'rework'
          : isFailed
            ? 'failed'
            : 'after requested review';
  const pct = transfer ? fileTransferPercent(transfer) : 0;
  const barW = Math.max(0, Math.min(n.w - 16, ((n.w - 16) * pct) / 100));
  return svg`
    <g transform="translate(${n.x}, ${n.y})"
       style="opacity: ${isPending && !transferActive ? 0.72 : 1}; cursor: pointer"
       data-testid="pipeline-package-refresh-node"
       data-transfer-active=${transferActive ? 'true' : 'false'}
       @click=${() => ctx.onStepSelect(n.step)}>
      <rect width="${n.w}" height="${NODE_H}" rx="6"
            fill="${fillColor}" stroke="${strokeColor}" stroke-dasharray="${isPending && !transferActive ? '4 3' : 'none'}"/>
      <text class="node-label" x="8" y="11"
            dominant-baseline="central"
            fill="${colors.textPrimary}">
        package refresh
      </text>
      ${
        timing && !transferActive
          ? svg`
        <text class="node-elapsed" x="${n.w - 8}" y="11"
              text-anchor="end" dominant-baseline="central"
              fill="${colors.textMuted}">
          ${timing}
        </text>
      `
          : nothing
      }
      <text class="node-meta" x="${n.w / 2}" y="27"
            text-anchor="middle" dominant-baseline="central"
            data-testid="pipeline-package-refresh-transfer-meta"
            fill="${
              transferActive
                ? colors.accent
                : isDone || isFailed || tone === 'warn'
                  ? pipelineToneColor(tone === 'muted' ? (isDone ? 'ok' : 'fail') : tone)
                  : colors.textSecondary
            }">
        ${metaLabel}
      </text>
      ${
        transferActive
          ? svg`
        <rect x="8" y="${NODE_H - 6}" width="${n.w - 16}" height="3" rx="1.5"
              fill="#1a1a2e"/>
        <rect x="8" y="${NODE_H - 6}" width="${barW}" height="3" rx="1.5"
              fill="${colors.accent}"
              data-testid="pipeline-package-refresh-transfer-bar"/>
      `
          : nothing
      }
    </g>
  `;
}

export function renderHumanGatePipelineNode(n: NodePos, ctx: RunPipelineSpecialNodeRenderContext) {
  const step = n.step;
  const vis = ctx.visibleStatus(step);
  const isRunning = vis === 'running';
  const isDone = vis === 'done';
  const isFailed = vis === 'failed';
  const isPending = vis === 'pending';
  const isBlocked =
    isRunning && ctx.run.status === 'blocked' && ctx.run.decisions.some((d) => !d.resolvedAt);

  // Human-gate always has a distinct amber border to show where intervention is expected
  const gateAccent = colors.statusWarn;
  const fillColor = isBlocked
    ? `${gateAccent}18`
    : isDone
      ? `${colors.statusOk}12`
      : isRunning
        ? `${gateAccent}10`
        : isFailed
          ? `${colors.statusFail}12`
          : `${gateAccent}06`;
  const strokeColor = isBlocked
    ? gateAccent
    : isDone
      ? `${colors.statusOk}66`
      : isRunning
        ? gateAccent
        : isFailed
          ? colors.statusFail
          : `${gateAccent}55`;

  const duration = step.durationMs
    ? formatDuration(step.durationMs)
    : step.startedAt
      ? formatElapsed(step.startedAt)
      : '';

  // Post-resolution actions
  const outputs = step.outputs ?? {};
  const resolvedAction =
    typeof outputs.resolvedAction === 'string' ? outputs.resolvedAction : undefined;
  const actionColor =
    resolvedAction === 'ready' || resolvedAction === 'approve-publish'
      ? colors.statusOk
      : resolvedAction === 'hold'
        ? colors.statusWarn
        : colors.textMuted;

  return svg`
    <g class="${isBlocked ? 'node-blocked-anim' : isRunning ? 'node-running-anim' : ''}"
       transform="translate(${n.x}, ${n.y})"
       style="opacity: ${isPending ? 0.4 : 1}; cursor: pointer"
       @click=${() => ctx.onStepSelect(n.step)}>
      <rect width="${n.w}" height="${NODE_H}" rx="6"
            fill="${fillColor}" stroke="${strokeColor}" stroke-width="${isBlocked ? 2 : 1}"/>
      <text class="node-label" x="8" y="11"
            dominant-baseline="central"
            fill="${colors.textPrimary}">
        publish-gate
      </text>
      ${
        duration
          ? svg`
        <text class="node-elapsed" x="${n.w - 8}" y="11"
              text-anchor="end" dominant-baseline="central"
              fill="${colors.textMuted}">
          ${duration}
        </text>
      `
          : nothing
      }
      ${
        isDone && resolvedAction
          ? svg`
        <text class="node-meta" x="${n.w / 2}" y="27"
              text-anchor="middle" dominant-baseline="central"
              fill="${actionColor}">
          ${resolvedAction === 'ready' || resolvedAction === 'approve-publish' ? 'v APPROVED' : resolvedAction === 'hold' ? '! HOLD' : `v ${resolvedAction}`}
        </text>
      `
          : svg`
        ${
          !isPending
            ? svg`
          <text class="node-meta" x="${n.w / 2}" y="27"
                text-anchor="middle" dominant-baseline="central"
                fill="${isBlocked ? colors.statusWarn : stepStatusColor(vis)}">
            ${isBlocked ? '! waiting' : isRunning ? (step.detail ?? '*') : isFailed ? 'x' : ''}
          </text>
        `
            : nothing
        }
      `
      }
    </g>
  `;
}

export function renderFinalizePipelineNode(n: NodePos, ctx: RunPipelineSpecialNodeRenderContext) {
  const step = n.step;
  const vis = ctx.visibleStatus(step);
  const isRunning = vis === 'running';
  const isDone = vis === 'done';
  const isFailed = vis === 'failed';
  const isPending = vis === 'pending';
  const transfer = transferForPipelineNode(ctx.transferProgress, 'finalize');
  const transferActive = transfer?.state === 'running';
  // Package-change / re-review publish failures are reworkable (orange), not terminal red.
  const tone = pipelineStepTone(
    { ...step, detail: step.detail ?? ctx.run.error ?? undefined },
    { runError: ctx.run.error },
  );
  const toneColors = pipelineToneFillStroke(tone);
  const fillColor =
    transferActive || isDone || isFailed || isRunning ? toneColors.fill : 'transparent';
  const strokeColor = transferActive
    ? '#3b82f6'
    : isDone || isFailed || isRunning
      ? toneColors.stroke
      : `${colors.textMuted}33`;

  const elapsed = step.durationMs
    ? formatDuration(step.durationMs)
    : step.startedAt
      ? formatElapsed(step.startedAt)
      : '';

  const outputs = step.outputs ?? {};
  const outputCost = typeof outputs.costEstimate === 'number' ? outputs.costEstimate : undefined;
  const outputModel = typeof outputs.model === 'string' ? outputs.model : undefined;

  // Build detail pills for done state
  const pills: { label: string; color: string }[] = [];
  if (isDone && outputs) {
    if (outputs.publicationStatus)
      pills.push({
        label: String(outputs.publicationStatus).replace('published_', ''),
        color: colors.statusOk,
      });
    if (outputs.commentPosted) pills.push({ label: 'comment', color: colors.statusOk });
    if (outputs.metricsSavedToTask) pills.push({ label: 'metrics', color: colors.statusOk });
    const cost = outputCost ?? ctx.run.metrics.costEstimate;
    if (cost) pills.push({ label: `$${Number(cost).toFixed(2)}`, color: colors.accent });
    const model = outputModel ?? ctx.run.metrics.model;
    if (model) pills.push({ label: model, color: colors.textMuted });
  }

  const runningMeta = transferActive ? formatPipelineTransferMeta(transfer!) : (step.detail ?? '*');
  const pct = transfer ? fileTransferPercent(transfer) : 0;
  const barW = Math.max(0, Math.min(n.w - 16, ((n.w - 16) * pct) / 100));

  return svg`
    <g class="${isRunning || transferActive ? 'node-running-anim' : ''}"
       transform="translate(${n.x}, ${n.y})"
       style="opacity: ${isPending && !transferActive ? 0.4 : 1}; cursor: pointer"
       data-testid="pipeline-finalize-node"
       data-transfer-active=${transferActive ? 'true' : 'false'}
       @click=${() => ctx.onStepSelect(n.step)}>
      <rect width="${n.w}" height="${NODE_H}" rx="6"
            fill="${fillColor}" stroke="${strokeColor}"/>
      <text class="node-label" x="8" y="11"
            dominant-baseline="central"
            fill="${colors.textPrimary}">
        publish
      </text>
      ${
        elapsed && !transferActive
          ? svg`
        <text class="node-elapsed" x="${n.w - 8}" y="11"
              text-anchor="end" dominant-baseline="central"
              fill="${colors.textMuted}">
          ${elapsed}
        </text>
      `
          : nothing
      }
      ${
        isDone && pills.length > 0 && !transferActive
          ? svg`
        ${pills.map(
          (p, i) => svg`
          <text class="complete-pill" x="${8 + i * 26}" y="27"
                dominant-baseline="central"
                fill="${p.color}">
            ${p.label}
          </text>
        `,
        )}
      `
          : svg`
        ${
          !isPending || transferActive
            ? svg`
          <text class="node-meta" x="${n.w / 2}" y="27"
                text-anchor="middle" dominant-baseline="central"
                fill="${transferActive ? colors.accent : pipelineToneColor(tone)}">
            ${
              isDone && !transferActive
                ? 'v'
                : isRunning || transferActive
                  ? runningMeta
                  : tone === 'warn'
                    ? '! rework'
                    : isFailed
                      ? 'x'
                      : ''
            }
          </text>
        `
            : nothing
        }
      `
      }
      ${
        transferActive
          ? svg`
        <rect x="8" y="${NODE_H - 6}" width="${n.w - 16}" height="3" rx="1.5"
              fill="#1a1a2e"/>
        <rect x="8" y="${NODE_H - 6}" width="${barW}" height="3" rx="1.5"
              fill="${colors.accent}"
              data-testid="pipeline-finalize-transfer-bar"/>
      `
          : nothing
      }
    </g>
  `;
}

export function renderCompletePipelineNode(n: NodePos, ctx: RunPipelineSpecialNodeRenderContext) {
  const step = n.step;
  const vis = ctx.visibleStatus(step);
  const isRunning = vis === 'running';
  const isDone = vis === 'done';
  const isFailed = vis === 'failed';
  const isPending = vis === 'pending';
  const isBlocked =
    isRunning && ctx.run.status === 'blocked' && ctx.run.decisions.some((d) => !d.resolvedAt);

  const fillColor = isBlocked
    ? `${colors.statusWarn}18`
    : isDone
      ? `${colors.statusOk}12`
      : isRunning
        ? '#3b82f618'
        : isFailed
          ? `${colors.statusFail}12`
          : 'transparent';
  const strokeColor = isBlocked
    ? colors.statusWarn
    : isDone
      ? `${colors.statusOk}66`
      : isRunning
        ? '#3b82f6'
        : isFailed
          ? colors.statusFail
          : `${colors.textMuted}33`;

  const elapsed = step.durationMs
    ? formatDuration(step.durationMs)
    : step.startedAt
      ? formatElapsed(step.startedAt)
      : '';

  // Sub-action pills for done state
  const outputs = step.outputs ?? {};
  const pills: { label: string; done: boolean }[] = [];
  if (isDone && outputs) {
    if (outputs.packageHash) pills.push({ label: 'Pkg', done: true });
    if (outputs.reviewSatisfied !== undefined)
      pills.push({ label: 'Review', done: !!outputs.reviewSatisfied });
    if (outputs.prCommentPosted !== undefined && !outputs.packageHash)
      pills.push({ label: 'PR', done: !!outputs.prCommentPosted });
    if (outputs.prTitleUpdated !== undefined)
      pills.push({ label: 'Title', done: !!outputs.prTitleUpdated });
    if (outputs.prMarkedReady !== undefined)
      pills.push({ label: 'Ready', done: !!outputs.prMarkedReady });
  }

  // Cost and duration from run metrics
  const metrics = ctx.run.metrics;
  const costText = metrics?.costEstimate ? `$${metrics.costEstimate.toFixed(2)}` : '';
  const totalDuration = metrics?.durationMs ? formatDuration(metrics.durationMs) : '';

  return svg`
    <g class="${isBlocked ? 'node-blocked-anim' : isRunning ? 'node-running-anim' : ''}"
       transform="translate(${n.x}, ${n.y})"
       style="opacity: ${isPending ? 0.4 : 1}; cursor: pointer"
       @click=${() => ctx.onStepSelect(n.step)}>
      <rect width="${n.w}" height="${NODE_H}" rx="6"
            fill="${fillColor}" stroke="${strokeColor}" stroke-width="${isBlocked ? 2 : 1}"/>
      <text class="node-label" x="8" y="11"
            dominant-baseline="central"
            fill="${colors.textPrimary}">
        package
      </text>
      ${
        elapsed
          ? svg`
        <text class="node-elapsed" x="${n.w - 8}" y="11"
              text-anchor="end" dominant-baseline="central"
              fill="${colors.textMuted}">
          ${elapsed}
        </text>
      `
          : nothing
      }
      ${
        isDone && pills.length > 0
          ? svg`
        ${pills.map(
          (p, i) => svg`
          <text class="complete-pill" x="${8 + i * 28}" y="27"
                dominant-baseline="central"
                fill="${p.done ? colors.statusOk : colors.textMuted}">
            ${p.label} ${p.done ? 'v' : '-'}
          </text>
        `,
        )}
      `
          : isDone && (costText || totalDuration)
            ? svg`
        <text class="cost-badge" x="${n.w / 2}" y="27"
              text-anchor="middle" dominant-baseline="central"
              fill="${colors.textMuted}">
          ${costText}${costText && totalDuration ? ' | ' : ''}${totalDuration}
        </text>
      `
            : svg`
        ${
          !isPending
            ? svg`
          <text class="node-meta" x="${n.w / 2}" y="27"
                text-anchor="middle" dominant-baseline="central"
                fill="${stepStatusColor(vis)}">
            ${isDone ? 'v' : isRunning ? (step.detail ?? '*') : isFailed ? 'x' : ''}
          </text>
        `
            : nothing
        }
      `
      }
    </g>
  `;
}
