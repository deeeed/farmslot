import type {
  BacklogItem,
  QueueItem,
  Run,
  SlotStatus,
  WorkGraphProjection,
  WorkNode,
  WorkNodeKind,
  WorkNodeStatus,
} from '@farmslot/protocol';
import { isTerminalRunStatus } from '@farmslot/protocol';

import { labelWithRef } from '../shared/item-ref.js';

export type WorkGraphExecutionStatus =
  | 'reference'
  | 'dependency-blocked'
  | 'config-blocked'
  | 'ready'
  | 'queued'
  | 'waiting-for-slot'
  | 'dispatching'
  | 'running'
  | 'gated'
  | 'needs-attention'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export type WorkGraphNodeBlockerKind =
  | 'dependency'
  | 'backlog-status'
  | 'config'
  | 'queue'
  | 'slot-busy'
  | 'slot-unavailable'
  | 'run'
  | 'reference'
  | 'policy';

export interface WorkGraphNodeBlocker {
  kind: WorkGraphNodeBlockerKind;
  severity: 'info' | 'warning' | 'blocking';
  message: string;
  slotId?: string;
  queueItemId?: string;
  runId?: string;
}

export interface SlotExecutionView {
  slotId: string;
  project: string;
  lifecycle: SlotStatus['lifecycle'];
  phase: SlotStatus['phase'];
  ready: boolean;
  reason: string;
  queueItemIds: string[];
  runIds: string[];
}

export interface WorkGraphNodeExecutionView {
  graphId: string;
  nodeId: string;
  kind: WorkNodeKind;
  title: string;
  project: string;
  graphStatus: WorkNodeStatus;
  executionStatus: WorkGraphExecutionStatus;
  summary: string;
  blockers: WorkGraphNodeBlocker[];
  backlogItem?: BacklogItem;
  queueItem?: QueueItem;
  run?: Run;
  visibleCandidateSlots: SlotExecutionView[];
  editableConfig: boolean;
}

export interface WorkGraphExecutionOverlayInput {
  graph: WorkGraphProjection;
  backlogItems: BacklogItem[];
  queueItems: QueueItem[];
  runs: Run[];
  slots: SlotStatus[];
}

export interface WorkGraphExecutionOverlay {
  nodes: WorkGraphNodeExecutionView[];
  byNodeId: Map<string, WorkGraphNodeExecutionView>;
}

export interface SlotPendingWorkItem {
  id: string;
  title: string;
  project: string;
  kind: 'queued' | 'running' | 'scheduler-ready';
  graphId?: string;
  nodeId?: string;
  queueItemId?: string;
  runId?: string;
}

export interface SlotPendingWork {
  slotId: string;
  queued: SlotPendingWorkItem[];
  running: SlotPendingWorkItem[];
  schedulerReady: SlotPendingWorkItem[];
}

function titleForNode(node: WorkNode, backlogItem?: BacklogItem): string {
  if (node.kind === 'reference') return node.reference?.title ?? node.id;
  return labelWithRef(backlogItem?.title, backlogItem?.sourceRef) || node.backlogItemId || node.id;
}

function projectForNode(
  graph: WorkGraphProjection,
  node: WorkNode,
  backlogItem?: BacklogItem,
): string {
  if (backlogItem) return backlogItem.project;
  if (node.kind === 'reference') return node.reference?.project ?? graph.graph.project;
  return graph.graph.project;
}

function isVisibleSlotReady(slot: SlotStatus): boolean {
  return (
    slot.enabled !== false &&
    slot.dispatchable !== false &&
    slot.agent !== 'working' &&
    slot.lifecycle === 'ready'
  );
}

function slotReason(slot: SlotStatus): string {
  if (slot.enabled === false) return 'disabled';
  if (slot.dispatchable === false) return 'not dispatchable';
  if (slot.agent === 'working') return 'busy with active worker';
  if (slot.lifecycle === 'manual') return 'manual hold';
  if (slot.lifecycle === 'disabled') return 'disabled';
  if (slot.lifecycle === 'busy') return slot.phase ? `busy: ${slot.phase}` : 'busy';
  if (slot.lifecycle === 'held') return 'held; not a free dispatch slot';
  return 'ready';
}

function queueMatchesNode(item: QueueItem, node: WorkNode, backlogItem?: BacklogItem): boolean {
  return Boolean(
    (item.workGraphId === node.graphId && item.workNodeId === node.id) ||
    (backlogItem?.queuedQueueItemId && item.id === backlogItem.queuedQueueItemId) ||
    (backlogItem?.id && item.backlogItemId === backlogItem.id),
  );
}

function runMatchesNode(run: Run, node: WorkNode, backlogItem?: BacklogItem): boolean {
  return Boolean(
    (run.workGraphId === node.graphId && run.workNodeId === node.id) ||
    (backlogItem?.id && run.backlogItemId === backlogItem.id) ||
    (backlogItem?.runId && run.id === backlogItem.runId) ||
    node.latestRunId === run.id ||
    node.currentRootRunId === run.id,
  );
}

function chooseRun(runs: Run[], node: WorkNode, backlogItem?: BacklogItem): Run | undefined {
  const matches = runs.filter((run) => runMatchesNode(run, node, backlogItem));
  return (
    matches.find((run) => !isTerminalRunStatus(run.status)) ??
    matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  );
}

function queueSlotIds(item: QueueItem, slots: SlotStatus[]): string[] {
  if (item.slotId) return [item.slotId];
  if (item.allowedSlots?.length) return item.allowedSlots;
  return slots.filter((slot) => slot.project === item.project).map((slot) => slot.slot);
}

function buildSlotViews(
  project: string,
  allowedSlots: string[] | null | undefined,
  slots: SlotStatus[],
  queueItem?: QueueItem,
  run?: Run,
): SlotExecutionView[] {
  const wantedIds = queueItem
    ? new Set(queueSlotIds(queueItem, slots))
    : allowedSlots?.length
      ? new Set(allowedSlots)
      : null;
  return slots
    .filter((slot) => slot.project === project && (!wantedIds || wantedIds.has(slot.slot)))
    .map((slot) => ({
      slotId: slot.slot,
      project: slot.project,
      lifecycle: slot.lifecycle,
      phase: slot.phase,
      ready: isVisibleSlotReady(slot),
      reason: slotReason(slot),
      queueItemIds:
        queueItem && queueSlotIds(queueItem, slots).includes(slot.slot) ? [queueItem.id] : [],
      runIds: run?.slotId === slot.slot ? [run.id] : [],
    }));
}

function pushBlocker(
  blockers: WorkGraphNodeBlocker[],
  blocker: WorkGraphNodeBlocker,
): WorkGraphNodeBlocker[] {
  blockers.push(blocker);
  return blockers;
}

function statusForRun(run: Run): WorkGraphExecutionStatus {
  if (run.status === 'done') return 'succeeded';
  if (run.status === 'failed' || run.status === 'cancelled') return 'failed';
  if (run.status === 'blocked' || run.status === 'human-gating') return 'gated';
  if (run.status === 'dispatching' || run.status === 'preparing') return 'dispatching';
  return 'running';
}

function terminalNodeStatus(status: WorkNodeStatus): WorkGraphExecutionStatus | null {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'skipped') return 'skipped';
  return null;
}

export function buildWorkGraphExecutionOverlay(
  input: WorkGraphExecutionOverlayInput,
): WorkGraphExecutionOverlay {
  const backlogById = new Map(input.backlogItems.map((item) => [item.id, item]));
  const views = input.graph.nodes.map((node): WorkGraphNodeExecutionView => {
    const backlogItem = node.backlogItemId ? backlogById.get(node.backlogItemId) : undefined;
    const queueItem = input.queueItems.find((item) => queueMatchesNode(item, node, backlogItem));
    const run = chooseRun(input.runs, node, backlogItem);
    const project = projectForNode(input.graph, node, backlogItem);
    const blockers: WorkGraphNodeBlocker[] = [];
    const visibleCandidateSlots = buildSlotViews(
      project,
      backlogItem?.allowedSlots,
      input.slots,
      queueItem,
      run,
    );
    const invalidAllowedSlots = backlogItem?.allowedSlots?.filter(
      (slotId) =>
        !input.slots.some((slot) => slot.slot === slotId && slot.project === backlogItem.project),
    );

    if (node.kind === 'reference') {
      const status = node.reference?.status ?? 'unknown';
      return {
        graphId: input.graph.graph.id,
        nodeId: node.id,
        kind: node.kind,
        title: titleForNode(node),
        project,
        graphStatus: node.status,
        executionStatus: 'reference',
        summary: `Reference ${status}`,
        blockers:
          status === 'satisfied' || status === 'waived'
            ? []
            : pushBlocker(blockers, {
                kind: 'reference',
                severity: status === 'failed' || status === 'blocked' ? 'blocking' : 'info',
                message: `Reference is ${status}.`,
              }),
        visibleCandidateSlots: [],
        editableConfig: false,
      };
    }

    if (!backlogItem) {
      return {
        graphId: input.graph.graph.id,
        nodeId: node.id,
        kind: node.kind,
        title: titleForNode(node),
        project,
        graphStatus: node.status,
        executionStatus: 'config-blocked',
        summary: 'Missing linked backlog item.',
        blockers: [
          { kind: 'config', severity: 'blocking', message: 'Missing linked backlog item.' },
        ],
        visibleCandidateSlots,
        editableConfig: false,
      };
    }

    if (backlogItem.allowedSlots && backlogItem.allowedSlots.length === 0) {
      blockers.push({
        kind: 'config',
        severity: 'blocking',
        message: 'Allowed slots cannot be empty.',
      });
    }
    for (const slotId of invalidAllowedSlots ?? []) {
      blockers.push({
        kind: 'config',
        severity: 'blocking',
        message: `Allowed slot ${slotId} is missing or belongs to another project.`,
        slotId,
      });
    }

    const terminalStatus = terminalNodeStatus(node.status);
    if (terminalStatus) {
      if (queueItem || (run && !isTerminalRunStatus(run.status))) {
        blockers.push({
          kind: queueItem ? 'queue' : 'run',
          severity: 'warning',
          message: 'Terminal graph node still has live queue/run linkage.',
          queueItemId: queueItem?.id,
          runId: run?.id,
        });
        return {
          graphId: input.graph.graph.id,
          nodeId: node.id,
          kind: node.kind,
          title: titleForNode(node, backlogItem),
          project,
          graphStatus: node.status,
          executionStatus: 'needs-attention',
          summary: 'Terminal graph node has live execution linkage.',
          blockers,
          backlogItem,
          queueItem,
          run,
          visibleCandidateSlots,
          editableConfig: false,
        };
      }
      return {
        graphId: input.graph.graph.id,
        nodeId: node.id,
        kind: node.kind,
        title: titleForNode(node, backlogItem),
        project,
        graphStatus: node.status,
        executionStatus: terminalStatus,
        summary: `Graph node ${terminalStatus}.`,
        blockers,
        backlogItem,
        queueItem,
        run,
        visibleCandidateSlots,
        editableConfig: false,
      };
    }

    if (blockers.some((blocker) => blocker.severity === 'blocking')) {
      return {
        graphId: input.graph.graph.id,
        nodeId: node.id,
        kind: node.kind,
        title: titleForNode(node, backlogItem),
        project,
        graphStatus: node.status,
        executionStatus: 'config-blocked',
        summary: blockers[0]?.message ?? 'Dispatch config blocked.',
        blockers,
        backlogItem,
        queueItem,
        run,
        visibleCandidateSlots,
        editableConfig: !queueItem && !run,
      };
    }

    if (node.status === 'needs-attention') {
      blockers.push(
        ...node.waitingOn.map((reason) => ({
          kind: 'policy' as const,
          severity: 'blocking' as const,
          message: reason.detail,
        })),
      );
      if (backlogItem.lastDispatchError) {
        blockers.push({
          kind: 'policy',
          severity: 'blocking',
          message: backlogItem.lastDispatchError,
        });
      }
      return {
        graphId: input.graph.graph.id,
        nodeId: node.id,
        kind: node.kind,
        title: titleForNode(node, backlogItem),
        project,
        graphStatus: node.status,
        executionStatus: 'needs-attention',
        summary: blockers[0]?.message ?? 'Graph node needs operator attention.',
        blockers,
        backlogItem,
        queueItem,
        run,
        visibleCandidateSlots,
        editableConfig: !queueItem && !run,
      };
    }

    if (run && !isTerminalRunStatus(run.status)) {
      const executionStatus = statusForRun(run);
      return {
        graphId: input.graph.graph.id,
        nodeId: node.id,
        kind: node.kind,
        title: titleForNode(node, backlogItem),
        project,
        graphStatus: node.status,
        executionStatus,
        summary: run.slotId
          ? `${executionStatus} on ${run.slotId}${run.metrics.runner ? ` with ${run.metrics.runner}${run.metrics.model ? `/${run.metrics.model}` : ''}` : ''}.`
          : `${executionStatus}.`,
        blockers,
        backlogItem,
        queueItem,
        run,
        visibleCandidateSlots,
        editableConfig: false,
      };
    }

    if (queueItem) {
      const blockedSlots = visibleCandidateSlots.filter((slot) => !slot.ready);
      const hasReadySlot = visibleCandidateSlots.some((slot) => slot.ready);
      if (visibleCandidateSlots.length === 0) {
        blockers.push({
          kind: 'slot-unavailable',
          severity: 'blocking',
          message: 'No visible allowed slots match this queued work.',
          queueItemId: queueItem.id,
        });
      }
      if (blockedSlots.length > 0 && !hasReadySlot) {
        blockers.push(
          ...blockedSlots.map((slot) => ({
            kind: 'slot-busy' as const,
            severity: 'blocking' as const,
            message: `${slot.slotId}: ${slot.reason}`,
            slotId: slot.slotId,
            queueItemId: queueItem.id,
          })),
        );
      }
      return {
        graphId: input.graph.graph.id,
        nodeId: node.id,
        kind: node.kind,
        title: titleForNode(node, backlogItem),
        project,
        graphStatus: node.status,
        executionStatus: !hasReadySlot ? 'waiting-for-slot' : 'queued',
        summary: !hasReadySlot
          ? `Queued; waiting for visible allowed slot.`
          : `Queued with priority ${queueItem.priority}.`,
        blockers,
        backlogItem,
        queueItem,
        run,
        visibleCandidateSlots,
        editableConfig: false,
      };
    }

    if (node.waitingOn.length > 0 || node.status === 'waiting') {
      blockers.push(
        ...node.waitingOn.map((reason) => ({
          kind: 'dependency' as const,
          severity: 'blocking' as const,
          message: reason.detail,
        })),
      );
      return {
        graphId: input.graph.graph.id,
        nodeId: node.id,
        kind: node.kind,
        title: titleForNode(node, backlogItem),
        project,
        graphStatus: node.status,
        executionStatus: 'dependency-blocked',
        summary: blockers[0]?.message ?? 'Waiting on dependency.',
        blockers,
        backlogItem,
        visibleCandidateSlots,
        editableConfig: true,
      };
    }

    if (backlogItem.status !== 'ready') {
      blockers.push({
        kind: 'backlog-status',
        severity: 'blocking',
        message: `Backlog item is ${backlogItem.status}.`,
      });
      return {
        graphId: input.graph.graph.id,
        nodeId: node.id,
        kind: node.kind,
        title: titleForNode(node, backlogItem),
        project,
        graphStatus: node.status,
        executionStatus: 'config-blocked',
        summary: `Backlog item is ${backlogItem.status}.`,
        blockers,
        backlogItem,
        visibleCandidateSlots,
        editableConfig: true,
      };
    }

    return {
      graphId: input.graph.graph.id,
      nodeId: node.id,
      kind: node.kind,
      title: titleForNode(node, backlogItem),
      project,
      graphStatus: node.status,
      executionStatus: 'ready',
      summary: 'Ready: all required start edges are satisfied.',
      blockers,
      backlogItem,
      run,
      visibleCandidateSlots,
      editableConfig: true,
    };
  });
  return { nodes: views, byNodeId: new Map(views.map((view) => [view.nodeId, view])) };
}

function queueTargetsSlot(item: QueueItem, slot: SlotStatus): boolean {
  if (item.slotId) return item.slotId === slot.slot;
  if (item.allowedSlots?.length) return item.allowedSlots.includes(slot.slot);
  return item.project === slot.project;
}

function queueTitle(item: QueueItem, backlogById: Map<string, BacklogItem>): string {
  if (item.backlogItemId)
    return backlogById.get(item.backlogItemId)?.title ?? item.label ?? item.ticketOrPr;
  return item.label ?? item.ticketOrPr;
}

export function buildSlotPendingWork(params: {
  slots: SlotStatus[];
  queueItems: QueueItem[];
  runs: Run[];
  backlogItems: BacklogItem[];
  workGraphs: WorkGraphProjection[];
  includeSchedulerReady?: boolean;
}): Map<string, SlotPendingWork> {
  const backlogById = new Map(params.backlogItems.map((item) => [item.id, item]));
  const result = new Map<string, SlotPendingWork>();
  for (const slot of params.slots) {
    result.set(slot.slot, { slotId: slot.slot, queued: [], running: [], schedulerReady: [] });
  }
  for (const item of params.queueItems) {
    for (const slot of params.slots) {
      if (!queueTargetsSlot(item, slot)) continue;
      result.get(slot.slot)?.queued.push({
        id: item.id,
        title: queueTitle(item, backlogById),
        project: item.project,
        kind: 'queued',
        graphId: item.workGraphId,
        nodeId: item.workNodeId,
        queueItemId: item.id,
      });
    }
  }
  for (const run of params.runs) {
    if (!run.slotId || isTerminalRunStatus(run.status)) continue;
    result.get(run.slotId)?.running.push({
      id: run.id,
      title: backlogById.get(run.backlogItemId ?? '')?.title ?? run.summary ?? run.ticketOrPr,
      project: run.project,
      kind: 'running',
      graphId: run.workGraphId,
      nodeId: run.workNodeId,
      runId: run.id,
    });
  }
  if (params.includeSchedulerReady) {
    for (const graph of params.workGraphs) {
      const overlay = buildWorkGraphExecutionOverlay({
        graph,
        backlogItems: params.backlogItems,
        queueItems: params.queueItems,
        runs: params.runs,
        slots: params.slots,
      });
      for (const node of overlay.nodes) {
        if (node.executionStatus !== 'ready') continue;
        for (const slot of node.visibleCandidateSlots.filter((candidate) => candidate.ready)) {
          result.get(slot.slotId)?.schedulerReady.push({
            id: `${node.graphId}:${node.nodeId}`,
            title: node.title,
            project: node.project,
            kind: 'scheduler-ready',
            graphId: node.graphId,
            nodeId: node.nodeId,
          });
        }
      }
    }
  }
  return result;
}
