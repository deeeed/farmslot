import type { FlowType, Run, RunStep, TaskProgressStructured } from '@farmslot/protocol';

type UnknownRecord = Record<string, unknown>;
type PublishGate = NonNullable<NonNullable<Run['engineState']>['publishGate']>;
type PublicationReviewStatus = NonNullable<PublishGate['independentReviews']>[number];

function recordValue(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function ciWatchOutputsForRun(run: Run | undefined): Record<string, unknown> {
  const step = run?.steps.find((candidate) => candidate.name === 'ci-watch');
  return step?.outputs ?? {};
}

export function isInlineCiFixActiveFromOutputs(out: Record<string, unknown>): boolean {
  return (
    out.fixInProgress === true && (out.phase === 'fixing' || out.phase === 'waiting_for_worker')
  );
}

export function effectiveTaskProgressForRun(
  run: Run | undefined,
  taskProgress: TaskProgressStructured | undefined,
): TaskProgressStructured | undefined {
  if (taskProgress) return taskProgress;
  const progress = recordValue(ciWatchOutputsForRun(run).fixProgress);
  const total = numberValue(progress?.total);
  if (!total) return undefined;
  const completed = numberValue(progress?.completed) ?? 0;
  const currentLabel = typeof progress?.currentLabel === 'string' ? progress.currentLabel : null;
  const steps = Array.from({ length: total }, (_, index) => {
    const oneBased = index + 1;
    return {
      index: oneBased,
      name: oneBased === completed + 1 && currentLabel ? currentLabel : `Step ${oneBased}`,
      status:
        oneBased <= completed
          ? ('done' as const)
          : oneBased === completed + 1
            ? ('running' as const)
            : ('pending' as const),
    };
  });
  return {
    schema: {
      flowType: 'ci-watch',
      title: 'CI fix',
      totalSteps: total,
      phases: [{ name: 'CI fix', steps: steps.map(({ index, name }) => ({ index, name })) }],
    },
    phases: [{ name: 'CI fix', steps, completedSteps: completed, totalSteps: total }],
    completedSteps: completed,
    totalSteps: total,
    currentPhase: 'CI fix',
    currentStep: currentLabel,
  };
}

export function effectiveTaskProgress(
  run: Run | undefined,
  taskProgress: TaskProgressStructured | undefined,
): TaskProgressStructured | undefined {
  return effectiveTaskProgressForRun(run, taskProgress);
}

export function activeTaskProgressStepId(
  run: Run | undefined,
  taskProgress: TaskProgressStructured | undefined,
): 'monitor' | 'self-review' | 'ci-watch' | null {
  const progress = effectiveTaskProgressForRun(run, taskProgress);
  if (!progress?.totalSteps) return null;
  if (isSelfReviewProgressActive(run)) return 'self-review';
  const monitorStep = run?.steps.find((step) => step.name === 'monitor');
  if (isInlineCiFixActiveFromOutputs(ciWatchOutputsForRun(run))) return 'ci-watch';
  if (monitorStep?.status === 'running') return 'monitor';
  return null;
}

function isSelfReviewProgressActive(run: Run | undefined): boolean {
  const selfReviewStep = run?.steps.find((step) => step.name === 'self-review');
  if (!selfReviewStep) return false;
  return (
    selfReviewStep.status === 'running' ||
    run?.status === 'self-reviewing' ||
    run?.activeTaskFile?.split('/').pop() === 'SELF-REVIEW.md'
  );
}

// --- Layout constants ---
const NODE_W = 100;
export const NODE_H = 36;
const MONITOR_W = 130;
const COL_GAP = 140;
const LANE_GAP = 80;
export const LABEL_W = 45;
const PAD_X = 12;
const PAD_Y = 6;

export type Lane = 'orch' | 'worker' | 'post';

const LOOP_HEADROOM = 30; // extra space above worker lane for self-review loop arrow
export const LANE_Y: Record<Lane, number> = {
  orch: PAD_Y + 30,
  worker: PAD_Y + 30 + LANE_GAP + LOOP_HEADROOM,
  post: PAD_Y + 30 + 2 * LANE_GAP + LOOP_HEADROOM,
};

export const LANE_ORDER: Lane[] = ['orch', 'worker', 'post'];

function colX(col: number): number {
  return LABEL_W + PAD_X + col * COL_GAP;
}

// --- Step positioning per flow type ---

interface StepPos {
  col: number;
  lane: Lane;
  width?: number;
}

const LAYOUTS: Record<FlowType, Record<string, StepPos>> = {
  'fix-bug': {
    'find-slot': { col: 0, lane: 'orch' },
    grade: { col: 1, lane: 'orch' },
    'write-task': { col: 2, lane: 'orch' },
    prepare: { col: 3, lane: 'orch' },
    dispatch: { col: 2, lane: 'worker' },
    monitor: { col: 3, lane: 'worker', width: MONITOR_W },
    'self-review': { col: 4, lane: 'worker', width: MONITOR_W },
    complete: { col: 2, lane: 'post', width: MONITOR_W },
    'human-gate': { col: 3, lane: 'post', width: MONITOR_W },
    finalize: { col: 4, lane: 'post', width: MONITOR_W },
    'ci-watch': { col: 5, lane: 'post' },
    'ci-pass': { col: 6, lane: 'post' },
    done: { col: 7, lane: 'post' },
  },
  dev: {
    'find-slot': { col: 0, lane: 'orch' },
    'write-task': { col: 1, lane: 'orch' },
    prepare: { col: 2, lane: 'orch' },
    dispatch: { col: 1, lane: 'worker' },
    monitor: { col: 2, lane: 'worker', width: MONITOR_W },
    'self-review': { col: 3, lane: 'worker', width: MONITOR_W },
    complete: { col: 1, lane: 'post', width: MONITOR_W },
    'human-gate': { col: 2, lane: 'post', width: MONITOR_W },
    finalize: { col: 3, lane: 'post', width: MONITOR_W },
    'ci-watch': { col: 4, lane: 'post' },
    'ci-pass': { col: 5, lane: 'post' },
    done: { col: 6, lane: 'post' },
  },
  'review-pr': {
    'find-slot': { col: 0, lane: 'orch' },
    'write-task': { col: 1, lane: 'orch' },
    prepare: { col: 2, lane: 'orch' },
    dispatch: { col: 1, lane: 'worker' },
    monitor: { col: 2, lane: 'worker', width: MONITOR_W },
    'human-gate': { col: 1, lane: 'post', width: MONITOR_W },
    complete: { col: 2, lane: 'post', width: MONITOR_W },
  },
  'pr-complete': {
    'find-slot': { col: 0, lane: 'orch' },
    'write-task': { col: 1, lane: 'orch' },
    prepare: { col: 2, lane: 'orch' },
    dispatch: { col: 1, lane: 'worker' },
    monitor: { col: 2, lane: 'worker', width: MONITOR_W },
    complete: { col: 1, lane: 'post', width: MONITOR_W },
    finalize: { col: 2, lane: 'post', width: MONITOR_W },
    'ci-watch': { col: 3, lane: 'post' },
    'ci-pass': { col: 4, lane: 'post' },
    done: { col: 5, lane: 'post' },
  },
  'merge-main': {
    'write-task': { col: 0, lane: 'orch' },
    dispatch: { col: 0, lane: 'worker' },
    monitor: { col: 1, lane: 'worker', width: MONITOR_W },
    'self-review': { col: 2, lane: 'worker', width: MONITOR_W },
    complete: { col: 0, lane: 'post', width: MONITOR_W },
    finalize: { col: 1, lane: 'post', width: MONITOR_W },
    'ci-watch': { col: 2, lane: 'post' },
    'ci-pass': { col: 3, lane: 'post' },
    done: { col: 4, lane: 'post' },
  },
};

// Decision type -> associated step
export const DECISION_STEP_MAP: Record<string, string> = {
  collision_check: 'find-slot',
  engine_collision: 'find-slot',
  plan_confirmation: 'prepare',
  blocked_alert: 'monitor',
  engine_review_posting: 'human-gate',
  engine_human_gate: 'human-gate',
  review_comments: 'complete',
  retrospective: 'complete',
};

// --- Computed layout types ---

export interface NodePos {
  id: string;
  x: number;
  y: number;
  w: number;
  lane: Lane;
  step: RunStep;
  synthetic?: boolean;
  label?: string;
  meta?: string;
}

export interface ArrowDef {
  d: string;
  status: string;
}

export interface PipelineLayout {
  nodes: NodePos[];
  arrows: ArrowDef[];
  width: number;
  height: number;
  lanesUsed: Set<Lane>;
}

export function computeLayout(run: Run): PipelineLayout {
  const { flowType, steps } = run;
  const positions = LAYOUTS[flowType] ?? LAYOUTS['fix-bug'];
  const preGateReviewPlan = publicationReviewPlanNodes(run, 'pre-gate');
  const postGateReviewPlan = publicationReviewPlanNodes(run, 'post-gate');
  const waitingForPreGateReviews = preGateReviewPlan.some(
    (node) => node.step.status === 'running' || node.step.status === 'pending',
  );
  const selfReviewPos = positions['self-review'];
  const completePos = positions.complete;
  const humanGatePos = positions['human-gate'];
  const preGateShift =
    preGateReviewPlan.length > 0 && selfReviewPos && completePos
      ? Math.max(0, selfReviewPos.col + preGateReviewPlan.length + 1 - completePos.col)
      : 0;
  const humanGateAdjustedCol = humanGatePos
    ? adjustedStepPos('human-gate', humanGatePos, preGateShift, 0)?.col
    : undefined;
  const workerBaseMaxCol = Math.max(
    ...Object.values(positions)
      .filter((pos) => pos.lane === 'worker')
      .map((pos) => pos.col),
    selfReviewPos && preGateReviewPlan.length > 0
      ? selfReviewPos.col + preGateReviewPlan.length
      : -1,
  );
  const postGateReviewStartCol =
    postGateReviewPlan.length > 0 && humanGateAdjustedCol !== undefined
      ? Math.max(humanGateAdjustedCol + 1, workerBaseMaxCol + 1)
      : undefined;
  const postGateRefreshCol =
    postGateReviewStartCol !== undefined
      ? postGateReviewStartCol + postGateReviewPlan.length
      : undefined;
  const postGateResumeCol = postGateRefreshCol !== undefined ? postGateRefreshCol + 1 : undefined;
  const finalizeBaseCol = positions.finalize
    ? adjustedStepPos('finalize', positions.finalize, preGateShift, 0)?.col
    : undefined;
  const postGateShift =
    postGateResumeCol !== undefined && finalizeBaseCol !== undefined
      ? Math.max(0, postGateResumeCol - finalizeBaseCol)
      : 0;
  const nodes: NodePos[] = [];
  const lanesUsed = new Set<Lane>();
  let maxCol = 0;

  for (const step of steps) {
    const pos = adjustedStepPos(step.name, positions[step.name], preGateShift, postGateShift);
    if (!pos) continue;
    const w = pos.width ?? NODE_W;
    const displayStep = pipelineDisplayStep(step, waitingForPreGateReviews);
    nodes.push({
      id: step.name,
      x: colX(pos.col),
      y: LANE_Y[pos.lane],
      w,
      lane: pos.lane,
      step: displayStep,
    });
    lanesUsed.add(pos.lane);
    if (pos.col > maxCol) maxCol = pos.col;
    if (step.name === 'self-review' && preGateReviewPlan.length > 0 && selfReviewPos) {
      for (const planNode of preGateReviewPlan) {
        const planPos = {
          col: selfReviewPos.col + planNode.order,
          lane: 'worker' as const,
          width: MONITOR_W,
        };
        nodes.push({
          id: planNode.id,
          x: colX(planPos.col),
          y: LANE_Y[planPos.lane],
          w: planPos.width,
          lane: planPos.lane,
          step: planNode.step,
          synthetic: true,
          label: planNode.label,
          meta: planNode.meta,
        });
        lanesUsed.add(planPos.lane);
        if (planPos.col > maxCol) maxCol = planPos.col;
      }
    }
    if (step.name === 'human-gate' && postGateReviewPlan.length > 0 && humanGatePos) {
      for (const planNode of postGateReviewPlan) {
        const planPos = {
          col: (postGateReviewStartCol ?? pos.col + 1) + planNode.order - 1,
          lane: 'worker' as const,
          width: MONITOR_W,
        };
        nodes.push({
          id: planNode.id,
          x: colX(planPos.col),
          y: LANE_Y[planPos.lane],
          w: planPos.width,
          lane: planPos.lane,
          step: planNode.step,
          synthetic: true,
          label: planNode.label,
          meta: planNode.meta,
        });
        lanesUsed.add(planPos.lane);
        if (planPos.col > maxCol) maxCol = planPos.col;
      }
      const refreshCol = postGateRefreshCol ?? pos.col + postGateReviewPlan.length + 1;
      const refreshStatus = postGateRefreshStatus(postGateReviewPlan);
      nodes.push({
        id: 'package-refresh',
        x: colX(refreshCol),
        y: LANE_Y.post,
        w: MONITOR_W,
        lane: 'post',
        step: syntheticStep('package-refresh', refreshStatus, 'package refresh'),
        synthetic: true,
        label: 'package',
        meta: 'refresh after review',
      });
      lanesUsed.add('post');
      if (refreshCol > maxCol) maxCol = refreshCol;
    }
  }

  const ciStep = steps.find((step) => step.name === 'ci-watch');
  if (ciStep && positions['ci-pass'] && positions.done) {
    const ciPassStatus = ciSyntheticStatus(run, ciStep);
    for (const step of [
      syntheticStep('ci-pass', ciPassStatus, ciPassStatus === 'done' ? 'pass' : 'waiting'),
      syntheticStep(
        'done',
        run.status === 'done' ? 'done' : ciPassStatus === 'failed' ? 'failed' : 'pending',
      ),
    ]) {
      const pos = adjustedStepPos(step.name, positions[step.name], preGateShift, postGateShift);
      if (!pos) continue;
      const w = pos.width ?? NODE_W;
      nodes.push({
        id: step.name,
        x: colX(pos.col),
        y: LANE_Y[pos.lane],
        w,
        lane: pos.lane,
        step,
        synthetic: true,
      });
      lanesUsed.add(pos.lane);
      if (pos.col > maxCol) maxCol = pos.col;
    }
  }

  // Arrows between consecutive rendered nodes
  const arrows: ArrowDef[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    arrows.push({ d: arrowPath(nodes[i], nodes[i + 1]), status: nodes[i].step.status });
  }

  const lastW = nodes.length > 0 ? nodes[nodes.length - 1].w : NODE_W;
  const width = colX(maxCol) + lastW + 30;
  const maxLaneIdx = Math.max(...[...lanesUsed].map((l) => LANE_ORDER.indexOf(l)));
  const maxLane = LANE_ORDER[maxLaneIdx] ?? 'orch';
  const height = LANE_Y[maxLane] + NODE_H + 80;

  return { nodes, arrows, width, height, lanesUsed };
}

function syntheticStep(name: string, status: RunStep['status'], detail?: string): RunStep {
  return { name, status, detail };
}

export function publicationReviewStepForName(run: Run, stepName: string): RunStep | null {
  if (!stepName.includes('publication-review-')) return null;
  const node = [
    ...publicationReviewPlanNodes(run, 'pre-gate'),
    ...publicationReviewPlanNodes(run, 'post-gate'),
  ].find((candidate) => candidate.step.name === stepName || candidate.id === stepName);
  return node?.step ?? null;
}

function pipelineDisplayStep(step: RunStep, waitingForPreGateReviews: boolean): RunStep {
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

function adjustedStepPos(
  stepName: string,
  pos: StepPos | undefined,
  preGateShift: number,
  postGateShift: number,
): StepPos | undefined {
  if (!pos || pos.lane !== 'post') return pos;
  const preGateCol = pos.col + preGateShift;
  const needsPostGateShift = new Set(['finalize', 'ci-watch', 'ci-pass', 'done']).has(stepName);
  return { ...pos, col: preGateCol + (needsPostGateShift ? postGateShift : 0) };
}

interface PublicationReviewPlanNode {
  id: string;
  order: number;
  label: string;
  meta: string;
  step: RunStep;
}

function postGateRefreshStatus(nodes: PublicationReviewPlanNode[]): RunStep['status'] {
  if (nodes.some((node) => node.step.status === 'running')) return 'pending';
  if (nodes.some((node) => node.step.status === 'pending')) return 'pending';
  if (nodes.some((node) => node.step.status === 'failed')) return 'failed';
  return 'done';
}

function publicationReviewPlanNodes(
  run: Run,
  phase: 'pre-gate' | 'post-gate',
): PublicationReviewPlanNode[] {
  if (run.flowType !== 'fix-bug' && run.flowType !== 'dev') return [];
  const publishGate = run.engineState?.publishGate;
  if (!publishGate) return [];
  const reviewDepth = recordValue(publishGate.reviewDepth);
  const requestedBy = reviewDepth?.requestedBy === 'human-gate' ? 'human-gate' : 'dispatch';
  const minimum = Number(reviewDepth?.minimumIndependentReviews ?? 1);
  const nodesByOrder = new Map<number, PublicationReviewPlanNode>();

  const pendingPlan = Array.isArray(publishGate.pendingReviewPlan)
    ? publishGate.pendingReviewPlan
    : [];
  if (pendingPlan.length > 0 && (phase === 'post-gate') === (requestedBy === 'human-gate')) {
    for (const [index, plan] of pendingPlan.slice(0, 5).entries()) {
      const planRecord = recordValue(plan);
      const runner =
        typeof planRecord?.runner === 'string' && planRecord.runner.trim()
          ? planRecord.runner.trim()
          : 'same';
      const model =
        typeof planRecord?.model === 'string' && planRecord.model.trim()
          ? planRecord.model.trim()
          : '';
      const order =
        planRecord && Number.isFinite(Number(planRecord.order))
          ? Number(planRecord.order)
          : index + 1;
      const step = syntheticStep(
        `${phase}-publication-review-${index + 1}`,
        'pending',
        `${runner}${model ? ` / ${model}` : ''}`,
      );
      nodesByOrder.set(index + 1, {
        id: `${phase}-publication-review-${index + 1}`,
        order: index + 1,
        label: phase === 'post-gate' ? `extra ${order}` : `review ${order}`,
        meta: `${runner}${model ? ` · ${model}` : ''}`,
        step,
      });
    }
  }

  const reviews = Array.isArray(publishGate.independentReviews)
    ? publishGate.independentReviews
    : [];
  reviews
    .filter((review) => {
      if (phase === 'post-gate') return review.source === 'human-gate';
      if (review.source === 'human-gate') return false;
      const loopNumber = Number(review.loopNumber ?? 0);
      return review.source === 'dispatch' || loopNumber > minimum || review.crossRunner === true;
    })
    .slice(0, 5)
    .map((review, index: number) => {
      const runner =
        typeof review.runner === 'string' && review.runner.trim()
          ? review.runner.trim()
          : 'reviewer';
      const model =
        typeof review.model === 'string' && review.model.trim() ? review.model.trim() : '';
      const verdict = typeof review.verdict === 'string' ? review.verdict : '';
      const attempts = Array.isArray(review.attempts) ? review.attempts : [];
      const fixedByLoop =
        verdict === 'pass' &&
        attempts.some(
          (attempt) =>
            typeof attempt === 'object' && attempt !== null && attempt.verdict === 'issues',
        );
      const loopNumber = Number(review.loopNumber ?? index + 1);
      const order = Math.max(1, phase === 'pre-gate' ? loopNumber - minimum : index + 1);
      const status: RunStep['status'] =
        verdict === 'pass' || verdict === 'skipped'
          ? 'done'
          : verdict === 'failed'
            ? 'failed'
            : verdict === 'pending'
              ? 'running'
              : 'done';
      const inferredStartedAt = reviewStartedAt(review, reviews);
      const meta = fixedByLoop
        ? `${runner} · fixed · ${verdict || 'pass'}`
        : `${runner}${model ? ` · ${model}` : ''}${verdict ? ` · ${verdict}` : ''}`;
      nodesByOrder.set(order, {
        id: `${phase}-publication-review-${order}`,
        order,
        label: phase === 'post-gate' ? `extra ${order}` : `review ${order}`,
        meta,
        step: {
          ...syntheticStep(`${phase}-publication-review-${order}`, status, verdict || runner),
          startedAt: inferredStartedAt,
          completedAt: typeof review.completedAt === 'string' ? review.completedAt : undefined,
          outputs: {
            reviewId: typeof review.id === 'string' ? review.id : undefined,
            source: typeof review.source === 'string' ? review.source : undefined,
            runner,
            model: model || undefined,
            verdict: verdict || undefined,
            unresolvedCount:
              typeof review.unresolvedCount === 'number' ? review.unresolvedCount : undefined,
            validationDepth:
              typeof review.validationDepth === 'string' ? review.validationDepth : undefined,
            feedbackSent: review.feedbackSent === true,
            taskProgressArtifactPath:
              typeof review.taskProgressArtifactPath === 'string'
                ? review.taskProgressArtifactPath
                : undefined,
            timeline: Array.isArray(review.timeline) ? review.timeline : undefined,
            artifactPaths: Array.isArray(review.artifactPaths) ? review.artifactPaths : undefined,
            attempts: attempts.length ? attempts : undefined,
          },
        },
      });
    });

  const activeReview = activeReviewFromHumanGateDetail(run, phase);
  if (activeReview && !nodesByOrder.has(activeReview.order)) {
    nodesByOrder.set(activeReview.order, activeReview);
  }

  return [...nodesByOrder.values()].sort((a, b) => a.order - b.order).slice(0, 5);
}

function reviewStartedAt(
  review: PublicationReviewStatus,
  allReviews: readonly PublicationReviewStatus[],
): string | undefined {
  if (typeof review.startedAt === 'string') return review.startedAt;
  const attempts = Array.isArray(review.attempts) ? review.attempts : [];
  const firstAttemptStart = attempts.find(
    (attempt) => typeof attempt.startedAt === 'string',
  )?.startedAt;
  if (typeof firstAttemptStart === 'string') return firstAttemptStart;

  // Compatibility for reviews created before the gateway persisted startedAt:
  // infer the start of an additional review from the previous review completion.
  // This keeps historical runs scannable without mutating their stored data.
  const loopNumber = Number(review.loopNumber ?? 0);
  if (!Number.isFinite(loopNumber) || loopNumber <= 1) return undefined;
  const previousCompleted = allReviews
    .map((candidate) => ({
      loopNumber: Number(candidate.loopNumber ?? 0),
      completedAt: typeof candidate.completedAt === 'string' ? candidate.completedAt : undefined,
    }))
    .filter(
      (candidate): candidate is { loopNumber: number; completedAt: string } =>
        Number.isFinite(candidate.loopNumber) &&
        candidate.loopNumber > 0 &&
        candidate.loopNumber < loopNumber &&
        typeof candidate.completedAt === 'string',
    )
    .sort((a, b) => b.loopNumber - a.loopNumber)[0]?.completedAt;
  return previousCompleted;
}

function activeReviewFromHumanGateDetail(
  run: Run,
  phase: 'pre-gate' | 'post-gate',
): PublicationReviewPlanNode | null {
  const selfReview = run.steps.find((step) => step.name === 'self-review');
  const humanGate = run.steps.find((step) => step.name === 'human-gate');
  const candidates = [selfReview, humanGate].filter(
    (step): step is RunStep => step?.status === 'running' && typeof step.detail === 'string',
  );
  const carrier = candidates.find((step) =>
    step.detail?.match(/Running (dispatch|human-gate) ([\w.-]+) review \((\d+)\/(\d+)\)/i),
  );
  if (!carrier?.detail) return null;
  const match = carrier.detail.match(
    /Running (dispatch|human-gate) ([\w.-]+) review \((\d+)\/(\d+)\)/i,
  );
  if (!match) return null;
  const source = match[1].toLowerCase() === 'human-gate' ? 'human-gate' : 'dispatch';
  if ((phase === 'post-gate') !== (source === 'human-gate')) return null;
  const runner = match[2];
  const current = Number(match[3]);
  if (!Number.isFinite(current) || current <= 0) return null;
  const order = Math.max(1, current);
  const id = `${phase}-publication-review-${order}`;
  const step = syntheticStep(id, 'running', runner);
  step.startedAt = carrier.startedAt;
  return {
    id,
    order,
    label: phase === 'post-gate' ? `extra ${current}` : `review ${current}`,
    meta: `${runner} · running`,
    step,
  };
}

function ciSyntheticStatus(run: Run, ciStep: RunStep): RunStep['status'] {
  const summary = recordValue(ciStep.outputs?.checkSummary);
  if (
    summary?.total &&
    numberValue(summary.passed) === numberValue(summary.total) &&
    numberValue(summary.failed) === 0 &&
    numberValue(summary.pending) === 0
  )
    return 'done';
  if (run.status === 'done' && ciStep.status === 'done') return 'done';
  // While ci-watch is running (polling or executing an inline-fix loop), intermediate
  // failed checks are not terminal — the fix loop will retry. Only flip ci-pass to
  // failed once ci-watch itself terminates.
  if (ciStep.status === 'running') return 'running';
  if (ciStep.status === 'failed' || numberValue(summary?.failed)) return 'failed';
  return 'pending';
}

function arrowPath(src: NodePos, tgt: NodePos): string {
  if (src.lane === tgt.lane) {
    // Horizontal
    const y = src.y + NODE_H / 2;
    return `M ${src.x + src.w} ${y} L ${tgt.x} ${y}`;
  }
  // Cross-lane bezier
  const x1 = src.x + src.w / 2;
  const y1 = src.y + NODE_H;
  const x2 = tgt.x + tgt.w / 2;
  const y2 = tgt.y;
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

interface CiFixProgressOutput {
  completed?: number;
  total?: number;
  currentLabel?: string | null;
}

function readCiFixProgress(value: unknown): CiFixProgressOutput | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return {
    completed: typeof record.completed === 'number' ? record.completed : undefined,
    total: typeof record.total === 'number' ? record.total : undefined,
    currentLabel:
      typeof record.currentLabel === 'string' || record.currentLabel === null
        ? record.currentLabel
        : undefined,
  };
}

export function buildCiFixTaskProgress(
  outputs: Record<string, unknown>,
): TaskProgressStructured | undefined {
  const progress = readCiFixProgress(outputs.fixProgress);
  if (!progress?.total) return undefined;
  const completed = progress.completed ?? 0;
  const steps = Array.from({ length: progress.total }, (_, index) => {
    const oneBased = index + 1;
    return {
      index: oneBased,
      name:
        oneBased === completed + 1 && progress.currentLabel
          ? progress.currentLabel
          : `Step ${oneBased}`,
      status:
        oneBased <= completed
          ? ('done' as const)
          : oneBased === completed + 1
            ? ('running' as const)
            : ('pending' as const),
    };
  });
  return {
    schema: {
      flowType: 'ci-watch',
      title: 'CI fix',
      totalSteps: progress.total,
      phases: [{ name: 'CI fix', steps: steps.map(({ index, name }) => ({ index, name })) }],
    },
    phases: [{ name: 'CI fix', steps, completedSteps: completed, totalSteps: progress.total }],
    completedSteps: completed,
    totalSteps: progress.total,
    currentPhase: 'CI fix',
    currentStep: progress.currentLabel ?? null,
  };
}
