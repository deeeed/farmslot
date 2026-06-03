import { nothing, svg } from 'lit';

import type { Run, RunDecision, RunStep, RunStepStatus } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

import {
  type ArrowDef,
  DECISION_STEP_MAP,
  LABEL_W,
  type Lane,
  LANE_ORDER,
  LANE_Y,
  NODE_H,
  type NodePos,
  type PipelineLayout,
} from './run-pipeline-model.js';
import { formatDuration, formatElapsed, stepStatusColor } from './run-utils.js';

export function renderPipelineDefs() {
  return svg`
    <defs>
      <marker id="ah-done" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
        <polygon points="0 0, 8 3, 0 6" fill="${colors.statusOk}88"/>
      </marker>
      <marker id="ah-running" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
        <polygon points="0 0, 8 3, 0 6" fill="#3b82f6"/>
      </marker>
      <marker id="ah-pending" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
        <polygon points="0 0, 8 3, 0 6" fill="${colors.textMuted}44"/>
      </marker>
      <marker id="ah-failed" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
        <polygon points="0 0, 8 3, 0 6" fill="${colors.statusFail}"/>
      </marker>
    </defs>
  `;
}

export function renderPipelineLanes(layout: PipelineLayout) {
  const laneLabels: Record<Lane, string> = { orch: 'ORCH', worker: 'WORKER', post: 'POST' };
  const usedLanes = LANE_ORDER.filter((lane) => layout.lanesUsed.has(lane));

  return svg`
    ${usedLanes.map(
      (lane) => svg`
      <text x="8" y="${LANE_Y[lane] + NODE_H / 2}"
            dominant-baseline="central"
            fill="${colors.textMuted}" class="lane-label">
        ${laneLabels[lane]}
      </text>
    `,
    )}
    ${usedLanes.slice(0, -1).map((lane, i) => {
      const nextLane = usedLanes[i + 1];
      const sepY = (LANE_Y[lane] + NODE_H + LANE_Y[nextLane]) / 2;
      return svg`
        <line x1="${LABEL_W}" x2="${layout.width}"
              y1="${sepY}" y2="${sepY}"
              stroke="${colors.bgCard}" class="lane-sep"/>
      `;
    })}
  `;
}

export function renderPipelineArrow(arrow: ArrowDef, visibleStatus: RunStepStatus) {
  const markerMap: Record<string, string> = {
    done: 'ah-done',
    running: 'ah-running',
    failed: 'ah-failed',
    pending: 'ah-pending',
  };
  const colorMap: Record<string, string> = {
    done: `${colors.statusOk}66`,
    running: '#3b82f6',
    failed: colors.statusFail,
    skipped: `${colors.textMuted}55`,
    pending: `${colors.textMuted}33`,
  };
  const marker = markerMap[visibleStatus] ?? 'ah-pending';
  const color = colorMap[visibleStatus] ?? `${colors.textMuted}33`;

  return svg`
    <path d="${arrow.d}" class="arrow"
          stroke="${color}"
          marker-end="url(#${marker})"/>
  `;
}

export interface DefaultPipelineNodeContext {
  run: Run;
  visibleStatus: RunStepStatus;
  onStepSelect: (step: RunStep) => void;
}

export function renderDefaultPipelineNode(node: NodePos, context: DefaultPipelineNodeContext) {
  const vis = context.visibleStatus;
  const sc = stepStatusColor(vis);
  const isRunning = vis === 'running';
  const isDone = vis === 'done';
  const isPending = vis === 'pending';
  const isFailed = vis === 'failed';
  const isSkipped = vis === 'skipped';
  // Check if this step is blocked waiting for human input
  const isBlocked =
    isRunning &&
    context.run.status === 'blocked' &&
    context.run.decisions.some((d) => !d.resolvedAt);

  const fillColor = isBlocked
    ? `${colors.statusWarn}18`
    : isDone
      ? `${colors.statusOk}12`
      : isRunning
        ? '#3b82f618'
        : isFailed
          ? `${colors.statusFail}12`
          : isSkipped
            ? `${colors.textMuted}12`
            : 'transparent';
  const strokeColor = isBlocked
    ? colors.statusWarn
    : isDone
      ? `${colors.statusOk}66`
      : isRunning
        ? '#3b82f6'
        : isFailed
          ? colors.statusFail
          : isSkipped
            ? `${colors.textMuted}66`
            : `${colors.textMuted}33`;

  const duration = node.step.durationMs
    ? formatDuration(node.step.durationMs)
    : node.step.startedAt
      ? formatElapsed(node.step.startedAt)
      : '';
  const statusIcon = isDone ? 'v' : isRunning ? '*' : isFailed ? 'x' : isSkipped ? '-' : '';
  const skippedReason = isSkipped
    ? (node.step.outputs as Record<string, unknown> | undefined)?.reason === 'disabled' &&
      context.run.mode === 'autonomous'
      ? 'skipped: autonomous mode'
      : (node.step.outputs as Record<string, unknown> | undefined)?.reason
        ? `skipped: ${(node.step.outputs as Record<string, unknown>)?.reason}`
        : 'skipped'
    : '';
  // Show step detail (e.g. "Review: 7/11 steps") when running, fall back to duration
  const metaText =
    isRunning && node.step.detail
      ? `${statusIcon} ${node.step.detail}`
      : isSkipped
        ? skippedReason
        : statusIcon
          ? `${statusIcon} ${duration}`
          : '';

  return svg`
    <g class="${isBlocked ? 'node-blocked-anim' : isRunning ? 'node-running-anim' : ''}"
       transform="translate(${node.x}, ${node.y})"
       style="opacity: ${isPending ? 0.4 : isSkipped ? 0.72 : 1}; cursor: pointer"
       @click=${() => context.onStepSelect(node.step)}>
      <clipPath id="clip-${node.id}">
        <rect width="${node.w}" height="${NODE_H}" rx="6"/>
      </clipPath>
      <rect width="${node.w}" height="${NODE_H}" rx="6"
            fill="${fillColor}" stroke="${strokeColor}" stroke-width="${isBlocked ? 2 : 1}"/>
      <g clip-path="url(#clip-${node.id})">
        <text class="node-label" x="${node.w / 2}" y="13"
              text-anchor="middle" dominant-baseline="central"
              fill="${colors.textPrimary}">
          ${node.id}
        </text>
        ${
          metaText
            ? svg`
          <text class="node-meta" x="${node.w / 2}" y="27"
                text-anchor="middle" dominant-baseline="central"
                fill="${sc}">
            ${metaText}
          </text>
        `
            : nothing
        }
      </g>
      ${
        node.step.detail
          ? svg`
        <title>${node.step.detail}</title>
      `
          : nothing
      }
    </g>
  `;
}

export function renderSelfReviewLoop(
  nodeMap: Map<string, NodePos>,
  visibleStatus: (step: RunStep) => RunStepStatus,
) {
  const srNode = nodeMap.get('self-review');
  const monNode = nodeMap.get('monitor');
  if (!srNode || !monNode) return nothing;

  const step = srNode.step;
  const outputs = (step.outputs ?? {}) as Record<string, unknown>;
  const hasRetry = Number(outputs.retryCount ?? 0) > 0 || (step.detail ?? '').startsWith('Fix:');
  const vis = visibleStatus(step);
  const isRunning = vis === 'running';
  const isDone = vis === 'done';
  const isPending = vis === 'pending';

  // Show loop when: retry happened, or currently in fix phase, or step is running (loop is possible)
  if (isPending) return nothing;

  // Arc from self-review right side, curves up and back to monitor right side
  const srRight = srNode.x + srNode.w - 10;
  const monRight = monNode.x + monNode.w;
  const arcTop = srNode.y - 24;
  const arcMidX = (monRight + srRight) / 2;

  const loopColor = hasRetry ? (isDone ? colors.statusOk : '#3b82f6') : `${colors.textMuted}33`;
  const dashArray = hasRetry ? 'none' : '4 3';
  const opacity = hasRetry ? 1 : 0.5;

  const retryCount = Number(outputs.retryCount ?? 0);
  const phase = (step.detail ?? '').startsWith('Fix:') ? 'fixing' : 'reviewing';

  return svg`
    <g style="opacity: ${opacity}">
      <path d="M ${srRight} ${srNode.y}
               C ${srRight} ${arcTop}, ${monRight} ${arcTop}, ${monRight} ${srNode.y}"
            fill="none" stroke="${loopColor}" stroke-width="1.5"
            stroke-dasharray="${dashArray}"
            marker-end="url(#ah-${hasRetry ? (isDone ? 'done' : 'running') : 'pending'})"/>
      ${
        hasRetry
          ? svg`
        <text x="${arcMidX}" y="${arcTop - 3}"
              text-anchor="middle" dominant-baseline="auto"
              fill="${loopColor}" font-size="8" font-weight="600" class="loop-label">
          ${isRunning ? phase : `retry x${retryCount}`}
        </text>
      `
          : svg`
        <text x="${arcMidX}" y="${arcTop - 3}"
              text-anchor="middle" dominant-baseline="auto"
              fill="${colors.textMuted}" font-size="7" style="opacity: 0.5" class="loop-label">
          retry if issues
        </text>
      `
      }
    </g>
  `;
}

export function renderPublicationReviewLoops(
  nodes: NodePos[],
  visibleStatus: (step: RunStep) => RunStepStatus,
) {
  const reviewNodes = nodes.filter(
    (node) => node.id.includes('publication-review-') && publicationReviewLoopCount(node.step) > 0,
  );
  if (reviewNodes.length === 0) return nothing;
  return svg`${reviewNodes.map((node) => renderPublicationReviewLoop(node, visibleStatus))}`;
}

export function publicationReviewLoopCount(step: RunStep): number {
  const outputs = (step.outputs ?? {}) as Record<string, unknown>;
  const attempts = Array.isArray(outputs.attempts)
    ? (outputs.attempts as Record<string, unknown>[])
    : [];
  const issueAttempts = attempts.filter(
    (attempt) => attempt.verdict === 'issues' || Number(attempt.unresolvedCount ?? 0) > 0,
  ).length;
  if (issueAttempts > 0) return issueAttempts;
  return outputs.feedbackSent === true ? 1 : 0;
}

function renderPublicationReviewLoop(
  node: NodePos,
  visibleStatus: (step: RunStep) => RunStepStatus,
) {
  const loopCount = publicationReviewLoopCount(node.step);
  if (loopCount <= 0) return nothing;
  const vis = visibleStatus(node.step);
  const isDone = vis === 'done';
  const isRunning = vis === 'running';
  const accent = isDone ? colors.statusOk : isRunning ? '#3b82f6' : '#a78bfa';
  const left = node.x + 14;
  const right = node.x + node.w - 14;
  const top = node.y - 22;
  const mid = node.x + node.w / 2;
  const fixDuration = publicationReviewFixDurationLabel(node.step);
  const label = isRunning
    ? 'fix loop'
    : fixDuration
      ? `fixed ${fixDuration}`
      : loopCount > 1
        ? `fixed x${loopCount}`
        : 'fixed';
  return svg`
    <g class="publication-review-loop" style="opacity: ${isDone ? 0.95 : 0.75}">
      <path d="M ${right} ${node.y + 2}
               C ${right} ${top}, ${left} ${top}, ${left} ${node.y + 2}"
            fill="none"
            stroke="${accent}"
            stroke-width="1.5"
            stroke-dasharray="4 3"
            marker-end="url(#ah-${isDone ? 'done' : isRunning ? 'running' : 'pending'})"/>
      <text x="${mid}" y="${top - 3}"
            text-anchor="middle" dominant-baseline="auto"
            fill="${accent}" font-size="8" font-weight="700" class="loop-label">
        ${label}
      </text>
    </g>
  `;
}

export function publicationReviewFixDurationLabel(step: RunStep): string {
  const outputs = (step.outputs ?? {}) as Record<string, unknown>;
  const timeline = Array.isArray(outputs.timeline)
    ? (outputs.timeline as Record<string, unknown>[])
    : [];
  const fixMs = timeline
    .filter((segment) => segment.kind === 'worker-fix' && typeof segment.durationMs === 'number')
    .reduce((total, segment) => total + Number(segment.durationMs), 0);
  return fixMs > 0 ? formatDuration(fixMs) : '';
}

export function renderPipelineDecisions(run: Run, nodeMap: Map<string, NodePos>) {
  if (!run.decisions.length) return nothing;

  // Group decisions by associated step
  const byStep = new Map<string, RunDecision[]>();
  for (const decision of run.decisions) {
    const stepName = DECISION_STEP_MAP[decision.type] ?? 'complete';
    const arr = byStep.get(stepName) ?? [];
    arr.push(decision);
    byStep.set(stepName, arr);
  }

  const fragments: ReturnType<typeof svg>[] = [];
  for (const [stepName, decisions] of byStep) {
    const node = nodeMap.get(stepName);
    if (!node) continue;
    const count = decisions.length;
    for (let i = 0; i < count; i++) {
      const offset = (i - (count - 1) / 2) * 50;
      fragments.push(renderPipelineDecisionDiamond(run, decisions[i], node, offset));
    }
  }
  return svg`${fragments}`;
}

function renderPipelineDecisionDiamond(
  run: Run,
  decision: RunDecision,
  node: NodePos,
  offsetX: number,
) {
  const cx = node.x + node.w / 2 + offsetX;
  const cy = node.y + NODE_H + 16;
  const isPending = !decision.resolvedAt;

  const fill = isPending ? `${colors.statusWarn}25` : `${colors.textMuted}15`;
  const stroke = isPending ? colors.statusWarn : `${colors.textMuted}44`;
  const iconColor = isPending ? colors.statusWarn : colors.textMuted;
  const icon = isPending ? '!' : 'v';

  // Pending decisions with payload → navigate to slot view for full review
  // Pending decisions without payload → navigate to run detail
  const hasPayload = !!decision.payload;
  const navTarget =
    isPending && hasPayload && run.slotId
      ? `#slot/${run.slotId}?runId=${encodeURIComponent(run.id)}`
      : isPending
        ? `#run/${run.id}`
        : null;

  return svg`
    <g transform="translate(${cx}, ${cy})"
       class="${isPending ? 'decision-pending' : ''}"
       style="cursor: ${navTarget ? 'pointer' : 'default'}"
       @click=${
         navTarget
           ? (event: Event) => {
               event.stopPropagation();
               location.hash = navTarget;
             }
           : null
       }>
      <polygon points="0,-11 14,0 0,11 -14,0"
               fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
      <text y="0" text-anchor="middle" dominant-baseline="central"
            fill="${iconColor}" font-size="8" font-weight="700">
        ${icon}
      </text>
      ${
        isPending
          ? svg`
        <text y="17" text-anchor="middle" dominant-baseline="central"
              fill="${colors.statusWarn}" font-size="7" style="cursor:pointer">
          ${navTarget ? 'Review' : 'pending'}
        </text>
      `
          : svg`
        <text y="17" text-anchor="middle" dominant-baseline="central"
              fill="${colors.textMuted}" font-size="7">
          ${decision.resolvedAction ?? 'resolved'}
        </text>
      `
      }
    </g>
  `;
}
