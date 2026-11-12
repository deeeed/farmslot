import {
  deriveRunLifecycleView,
  isSlotFreedByPark,
  isTerminalRunStatus,
  type RunLifecycleView,
  type RunListRow,
} from '@farmslot/protocol';
import { runActivityView, runTerminalView } from '@farmslot/review-dispatch';

/** What Run Detail's header shows: values a run.list row carries, so a held row paints it. */
export interface RunDetailHeaderModel {
  flowType: RunListRow['flowType'];
  status: RunListRow['status'];
  tone: RunLifecycleView['tone'];
  statusLabel: string;
  ticketOrPr: string;
  summary: string | null;
  slotId: string | null;
  slotFreedByPark: boolean;
  terminal: boolean;
  durationMs: number | undefined;
  /** The terminal tile between the title and the slot line. */
  terminalLabel: string;
  terminalValue: string;
  terminalDisabled: boolean;
  /** The QA profile line under the tile, when the run has one. */
  qaProfile: string | null;
}

/** The header from a run.list row or a full run: the same values from either. */
export function runDetailHeaderModel(run: RunListRow): RunDetailHeaderModel {
  const lifecycle = deriveRunLifecycleView(run);
  const terminal = runTerminalView(run);
  return {
    flowType: run.flowType,
    status: run.status,
    tone: lifecycle.tone,
    statusLabel: runActivityView(run)?.label ?? lifecycle.activityLabel ?? lifecycle.label,
    ticketOrPr: run.ticketOrPr,
    summary: run.summary ?? null,
    slotId: run.slotId,
    slotFreedByPark: isSlotFreedByPark(run),
    terminal: isTerminalRunStatus(run.status),
    durationMs: run.metrics?.durationMs,
    terminalLabel: terminal.label,
    terminalValue:
      terminal.disabledReason ??
      (terminal.target?.slotId ||
        terminal.context?.nativeSession?.executionNodeId ||
        run.reviewWorkspace?.machine ||
        'Current session'),
    terminalDisabled: Boolean(terminal.disabledReason),
    qaProfile: run.qa ? `${run.qa.profile.title} (${run.qa.profile.id})` : null,
  };
}
