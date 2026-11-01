import type {
  AgentContext,
  AgentContextTarget,
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
  /** The slot's own shell rather than its run's agent (a native run's slot shell). */
  shell?: boolean;
}

export type TerminalWorkerResolution =
  /** `target` is the same pane as the gateway knows it: Send and reinit use it. */
  | { status: 'ready'; worker: TmuxWorkerRef; target: SlotAgentTargetParams }
  /** A native conversation, not a tmux pane: it opens in the conversation screen. */
  | { status: 'native' }
  /** The pane is found by the machine's inventory, which has not been read yet. */
  | { status: 'needs-inventory'; machine: string; target: SlotAgentTargetParams }
  /** The inventory lists no pane for this target: its session may need creating. */
  | { status: 'no-pane'; machine: string; hidden: boolean; target: SlotAgentTargetParams }
  | { status: 'waiting'; reason: string }
  | { status: 'unavailable'; reason: string };

const PANE_ID = /^%\d+$/;

/**
 * Picks the tmux pane a terminal link names, on the client, and the slot target for the same
 * actor, so the pane shown, the keys typed and Send all reach one agent. An agent context that
 * recorded its pane id needs nothing else; one that recorded only its window is found in that
 * window; a bare slot or review worktree is the pane the machine's inventory links to it.
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
  // An actor pin is never answered by another actor, even when its run cannot be read.
  if ((selector.contextId || selector.role) && !run)
    return { status: 'unavailable', reason: 'Run unavailable' };
  const review = !slotId && run?.reviewWorkspace && !run.reviewWorkspace.cleanedAt ? run : null;
  if (!slotId && !review) return { status: 'unavailable', reason: 'No terminal for this run.' };
  const machine = review ? review.reviewWorkspace!.machine : slotMachine;
  if (!machine) return { status: 'waiting', reason: 'Loading slot…' };

  const bare = !review && (Boolean(selector.shell) || bareSlotSession(selector, run));
  let context: AgentContext | null = null;
  if (run && !bare && !review) {
    const view = runTerminalView(run, selector.contextId);
    if (selector.contextId && !view.context)
      return { status: 'unavailable', reason: view.disabledReason ?? 'Session gone.' };
    const contexts = run.agentContexts ?? [];
    context =
      selector.role && !selector.contextId && view.context?.role !== selector.role
        ? (contexts.find((entry) => entry.role === selector.role) ?? null)
        : view.context;
    if (selector.role && !context) return { status: 'unavailable', reason: 'Session gone.' };
    if (
      (context && nativeWorkerTarget(contexts, context)) ||
      (run.transport === 'native' && !context?.target)
    )
      return { status: 'native' };
  }
  const target: SlotAgentTargetParams = review
    ? { slotId: '', runId: review.id }
    : bare
      ? { slotId, bareSession: true }
      : {
          slotId,
          ...(run ? { runId: run.id } : {}),
          ...(context ? { contextId: context.id, role: context.role } : {}),
        };

  const recorded = context?.target ?? null;
  if (recorded?.paneId && PANE_ID.test(recorded.paneId))
    return { status: 'ready', worker: recordedPane(machine, recorded), target };

  if (!inventory) return { status: 'needs-inventory', machine, target };
  const node = inventory.nodes.find((entry) => entry.nodeId === machine);
  if (!node?.ok) return { status: 'unavailable', reason: `${machine} offline` };
  let candidates: TmuxWorkerSummary[];
  if (recorded) {
    // A context without a pane id names its window: only a pane there is that actor.
    candidates = node.workers.filter((pane) => inRecordedWindow(pane.ref, recorded));
    if (!candidates.length) return { status: 'unavailable', reason: 'Window not open' };
  } else {
    const linked = node.workers.filter((pane) =>
      review ? pane.linkedRunId === review.id : pane.linkedSlotId === slotId,
    );
    const ofRun = run && !bare ? linked.filter((pane) => pane.linkedRunId === run.id) : [];
    candidates = ofRun.length ? ofRun : linked;
  }
  const pane = bestPane(candidates);
  if (!pane) return { status: 'no-pane', machine, hidden: Boolean(node.hiddenWorkers), target };
  return { status: 'ready', worker: pane.ref, target };
}

function recordedPane(machine: string, recorded: AgentContextTarget): TmuxWorkerRef {
  return {
    nodeId: machine,
    session: recorded.session,
    ...(recorded.window ? { window: recorded.window } : {}),
    ...(recorded.pane ? { pane: recorded.pane } : {}),
    paneId: recorded.paneId!,
    target: recorded.paneId!,
  };
}

function inRecordedWindow(ref: TmuxWorkerRef, recorded: AgentContextTarget): boolean {
  if (ref.session !== recorded.session) return false;
  const window = recorded.window;
  if (window && ref.window !== window && ref.windowName !== window) return false;
  return !recorded.pane || ref.pane === recorded.pane;
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
 * The target a link asks for before it resolves, as the gateway takes it: what an unresolved or
 * refused link reports. A resolved link uses the resolution's own `target`.
 */
export function slotTerminalTarget(
  selector: TerminalSelector,
  run: Run | null,
): SlotAgentTargetParams {
  const slotId = selector.slotId ?? '';
  if (!slotId) return { slotId: '', ...(selector.runId ? { runId: selector.runId } : {}) };
  if (selector.shell || bareSlotSession(selector, run)) return { slotId, bareSession: true };
  return {
    slotId,
    ...(selector.runId ? { runId: selector.runId } : {}),
    ...(selector.contextId ? { contextId: selector.contextId } : {}),
    ...(selector.role ? { role: selector.role } : {}),
  };
}
