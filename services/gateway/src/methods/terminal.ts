// methods/terminal.ts — terminal.subscribe/unsubscribe, terminal.send, terminal.snapshot, terminal.input, terminal.resize, terminal.reinit

import {
  AGENT_ROLES,
  type AgentRole,
  contextIdFor,
  type TerminalData,
  type TerminalInputParams,
  type TerminalReinitParams,
  type TerminalResizeParams,
  type TerminalSendParams,
  type TerminalSnapshotParams,
  type TerminalSnapshotResult,
  type TerminalSubscribeParams,
} from '@farmslot/protocol';

import { resolveAgentTarget } from '../agents/contexts.js';
import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { resolveTmuxSession, shellQuote, tmuxShellSnippet } from '../core/tmux.js';
import { getNode } from '../fleet/machine-registry.js';
import { getSlotLocality, sendNodeRequest } from '../fleet/node-rpc.js';
import { loadPoolConfigs } from '../fleet/state.js';
import {
  hasPty,
  type PtyAttachOptions,
  type PtyDataHandler,
  reinitTmuxSession,
  resizePty,
  subscribePty,
  unsubscribePty,
  writePty,
} from '../runtime/pty-stream.js';
import { sendKeys, snapshot, subscribe, unsubscribe } from '../runtime/tmux-stream.js';

type EventEmitter = (event: string, payload: unknown) => void;
type HasPtyFn = (key: string) => boolean;

export function terminalKey(params: {
  slotId: string;
  role?: string;
  contextId?: string;
  target?: string;
}): string {
  // 'primary' role uses bare slotId — same key as legacy (no dedicated window).
  // This prevents key collisions between legacy bare-slotId PTYs and new primary-role PTYs.
  if (params.contextId && params.contextId !== 'primary')
    return `${params.slotId}:${params.contextId}`;
  if (params.role && params.role !== 'primary') return `${params.slotId}:${params.role}`;
  return params.slotId;
}

const TERMINAL_KEY_ROLES = new Set<AgentRole>(AGENT_ROLES);

export function parseTerminalKey(key: string): {
  slotId: string;
  role?: AgentRole;
  contextId?: string;
} {
  const separator = key.indexOf(':');
  const slotId = separator === -1 ? key : key.slice(0, separator);
  const contextId = separator === -1 ? undefined : key.slice(separator + 1);
  if (!contextId) return { slotId };
  // 'primary' role uses bare slotId as key (see terminalKey) — treat 'slot:primary'
  // the same as bare 'slot' so the round-trip is consistent and exit events route
  // to the correct client identity lookup instead of falling into the broadcast path.
  if (contextId === 'primary') return { slotId };
  const role = TERMINAL_KEY_ROLES.has(contextId as AgentRole)
    ? (contextId as AgentRole)
    : undefined;
  return role ? { slotId, role, contextId: contextIdFor(role) } : { slotId, contextId };
}

export function terminalEventIdentity(params: {
  slotId: string;
  runId?: string | null;
  role?: AgentRole;
  contextId?: string | null;
}): { slotId: string; runId?: string; role?: AgentRole; contextId?: string } {
  return {
    slotId: params.slotId,
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.role ? { role: params.role } : {}),
    ...(params.contextId ? { contextId: params.contextId } : {}),
  };
}

export async function resolveTerminalKey(params: TerminalSubscribeParams): Promise<string> {
  const resolved = await resolveAgentOrBareTarget(params.slotId, params);
  return terminalKey({ ...params, role: resolved.role, contextId: resolved.contextId });
}

export function selectPtyKey(
  slotId: string,
  resolvedKey: string,
  hasPtyForKey: HasPtyFn,
): string | null {
  if (hasPtyForKey(resolvedKey)) return resolvedKey;
  // resolvedKey === slotId is the bare-session signature: role/context-scoped resolutions
  // always include a suffix (see terminalKey()), so this predicate inadvertently IS the
  // bare-mode check. Role/context callers therefore never accidentally route into another
  // client's lingering bare PTY.
  if (resolvedKey === slotId && hasPtyForKey(slotId)) return slotId;
  return null;
}

// Resolve slotId -> repo dir for tmux session working directory
async function resolveRepoDir(slotId: string): Promise<string | undefined> {
  const pools = await loadPoolConfigs();
  for (const pool of pools) {
    for (const slot of pool.slots) {
      if (slot.id === slotId) return slot.repo;
    }
  }
  return undefined;
}

async function isInteractiveTargetReady(
  slotId: string,
  target: string,
  session: string,
): Promise<boolean> {
  if (target === session) return true;
  const vars = await loadSlotVars(slotId);
  return (
    (
      await execOnSlot(
        vars,
        tmuxShellSnippet(
          `display-message -p -t ${shellQuote(target)} '#{session_name}' >/dev/null 2>&1`,
        ),
        { timeout: 5000 },
      )
    ).exitCode === 0
  );
}

async function assertInteractiveTargetReady(
  slotId: string,
  target: string,
  session: string,
  role?: AgentRole,
): Promise<void> {
  if (!(await isInteractiveTargetReady(slotId, target, session))) {
    const roleSuffix = role ? ` for role ${role}` : '';
    throw new Error(
      `Tmux target ${target}${roleSuffix} is not available yet; wait for that worker window to start and reopen the terminal.`,
    );
  }
}

async function resolveBareSession(slotId: string): Promise<{ target: string; session: string }> {
  const vars = await loadSlotVars(slotId);
  // Strict: use the slot's canonical session name (pool `session` field) and let
  // reinit create it. Repo-path discovery can attach to unrelated sessions in the
  // same worktree (e.g. farmslot-demo-banner-ff2) and stream garbage status UI.
  const session = await resolveTmuxSession(slotId, vars, { strict: true });
  return { target: session, session };
}

// Unified routing for any terminal/tmux method that accepts a SlotAgentTargetParams. When
// `bareSession: true` the agent-context lookup is skipped — required for postmortem callers
// whose subscribe attached to the bare PTY but whose subsequent input/resize would
// otherwise resolve to the active blocked run's primary role and silently miss the bare PTY.
export async function resolveAgentOrBareTarget(
  slotId: string,
  params: { bareSession?: boolean } & Parameters<typeof resolveAgentTarget>[1],
): Promise<{
  target: string;
  session: string;
  role?: AgentRole;
  contextId?: string;
  /** Only ever set by the agent-context branch; bare sessions have no context to read it from. */
  runner?: string;
}> {
  if (params?.bareSession === true) return resolveBareSession(slotId);
  return resolveAgentTarget(slotId, params);
}

export async function terminalSubscribe(
  params: TerminalSubscribeParams,
  emit: EventEmitter,
): Promise<{
  key: string;
  handler: (data: TerminalData) => void;
  ptyHandler?: PtyDataHandler;
  identity: ReturnType<typeof terminalEventIdentity>;
}> {
  // Bare-session mode skips agent-context resolution so a postmortem viewer can attach
  // to the slot's tmux session even after a blocked run's role pane is gone.
  const bare = params.bareSession === true;
  const resolved = await resolveAgentOrBareTarget(params.slotId, params);
  const target = resolved.target;
  // In bare mode the original run/role/contextId are intentionally dropped: the postmortem
  // attaches to the slot's session, not the (gone) role pane. Threading runId through would
  // route exit events to subscribers of a still-active later run reusing the same id.
  const role = bare ? undefined : resolved.role;
  const contextId = bare ? undefined : resolved.contextId;
  const key = terminalKey({ ...params, role, contextId });
  const eventIdentity = terminalEventIdentity({
    slotId: params.slotId,
    runId: bare ? undefined : params.runId,
    role,
    contextId,
  });
  const { isLocal: local, sshTarget } = await getSlotLocality(params.slotId);
  console.log(
    `[terminal] subscribe slot=${params.slotId} role=${role ?? '-'} bare=${bare} target=${target} interactive=${params.interactive} local=${local} ssh=${sshTarget || 'none'} cols=${params.cols} rows=${params.rows}`,
  );

  // Interactive PTY mode — local or remote via SSH
  if (params.interactive) {
    // Ensure the base tmux session exists before attaching to a role/window target.
    const repoDir = await resolveRepoDir(params.slotId);
    await reinitTmuxSession(resolved.session, repoDir, sshTarget);
    await assertInteractiveTargetReady(params.slotId, target, resolved.session, role);

    const ptyHandler: PtyDataHandler = (data: string) => {
      emit('terminal.data', {
        ...eventIdentity,
        data,
        timestamp: Date.now(),
      });
    };
    const ptyOpts: PtyAttachOptions = {};
    if (sshTarget) ptyOpts.sshTarget = sshTarget;
    if (target !== resolved.session) ptyOpts.selectTarget = target;
    subscribePty(key, resolved.session, ptyHandler, params.cols, params.rows, ptyOpts);
    emit('terminal.mode', { ...eventIdentity, mode: 'pty' });

    const handler = (_data: TerminalData) => {};
    return { key, handler, ptyHandler, identity: eventIdentity };
  }

  // Polling fallback (non-interactive only)
  console.log(`[terminal] falling back to poll mode for slot=${params.slotId}`);
  const handler = (data: TerminalData) => {
    emit('terminal.data', { ...data, ...eventIdentity });
  };
  subscribe(key, params.slotId, target, handler);
  emit('terminal.mode', { ...eventIdentity, mode: 'poll' });

  const lines = await snapshot(params.slotId, target, 200);
  if (lines.length > 0) {
    emit('terminal.data', {
      ...eventIdentity,
      data: lines.join('\n'),
      timestamp: Date.now(),
    });
  }

  return { key, handler, identity: eventIdentity };
}

export async function terminalUnsubscribe(
  params: TerminalSubscribeParams,
  handler: (data: TerminalData) => void,
  ptyHandler?: PtyDataHandler,
): Promise<void> {
  let key = terminalKey(params);
  try {
    key = await resolveTerminalKey(params);
  } catch (err) {
    // Fall back to the raw key; the session may already have been torn down.
    console.warn(
      `[terminal] failed to resolve unsubscribe key for ${params.slotId}: ${(err as Error).message}`,
    );
  }
  console.log(
    `[terminal] unsubscribe slot=${params.slotId} key=${key} hasPtyHandler=${!!ptyHandler}`,
  );
  if (ptyHandler) {
    unsubscribePty(key, ptyHandler);
  }
  unsubscribe(key, handler);
}

// Resolve slotId -> machine name
async function resolveMachine(slotId: string): Promise<string | undefined> {
  const pools = await loadPoolConfigs();
  for (const pool of pools) {
    for (const slot of pool.slots) {
      if (slot.id === slotId) return pool.machine;
    }
  }
  return undefined;
}

export async function terminalInput(params: TerminalInputParams): Promise<void> {
  const resolved = await resolveAgentOrBareTarget(params.slotId, params);
  const key = terminalKey({ ...params, role: resolved.role, contextId: resolved.contextId });
  // PTY mode: write directly to local pty
  const ptyKey = selectPtyKey(params.slotId, key, hasPty);
  if (ptyKey) {
    writePty(ptyKey, params.data);
    return;
  }
  // Poll mode (remote): send via agent tmux.send
  await assertInteractiveTargetReady(
    params.slotId,
    resolved.target,
    resolved.session,
    resolved.role,
  );
  const machine = await resolveMachine(params.slotId);
  if (machine && getNode(machine)) {
    await sendNodeRequest(getNode(machine)!, 'tmux.send', {
      session: resolved.target,
      text: params.data,
      enter: false,
    });
    return;
  }
  throw new Error(`No PTY or agent available for slot ${params.slotId}`);
}

export async function terminalResize(params: TerminalResizeParams): Promise<void> {
  const resolved = await resolveAgentOrBareTarget(params.slotId, params);
  const key = terminalKey({ ...params, role: resolved.role, contextId: resolved.contextId });
  const ptyKey = selectPtyKey(params.slotId, key, hasPty);
  if (ptyKey) resizePty(ptyKey, params.cols, params.rows);
}

export async function terminalReinit(
  params: TerminalReinitParams,
): Promise<{ reinitialized: boolean }> {
  const resolved = await resolveAgentOrBareTarget(params.slotId, params);
  const session = resolved.session;
  const repoDir = await resolveRepoDir(params.slotId);
  const { sshTarget } = await getSlotLocality(params.slotId);
  console.log(
    `[terminal] reinit slot=${params.slotId} session=${session} repoDir=${repoDir} ssh=${sshTarget || 'local'}`,
  );
  const ok = await reinitTmuxSession(session, repoDir, sshTarget);
  return { reinitialized: ok };
}

export async function terminalSend(params: TerminalSendParams): Promise<void> {
  const resolved = await resolveAgentOrBareTarget(params.slotId, params);
  await assertInteractiveTargetReady(
    params.slotId,
    resolved.target,
    resolved.session,
    resolved.role,
  );
  await sendKeys(
    params.slotId,
    resolved.target,
    params.text,
    params.enter ?? true,
    resolved.runner,
  );
}

export async function terminalSnapshot(
  params: TerminalSnapshotParams,
): Promise<TerminalSnapshotResult> {
  const resolved = await resolveAgentOrBareTarget(params.slotId, params);
  if (!(await isInteractiveTargetReady(params.slotId, resolved.target, resolved.session))) {
    return {
      slotId: params.slotId,
      role: resolved.role,
      contextId: resolved.contextId,
      lines: [],
      timestamp: Date.now(),
    };
  }
  const lines = await snapshot(params.slotId, resolved.target, params.lines ?? 200);
  return {
    slotId: params.slotId,
    role: resolved.role,
    contextId: resolved.contextId,
    lines,
    timestamp: Date.now(),
  };
}
