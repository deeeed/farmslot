// flow-graph-data.ts — Flow graph visualization data model.
//
// HARDENED AGAINST DRIFT: The graph backbone is derived from FLOW_STEPS
// (the single source of truth in @farmslot/protocol). Step-level rendering
// annotations (descriptions, decisions, sub-steps) are defined once per step
// type in STEP_META. If a step is added to FLOW_STEPS without a matching
// annotation, it renders as a plain node with the step name as label.
// If a step is removed from FLOW_STEPS, it disappears from the graph.

import type { FlowType } from '@farmslot/protocol';
import { FLOW_STEPS, PipelineSteps } from '@farmslot/protocol';

// ─── Types ───

export type FlowMode = 'interactive' | 'autonomous';
export type NodeKind = 'step' | 'decision' | 'terminal' | 'chain';
export type GraphLane = 'orch' | 'worker' | 'post';
export type EdgeStyle = 'normal' | 'conditional' | 'loop';
export type Executor = 'gateway' | 'worker' | 'reviewer' | 'human';

export interface FlowGraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  lane: GraphLane;
  description?: string;
  skipped?: boolean;
  annotation?: string;
  /** Override template file shown in detail panel (e.g., 'self-review.md') */
  templateFile?: string;
  /** Who executes this step */
  executor?: Executor;
}

export interface FlowGraphEdge {
  from: string;
  to: string;
  label?: string;
  style: EdgeStyle;
}

export interface FlowGraph {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
}

// ─── Step annotations ───
//
// Each pipeline step can have rendering metadata. Two extension mechanisms:
//
// - `after(mode, stepId, nextId)`: The step is rendered as a normal node,
//   then `after` appends extra nodes/edges (e.g., decision diamonds).
//   The `after` function handles all outgoing edges including to `nextId`.
//
// - `render(mode, nextId)`: The step node is REPLACED by a sub-graph.
//   The render function provides all nodes and edges, including the entry
//   node and edges to `nextId`. Use `entryId` to tell the builder where
//   to connect incoming edges.

interface StepMeta {
  lane: GraphLane;
  label: string;
  description: string;
  executor?: Executor;
  /** Override entry node id for render steps (default: step name) */
  entryId?: string;
  /** Ghost this step in the given mode */
  skipInMode?: FlowMode;
  /** Mode-specific annotation badge text */
  modeAnnotations?: Partial<Record<FlowMode, string>>;
  /** Append extra nodes/edges after the step node (step node is added by builder) */
  after?: (
    mode: FlowMode,
    stepId: string,
    nextId: string,
  ) => {
    nodes: FlowGraphNode[];
    edges: FlowGraphEdge[];
  };
  /** Replace the step entirely with a sub-graph (step node NOT added by builder) */
  render?: (
    mode: FlowMode,
    nextId: string,
  ) => {
    nodes: FlowGraphNode[];
    edges: FlowGraphEdge[];
  };
}

const S = PipelineSteps;

// ─── Self-review sub-graph ───

function renderSelfReview(
  mode: FlowMode,
  nextId: string,
): { nodes: FlowGraphNode[]; edges: FlowGraphEdge[] } {
  const autonomous = mode === 'autonomous';
  const nodes: FlowGraphNode[] = [
    {
      id: 'sr-review',
      kind: 'step',
      label: 'Review',
      lane: 'worker',
      executor: 'reviewer',
      description:
        'Spawn reviewer (second Claude session) in new tmux window on same slot. Reviews PR diff, reads code, runs tsc, can execute recipe.',
      templateFile: 'self-review.md',
    },
    {
      id: 'sr-verdict',
      kind: 'decision',
      label: 'Verdict?',
      lane: 'worker',
      executor: 'gateway',
      description: 'Reviewer writes SIGNAL.json with verdict: pass or issues.',
    },
    {
      id: 'sr-feedback',
      kind: 'step',
      label: 'Feedback',
      lane: 'worker',
      executor: 'gateway',
      description: 'Gateway sends review-feedback.md to the worker via tmux send-keys.',
      templateFile: 'self-review-fix.md',
    },
    {
      id: 'sr-fix',
      kind: 'step',
      label: 'Worker Fix',
      lane: 'worker',
      executor: 'worker',
      description: 'Worker addresses review feedback. Gateway polls SIGNAL.json for completion.',
      templateFile: 'self-review-fix.md',
    },
    {
      id: 'sr-recheck',
      kind: 'decision',
      label: 'Re-review?',
      lane: 'worker',
      executor: 'gateway',
      description: 'After worker fix, spawn reviewer again to verify.',
    },
    ...(autonomous
      ? []
      : [
          {
            id: 'sr-human',
            kind: 'decision' as NodeKind,
            label: 'Retry or skip?',
            lane: 'worker' as GraphLane,
            executor: 'human' as Executor,
            description:
              'Interactive only: after auto-retry, if issues remain, human decides: send another feedback round or skip to next step.',
            annotation: 'interactive only',
          },
        ]),
  ];

  const edges: FlowGraphEdge[] = [
    { from: 'sr-review', to: 'sr-verdict', style: 'normal' },
    { from: 'sr-verdict', to: nextId, label: 'pass', style: 'normal' },
    { from: 'sr-verdict', to: 'sr-feedback', label: 'issues', style: 'conditional' },
    { from: 'sr-feedback', to: 'sr-fix', style: 'normal' },
    { from: 'sr-fix', to: 'sr-recheck', style: 'normal' },
    { from: 'sr-recheck', to: 'sr-review', label: 're-review', style: 'loop' },
    ...(autonomous
      ? [
          {
            from: 'sr-recheck',
            to: nextId,
            label: 'max retries',
            style: 'conditional' as EdgeStyle,
          },
        ]
      : [
          {
            from: 'sr-recheck',
            to: 'sr-human',
            label: 'still issues',
            style: 'conditional' as EdgeStyle,
          },
          {
            from: 'sr-human',
            to: 'sr-feedback',
            label: 'send feedback',
            style: 'loop' as EdgeStyle,
          },
          { from: 'sr-human', to: nextId, label: 'skip', style: 'conditional' as EdgeStyle },
        ]),
  ];

  return { nodes, edges };
}

// ─── Step metadata (one entry per pipeline step) ───

const STEP_META: Record<string, StepMeta> = {
  [S.GRADE]: {
    lane: 'orch',
    label: 'Grade',
    description: 'Fetch ticket data from Jira/GitHub. LLM grades difficulty and recommends model.',
    executor: 'gateway',
    after: (_mode, stepId, nextId) => ({
      nodes: [
        {
          id: 'grade-decision',
          kind: 'decision',
          label: 'Flow match?',
          lane: 'orch',
          executor: 'gateway',
          description: 'LLM may recommend a different flow type. Decision: switch flow or proceed.',
        },
      ],
      edges: [
        { from: stepId, to: 'grade-decision', style: 'normal' },
        { from: 'grade-decision', to: nextId, label: 'proceed', style: 'normal' },
      ],
    }),
  },

  [S.FIND_SLOT]: {
    lane: 'orch',
    label: 'Find Slot',
    description:
      'Score free slots by branch staleness, health, CDP availability. Pick best candidate.',
    executor: 'gateway',
    after: (_mode, stepId, nextId) => ({
      nodes: [
        {
          id: 'slot-decision',
          kind: 'decision',
          label: 'Slot OK?',
          lane: 'orch',
          executor: 'gateway',
          description: 'If no suitable slot found, human picks from candidates or aborts.',
        },
      ],
      edges: [
        { from: stepId, to: 'slot-decision', style: 'normal' },
        { from: 'slot-decision', to: nextId, label: 'slot found', style: 'normal' },
      ],
    }),
  },

  [S.WRITE_TASK]: {
    lane: 'orch',
    label: 'Write Task',
    description:
      'Expand task template with ticket data, slot vars, mode preamble. Write TASK.md + inputs/ to slot.',
    executor: 'gateway',
  },

  [S.PREPARE]: {
    lane: 'orch',
    label: 'Prepare',
    description:
      'Checkout branch, merge main, install deps, preflight (Metro/webpack), health check (CDP).',
    executor: 'gateway',
  },

  [S.DISPATCH]: {
    lane: 'worker',
    label: 'Dispatch',
    description: 'Copy task files to slot, launch runner (Claude/Codex) in tmux session.',
    executor: 'gateway',
  },

  [S.MONITOR]: {
    lane: 'worker',
    label: 'Monitor',
    description:
      'Poll runner progress via TASK.md checkboxes + SIGNAL.json. Detect stuck/idle, send nudges.',
    executor: 'worker',
  },

  [S.SELF_REVIEW]: {
    lane: 'worker',
    label: 'Self Review',
    description: 'Automated review + feedback + fix cycle.',
    entryId: 'sr-review',
    render: renderSelfReview,
  },

  [S.COMPLETE]: {
    lane: 'post',
    label: 'Package / Complete',
    description:
      'Prepare immutable local PR package, copy artifacts, capture branch/head/evidence, and avoid public PR mutation before approval.',
    executor: 'gateway',
    after: (_mode, stepId, nextId) => ({
      nodes: [
        {
          id: 'independent-review',
          kind: 'decision',
          label: 'Review ready?',
          lane: 'post',
          executor: 'reviewer',
          description:
            'Default one independent review must pass; gate can request extra external reviews before publication.',
        },
      ],
      edges: [
        { from: stepId, to: 'independent-review', style: 'normal' },
        { from: 'independent-review', to: nextId, label: 'policy satisfied', style: 'normal' },
        {
          from: 'independent-review',
          to: 'independent-review',
          label: 'extra external review requested',
          style: 'loop',
        },
      ],
    }),
  },

  [S.HUMAN_GATE]: {
    lane: 'post',
    label: 'Publish Gate',
    description:
      'Human reviews package, diff, draft PR metadata, evidence, validation, and review depth. Only Approve Publish can unblock finalize.',
    executor: 'human',
    modeAnnotations: {
      interactive: 'human approval required',
      autonomous: 'autonomous context; human approval required',
    },
  },

  [S.FINALIZE]: {
    lane: 'post',
    label: 'Publish',
    description:
      'Create/update the approved PR package as draft or ready, publish evidence/body/title, then permit CI-watch.',
    executor: 'gateway',
  },

  [S.CI_WATCH]: {
    lane: 'post',
    label: 'CI Watch',
    description: 'Monitor CI checks. On conflict: chain merge-main flow. On pass: done.',
    executor: 'gateway',
    after: (_mode, stepId, _nextId) => ({
      nodes: [
        {
          id: 'ci-pass',
          kind: 'decision',
          label: 'CI pass?',
          lane: 'post',
          executor: 'gateway',
          description: 'All CI checks pass. Run completes.',
        },
        {
          id: 'ci-conflict',
          kind: 'decision',
          label: 'Conflict?',
          lane: 'post',
          executor: 'gateway',
          description: 'CI monitor detects merge conflict.',
        },
        {
          id: 'chain-merge',
          kind: 'chain',
          label: 'merge-main',
          lane: 'post',
          executor: 'gateway',
          description: 'Follow-up merge-main flow to resolve conflicts and re-run CI.',
        },
        {
          id: 'done',
          kind: 'terminal',
          label: 'Done',
          lane: 'post',
          executor: 'gateway',
          description: 'Run completed successfully. Slot released.',
        },
      ],
      edges: [
        { from: stepId, to: 'ci-pass', style: 'normal' },
        { from: 'ci-pass', to: 'done', label: 'pass', style: 'normal' },
        { from: stepId, to: 'ci-conflict', style: 'conditional' },
        { from: 'ci-conflict', to: 'chain-merge', label: 'conflict', style: 'conditional' },
      ],
    }),
  },
};

// ─── Lane inference for unknown steps ───

function inferLane(stepName: string, steps: readonly string[]): GraphLane {
  const idx = steps.indexOf(stepName);
  const dispatchIdx = steps.indexOf(S.DISPATCH);
  const completeIdx = steps.indexOf(S.COMPLETE);
  if (dispatchIdx >= 0 && idx < dispatchIdx) return 'orch';
  if (completeIdx >= 0 && idx >= completeIdx) return 'post';
  return 'worker';
}

// ─── Graph builder ───

export function buildFlowGraph(flowType: FlowType, mode: FlowMode): FlowGraph {
  const steps = FLOW_STEPS[flowType];
  const nodes: FlowGraphNode[] = [];
  const edges: FlowGraphEdge[] = [];

  // Pre-compute entry ids so we can determine nextId during iteration
  const entryIds = steps.map((s) => STEP_META[s]?.entryId ?? s);

  let prevExitId: string | null = null;

  for (let i = 0; i < steps.length; i++) {
    const stepName = steps[i];
    const meta = STEP_META[stepName];
    const entryId = entryIds[i];
    const nextEntryId: string | null = i + 1 < steps.length ? entryIds[i + 1] : null;
    const isSkipped = meta?.skipInMode === mode;

    // --- Skipped step: ghost node, bypass ---
    if (isSkipped && meta) {
      const annotation = meta.modeAnnotations?.[mode] ?? `skipped in ${mode}`;
      nodes.push({
        id: stepName,
        kind: 'step',
        label: meta.label,
        lane: meta.lane,
        description: meta.description,
        skipped: true,
        annotation,
        executor: meta.executor,
      });
      // Faint edges showing the would-be path
      if (prevExitId) {
        edges.push({ from: prevExitId, to: stepName, style: 'conditional' });
      }
      if (nextEntryId) {
        edges.push({ from: stepName, to: nextEntryId, style: 'conditional' });
      }
      // prevExitId stays unchanged — real path bypasses this step
      continue;
    }

    // --- Connect from previous step ---
    if (prevExitId) {
      edges.push({ from: prevExitId, to: entryId, style: 'normal' });
    }

    // --- Render step ---
    if (meta?.render) {
      // Complex step: render provides all nodes/edges (e.g., self-review sub-graph)
      const result = meta.render(mode, nextEntryId ?? 'done');
      nodes.push(...result.nodes);
      edges.push(...result.edges);
      prevExitId = null; // render handled outgoing edges
    } else if (meta?.after) {
      // Simple step + extras: add step node, then decision/chain extras
      nodes.push({
        id: stepName,
        kind: 'step',
        label: meta.label,
        lane: meta.lane,
        description: meta.description,
        annotation: meta.modeAnnotations?.[mode],
        executor: meta.executor,
      });
      const result = meta.after(mode, stepName, nextEntryId ?? 'done');
      nodes.push(...result.nodes);
      edges.push(...result.edges);
      prevExitId = null; // after handled outgoing edges
    } else {
      // Plain step node (with or without metadata)
      const label = meta?.label ?? stepName;
      const lane = meta?.lane ?? inferLane(stepName, steps);
      const desc = meta?.description ?? '';
      nodes.push({
        id: stepName,
        kind: 'step',
        label,
        lane,
        description: desc,
        annotation: meta?.modeAnnotations?.[mode],
        executor: meta?.executor ?? 'gateway',
      });
      prevExitId = stepName;
    }
  }

  // Add terminal if the last step didn't handle it (e.g., no ci-watch)
  if (prevExitId) {
    nodes.push({
      id: 'done',
      kind: 'terminal',
      label: 'Done',
      lane: 'post',
      description: 'Run completed.',
      executor: 'gateway',
    });
    edges.push({ from: prevExitId, to: 'done', style: 'normal' });
  }

  return { nodes, edges };
}

export const ALL_FLOW_TYPES: FlowType[] = [
  'fix-bug',
  'dev',
  'review-pr',
  'pr-complete',
  'merge-main',
];
export const ALL_MODES: FlowMode[] = ['interactive', 'autonomous'];
