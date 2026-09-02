import type { Run } from '@farmslot/protocol';
import { resolveRunSlotId } from '@farmslot/protocol';

import {
  activePublicationReviewLabel,
  compactHumanGateLabel,
} from '../../utils/review-gate-display.js';
import type { WorkInventoryColumnDef } from '../shared/work-inventory-table.js';

import { isInteractiveCompletionAwaitingOperator } from './run-detail-model.js';

export const RUN_INVENTORY_SORT_KEYS = [
  'status',
  'flow',
  'project',
  'ref',
  'slot',
  'runner',
  'updated',
  'pipeline',
] as const;
export type RunInventorySortKey = (typeof RUN_INVENTORY_SORT_KEYS)[number];

export const RUN_INVENTORY_COLUMNS: WorkInventoryColumnDef<RunInventorySortKey>[] = [
  { key: 'status', label: 'Lifecycle', width: '100px', testId: 'runs-sort-status' },
  { key: 'flow', label: 'Flow', width: '58px', testId: 'runs-sort-flow' },
  { key: 'project', label: 'Project', width: 'minmax(100px, 140px)', testId: 'runs-sort-project' },
  { key: 'ref', label: 'Ref', width: '110px', testId: 'runs-sort-ref' },
  { key: 'slot', label: 'Slot', width: '120px', testId: 'runs-sort-slot' },
  { key: 'runner', label: 'Runner / model', width: '140px', testId: 'runs-sort-runner' },
  { key: 'updated', label: 'Updated', width: '86px', testId: 'runs-sort-updated' },
  {
    key: 'pipeline',
    label: 'Pipeline / review',
    width: 'minmax(140px, 1fr)',
    sortable: false,
    testId: 'runs-pipeline-col',
  },
];

export function runInventorySortValue(run: Run, key: RunInventorySortKey): string {
  switch (key) {
    case 'status':
      return run.status;
    case 'flow':
      return run.flowType;
    case 'project':
      return run.project;
    case 'ref':
      return run.ticketOrPr;
    case 'slot':
      return resolveRunSlotId(run) ?? '';
    case 'runner':
      return `${run.metrics?.runner ?? ''} ${run.metrics?.model ?? ''}`.trim();
    case 'updated':
      return run.updatedAt;
    case 'pipeline':
      return compactRunPipelineLabel(run);
  }
}

/**
 * Compact pipeline/review label for inventory cells.
 * Active independent review must never read as a human publication gate.
 */
export function compactRunPipelineLabel(run: Run): string {
  const activeReview = activePublicationReviewLabel(run);
  if (activeReview) return activeReview;
  if (isInteractiveCompletionAwaitingOperator(run)) return 'awaiting operator action';
  if (run.status === 'human-gating') return compactHumanGateLabel(run);
  const running = run.steps?.find((step) => step.status === 'running');
  if (running) return running.name;
  return run.status;
}

/**
 * True when the inventory/pipeline label honestly reports independent review
 * work rather than collapsing it into a generic human-gate label.
 */
export function isIndependentReviewLabel(label: string): boolean {
  const normalized = label.toLowerCase();
  return normalized.includes('independent review');
}

export function isHumanPublicationGateLabel(label: string): boolean {
  const normalized = label.toLowerCase();
  return (
    normalized === 'operator gate' ||
    normalized === 'publish ready' ||
    normalized === 'human gate' ||
    normalized === 'human-gating'
  );
}
