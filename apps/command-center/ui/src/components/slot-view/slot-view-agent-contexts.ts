import type { AgentContextSummary, AgentRole, Run, SlotStatus } from '@farmslot/protocol';
import {
  agentRoleLabel,
  agentRoleRank,
  isReviewerAgentContext,
  primaryRoleForFlow,
  selectLatestReviewerContext,
} from '@farmslot/protocol';

type SlotViewAgentContextLike = Pick<
  AgentContextSummary,
  | 'id'
  | 'role'
  | 'label'
  | 'status'
  | 'runId'
  | 'taskFile'
  | 'signalFile'
  | 'runner'
  | 'model'
  | 'target'
  | 'nudgeCount'
  | 'lastSignalAt'
  | 'updatedAt'
>;

export interface SlotViewAgentContextRun {
  id: string;
  flowType?: Run['flowType'] | string | null;
  status: Run['status'];
  activeTaskFile?: string | null;
  taskFile?: string | null;
  metrics: Pick<Run['metrics'], 'runner' | 'model' | 'nudgeCount'>;
  agentContexts?: readonly SlotViewAgentContextLike[];
}

export interface SlotViewAgentContextSlot {
  currentFlowType?: SlotStatus['currentFlowType'];
  agentContexts?: readonly SlotViewAgentContextLike[];
}

export interface SlotViewAgentContextInput {
  linkedRun: SlotViewAgentContextRun | null;
  slot: SlotViewAgentContextSlot | null;
}

export function agentContextKey(ctx: AgentContextSummary): string {
  return ctx.id || `${ctx.role}:${ctx.target?.target ?? 'unknown'}`;
}

export function isAgentContextUnavailable(
  ctx: AgentContextSummary,
  unavailableKeys: Set<string>,
): boolean {
  if (!ctx.target?.target) return true;
  return unavailableKeys.has(agentContextKey(ctx));
}

function displayAgentContext(
  ctx: AgentContextSummary,
  flowRole: AgentRole,
  flowRoleExists: boolean,
): AgentContextSummary {
  if (ctx.role === 'primary' && flowRole !== 'primary' && !flowRoleExists) {
    return { ...ctx, label: agentRoleLabel(flowRole) };
  }
  return ctx;
}

function toAgentContextSummary(ctx: SlotViewAgentContextLike): AgentContextSummary {
  return {
    id: ctx.id,
    role: ctx.role,
    label: ctx.label,
    status: ctx.status,
    runId: ctx.runId,
    taskFile: ctx.taskFile,
    signalFile: ctx.signalFile,
    runner: ctx.runner,
    model: ctx.model,
    target: ctx.target,
    nudgeCount: ctx.nudgeCount,
    lastSignalAt: ctx.lastSignalAt,
    updatedAt: ctx.updatedAt,
  };
}

function hasTmuxTarget(ctx: AgentContextSummary): boolean {
  return Boolean(ctx.target?.target);
}

export function deriveSlotViewAgentContexts({
  linkedRun,
  slot,
}: SlotViewAgentContextInput): AgentContextSummary[] {
  // Authoritative-run gate: when the gateway has refused to bind this slot
  // to a single active run (ambiguous / missing pointer), suppress the slot
  // mirror entirely. Consumers fall back to the bare terminal session until
  // the run identity is resolved.
  if (!linkedRun) return [];

  const runContexts = (linkedRun.agentContexts ?? []).map(toAgentContextSummary);
  const flowRole = primaryRoleForFlow(linkedRun.flowType ?? slot?.currentFlowType);
  const linkedRunId = linkedRun.id;
  const slotContextsForRun = (slot?.agentContexts ?? [])
    .map(toAgentContextSummary)
    .filter((ctx) => !linkedRunId || !ctx.runId || ctx.runId === linkedRunId);
  const flowRoleExists =
    flowRole !== 'primary' &&
    [...slotContextsForRun, ...runContexts].some((ctx) => ctx.role === flowRole);
  const skipPrimary = flowRole !== 'primary' && flowRoleExists;
  const merged = new Map<string, AgentContextSummary>();
  for (const ctx of slotContextsForRun) {
    if (skipPrimary && ctx.role === 'primary') continue;
    if (!hasTmuxTarget(ctx)) continue;
    merged.set(ctx.id, displayAgentContext(ctx, flowRole, flowRoleExists));
  }
  for (const ctx of runContexts) {
    if (skipPrimary && ctx.role === 'primary') continue;
    if (!hasTmuxTarget(ctx)) continue;
    merged.set(ctx.id, displayAgentContext(ctx, flowRole, flowRoleExists));
  }
  const contexts = [...merged.values()].sort((a, b) => {
    const rankA = agentRoleRank(a.role);
    const rankB = agentRoleRank(b.role);
    if (rankA !== rankB) return rankA - rankB;
    const labelCmp = a.label.localeCompare(b.label);
    if (labelCmp !== 0) return labelCmp;
    return a.id.localeCompare(b.id);
  });
  if (contexts.length > 0) return contexts;
  if (!slot) return [];
  const role = primaryRoleForFlow(linkedRun.flowType);
  return [
    {
      id: role,
      role,
      label: agentRoleLabel(role),
      status:
        linkedRun.status === 'done'
          ? 'complete'
          : linkedRun.status === 'blocked'
            ? 'blocked'
            : 'working',
      runId: linkedRun.id,
      taskFile: linkedRun.activeTaskFile ?? linkedRun.taskFile,
      runner: linkedRun.metrics.runner,
      model: linkedRun.metrics.model,
      nudgeCount: linkedRun.metrics.nudgeCount,
    },
  ];
}

export function selectSlotViewAgentContext(
  contexts: AgentContextSummary[],
  selectedAgentContextId: string,
): AgentContextSummary | null {
  if (selectedAgentContextId === 'latest-reviewer') {
    return selectLatestReviewerContext(contexts) ?? null;
  }
  const exact = contexts.find((ctx) => ctx.id === selectedAgentContextId);
  if (exact) return exact;
  if (selectedAgentContextId === 'self-review') {
    return selectLatestReviewerContext(contexts) ?? null;
  }
  return contexts.find((ctx) => ctx.role === 'primary') ?? contexts[0] ?? null;
}

/** Primary worker checklist is independent from terminal/history navigation. */
export function selectSlotViewTaskContext(
  contexts: AgentContextSummary[],
  flowType?: Run['flowType'] | string | null,
): AgentContextSummary | null {
  const primaryRole = primaryRoleForFlow(flowType);
  return (
    contexts.find((ctx) => ctx.role === primaryRole) ??
    contexts.find((ctx) => ctx.role === 'primary') ??
    contexts.find((ctx) => !isReviewerAgentContext(ctx)) ??
    null
  );
}

/** Chip / breadcrumb label: prefer short reviewer tab id over generic Self-review. */
export function slotViewAgentContextChipLabel(ctx: AgentContextSummary): string {
  if (isReviewerAgentContext(ctx)) {
    const window = ctx.target?.window?.trim();
    if (window) return window;
    if (ctx.id.startsWith('rev-') || /^rev\d+-/.test(ctx.id)) return ctx.id;
  }
  return ctx.label || ctx.role;
}
