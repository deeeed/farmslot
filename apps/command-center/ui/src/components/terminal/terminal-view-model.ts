import type { AgentRole, TmuxWorkerRef } from '@farmslot/protocol';

export interface TerminalTargetState {
  slotId: string;
  runId: string;
  role: AgentRole | '';
  contextId: string;
  worker: TmuxWorkerRef | null;
  postmortem: boolean;
}

export interface TerminalTargetPayload {
  slotId?: string;
  worker?: TmuxWorkerRef;
  runId?: string | null;
  role?: AgentRole;
  contextId?: string;
}

export interface TerminalTargetIdentity {
  slotId: string;
  runId: string;
  role: AgentRole | '';
  contextId: string;
  workerRefJson: string;
}

export interface TerminalOsc52Extraction {
  data: string;
  clipboardTexts: string[];
  decodeErrors: unknown[];
}

export interface TerminalRoleExitDecision {
  elapsedSinceOk: number;
  nonZero: boolean;
  roleBound: boolean;
  fastFail: boolean;
  shouldLogRoleExit: boolean;
  shouldEnterPostmortem: boolean;
}

const TERMINAL_TARGET_KEYS: Array<keyof TerminalTargetIdentity> = [
  'slotId',
  'runId',
  'role',
  'contextId',
  'workerRefJson',
];

export function parseWorkerRef(value: string): TmuxWorkerRef | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TmuxWorkerRef> | null;
    if (!parsed?.nodeId || !parsed.session || !parsed.target) return null;
    return {
      nodeId: parsed.nodeId,
      session: parsed.session,
      target: parsed.target,
      ...(parsed.window ? { window: parsed.window } : {}),
      ...(parsed.windowName ? { windowName: parsed.windowName } : {}),
      ...(parsed.pane ? { pane: parsed.pane } : {}),
      ...(parsed.paneId ? { paneId: parsed.paneId } : {}),
    };
  } catch (err) {
    // Worker refs come from route/local UI state. A malformed value is recoverable.
    console.warn('[terminal-view] ignoring malformed worker ref', err);
    return null;
  }
}

export function workerRefsMatch(a: TmuxWorkerRef | undefined, b: TmuxWorkerRef | null): boolean {
  return Boolean(a && b && a.nodeId === b.nodeId && a.target === b.target);
}

export function terminalHasTarget(state: Pick<TerminalTargetState, 'slotId' | 'worker'>): boolean {
  return Boolean(state.slotId || state.worker);
}

export function terminalTargetLabel(state: Pick<TerminalTargetState, 'slotId' | 'worker'>): string {
  return state.worker
    ? `${state.worker.nodeId}:${state.worker.session}`
    : state.slotId || 'No terminal';
}

export function terminalTargetParams(state: TerminalTargetState) {
  if (state.worker) return { worker: state.worker };
  // Postmortem: subscribe attached to the bare PTY, so input/resize MUST also route bare.
  // Without `bareSession: true` the gateway resolves slot-only requests through the still-
  // active blocked run's primary role, leaving the postmortem terminal effectively read-only.
  if (state.postmortem) return { slotId: state.slotId, bareSession: true as const };
  return {
    slotId: state.slotId,
    ...(state.runId ? { runId: state.runId } : {}),
    ...(state.role ? { role: state.role } : {}),
    ...(state.contextId ? { contextId: state.contextId } : {}),
  };
}

export function terminalMatchesTarget(
  state: TerminalTargetState,
  payload: TerminalTargetPayload,
): boolean {
  if (state.worker) return workerRefsMatch(payload.worker, state.worker);
  if (!payload.slotId || payload.slotId !== state.slotId) return false;
  if (state.postmortem) return true;
  if (state.runId && (!('runId' in payload) || payload.runId !== state.runId)) return false;
  if (state.contextId && payload.contextId && payload.contextId !== state.contextId) return false;
  if (state.role && payload.role && payload.role !== state.role) return false;
  return true;
}

export function terminalTargetChanged(
  changed: Map<string, unknown>,
  current: TerminalTargetIdentity,
): boolean {
  return TERMINAL_TARGET_KEYS.some((key) => {
    if (!changed.has(key)) return false;
    const oldVal = (changed.get(key) as string | undefined) ?? '';
    return oldVal !== current[key];
  });
}

/** Build the pre-update terminal identity from Lit's changed-property map. */
export function terminalPriorTargetIdentity(
  changed: Map<string, unknown>,
  current: TerminalTargetIdentity,
): TerminalTargetIdentity {
  const read = (key: keyof TerminalTargetIdentity) =>
    changed.has(key) ? ((changed.get(key) as string | undefined) ?? '') : current[key];
  return {
    slotId: read('slotId'),
    runId: read('runId'),
    role: read('role') as TerminalTargetIdentity['role'],
    contextId: read('contextId'),
    workerRefJson: read('workerRefJson'),
  };
}

/** Pick the unsubscribe target during debounced target churn. */
export function terminalTeardownTarget(
  activeIdentity: TerminalTargetIdentity | null,
  activePostmortem: boolean,
  priorTarget: TerminalTargetIdentity,
  priorPostmortem: boolean,
): { target: TerminalTargetIdentity; postmortem: boolean } {
  return {
    target: activeIdentity ?? priorTarget,
    postmortem: activeIdentity ? activePostmortem : priorPostmortem,
  };
}

export function terminalTargetStateFromIdentity(
  identity: TerminalTargetIdentity,
  opts: { postmortem?: boolean; worker?: TmuxWorkerRef | null } = {},
): TerminalTargetState {
  return {
    slotId: identity.slotId,
    runId: identity.runId,
    role: identity.role as TerminalTargetState['role'],
    contextId: identity.contextId,
    worker: opts.worker ?? parseWorkerRef(identity.workerRefJson),
    postmortem: opts.postmortem ?? false,
  };
}

export function terminalRoleExitDecision(params: {
  exitCode: number | undefined;
  subscribeOkAt: number;
  nowMs: number;
  fastFailMs: number;
  role: AgentRole | '';
  contextId: string;
  postmortem: boolean;
}): TerminalRoleExitDecision {
  const elapsedSinceOk = params.subscribeOkAt > 0 ? params.nowMs - params.subscribeOkAt : -1;
  const nonZero = params.exitCode !== 0 && params.exitCode !== undefined;
  const roleBound = Boolean(params.role || params.contextId);
  const fastFail = nonZero && params.subscribeOkAt > 0 && elapsedSinceOk < params.fastFailMs;
  const activeRoleBinding = roleBound && !params.postmortem;
  return {
    elapsedSinceOk,
    nonZero,
    roleBound,
    fastFail,
    shouldLogRoleExit: nonZero && activeRoleBinding,
    shouldEnterPostmortem: fastFail && activeRoleBinding,
  };
}

export function extractOsc52Clipboard(
  data: string,
  decodeBase64: (value: string) => string,
): TerminalOsc52Extraction {
  const clipboardTexts: string[] = [];
  const decodeErrors: unknown[] = [];
  const strippedData = data.replace(
    /\x1b\]52;([^;]*);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g,
    (_match, _selection, encoded) => {
      try {
        const text = decodeBase64(encoded);
        if (text) clipboardTexts.push(text);
      } catch (err) {
        decodeErrors.push(err);
      }
      return '';
    },
  );

  return { data: strippedData, clipboardTexts, decodeErrors };
}
