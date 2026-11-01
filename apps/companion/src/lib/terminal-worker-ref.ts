import type {
  AgentRole,
  Run,
  SlotAgentTargetParams,
  TmuxWorkerListResult,
  TmuxWorkerRef,
  TmuxWorkerSummary,
} from '@farmslot/protocol';
import { nativeWorkerTarget, runTerminalView } from '@farmslot/review-dispatch';

import { shouldUseBareTerminalSessionForRun } from './terminal-target';

/** What a slot, run or decision link asks for; the terminal resolves it to one tmux pane. */
export interface TerminalSelector {
  slotId?: string;
  runId?: string;
  contextId?: string;
  role?: AgentRole;
}

export type TerminalWorkerResolution =
  | { status: 'ready'; worker: TmuxWorkerRef }
  /** A native conversation, not a tmux pane: it opens in the conversation screen. */
  | { status: 'native' }
  /** The pane is found by the machine's inventory, which has not been read yet. */
  | { status: 'needs-inventory'; machine: string }
  /** The inventory lists no pane for this target: its session may need creating. */
  | { status: 'no-pane'; machine: string; hidden: boolean }
  | { status: 'waiting'; reason: string }
  | { status: 'unavailable'; reason: string };

const PANE_ID = /^%\d+$/;

/**
 * Picks the tmux pane a terminal link names, on the client. An agent context that recorded its
 * pane id needs nothing else; a bare slot, a review worktree, or a context without a pane id is
 * found in that one machine's inventory by the panes the gateway links to the slot or run.
 * `run` is undefined while it is still loading and null when there is none.
 */
export function resolveTerminalWorkerRef({
  selector,
  run,
  slotMachine,
  inventory,
}: {
  selector: TerminalSelector;
  run: Run | null | undefined;
  slotMachine: string | undefined;
  inventory: TmuxWorkerListResult | undefined;
}): TerminalWorkerResolution {
  const slotId = selector.slotId ?? '';
  if (run === undefined) return { status: 'waiting', reason: 'Loading…' };
  const review = !slotId && run?.reviewWorkspace && !run.reviewWorkspace.cleanedAt ? run : null;
  if (!slotId && !review) return { status: 'unavailable', reason: 'No terminal for this run.' };
  const machine = review ? review.reviewWorkspace!.machine : slotMachine;
  if (!machine) return { status: 'waiting', reason: 'Loading slot…' };

  const bare = !review && bareSlotSession(selector, run);
  let session: string | undefined;
  if (run && !bare) {
    const view = runTerminalView(run, selector.contextId);
    if (selector.contextId && !view.context)
      return { status: 'unavailable', reason: view.disabledReason ?? 'Session gone.' };
    const contexts = run.agentContexts ?? [];
    const context =
      selector.role && !selector.contextId && view.context?.role !== selector.role
        ? (contexts.find((entry) => entry.role === selector.role) ?? null)
        : view.context;
    if (selector.role && !context) return { status: 'unavailable', reason: 'Session gone.' };
    if (
      (context && nativeWorkerTarget(contexts, context)) ||
      (run.transport === 'native' && !context?.target)
    )
      return { status: 'native' };
    const target = context?.target;
    if (target?.paneId && PANE_ID.test(target.paneId))
      return {
        status: 'ready',
        worker: {
          nodeId: machine,
          session: target.session,
          ...(target.window ? { window: target.window } : {}),
          ...(target.pane ? { pane: target.pane } : {}),
          paneId: target.paneId,
          target: target.paneId,
        },
      };
    session = target?.session;
  }

  if (!inventory) return { status: 'needs-inventory', machine };
  const node = inventory.nodes.find((entry) => entry.nodeId === machine);
  if (!node?.ok) return { status: 'unavailable', reason: `${machine} offline` };
  const linked = node.workers.filter((pane) =>
    review ? pane.linkedRunId === review.id : pane.linkedSlotId === slotId,
  );
  const ofRun = run && !bare ? linked.filter((pane) => pane.linkedRunId === run.id) : [];
  const inSession = session ? linked.filter((pane) => pane.ref.session === session) : [];
  const pane = bestPane(inSession.length ? inSession : ofRun.length ? ofRun : linked);
  if (!pane) return { status: 'no-pane', machine, hidden: Boolean(node.hiddenWorkers) };
  return { status: 'ready', worker: pane.ref };
}

/**
 * A finished or moved run opens its slot's own session; an explicit actor pin (context or role)
 * never falls back to it.
 */
function bareSlotSession(selector: TerminalSelector, run: Run | null): boolean {
  return (
    Boolean(selector.slotId) &&
    !selector.contextId &&
    !selector.role &&
    shouldUseBareTerminalSessionForRun({
      requestedRunId: selector.runId,
      requestedSlotId: selector.slotId ?? '',
      run,
    })
  );
}

/** The pane running the worker first, then the session's active pane. */
function bestPane(panes: TmuxWorkerSummary[]): TmuxWorkerSummary | undefined {
  return (
    panes.find((pane) => pane.linkedRunner) ?? panes.find((pane) => pane.active) ?? panes[0]
  );
}

/**
 * The slot-addressed target the gateway still takes for `terminal.reinit` (which creates a
 * missing slot or worktree session and keeps an existing one) and for `terminal.send` (the
 * runner's own submission of a message).
 */
export function slotTerminalTarget(
  selector: TerminalSelector,
  run: Run | null,
): SlotAgentTargetParams {
  const slotId = selector.slotId ?? '';
  if (!slotId) return { slotId: '', ...(selector.runId ? { runId: selector.runId } : {}) };
  if (bareSlotSession(selector, run)) return { slotId, bareSession: true };
  return {
    slotId,
    ...(selector.runId ? { runId: selector.runId } : {}),
    ...(selector.contextId ? { contextId: selector.contextId } : {}),
    ...(selector.role ? { role: selector.role } : {}),
  };
}
