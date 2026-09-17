import { html, nothing } from 'lit';

import {
  type AgentContext,
  isTerminalRunStatus,
  type Run,
  type RunSessionCommandResult,
  type RunSessionLiveness,
} from '@farmslot/protocol';

import { colors, fonts } from '../../styles/theme-tokens.js';
import { slotViewHash } from '../slot-view/slot-view-url-state.js';

export type RunSessionCopyKind = 'reopen' | 'attach';

export interface RunSessionRowState {
  status: 'idle' | 'loading' | 'opening' | 'ready' | 'error';
  liveness?: RunSessionLiveness;
  copied?: RunSessionCopyKind;
  /** Exact command last copied for this row, so the operator can see what landed. */
  command?: string;
  /** Gateway machine this command must be pasted on. */
  machine?: string;
  slotId?: string;
  tmuxTarget?: string | null;
  ownership?: 'owned' | 'transferred' | 'unknown';
  ownerRunId?: string;
  message?: string;
  /**
   * The gateway answered but the browser refused the clipboard. A discrete flag
   * so callers never have to pattern-match the human-readable message.
   */
  copyBlocked?: true;
}

export interface RunSessionRow {
  nativeHref?: string;
  nativeHistory?: boolean;
  workspaceView?: boolean;
  contextId: string;
  role: AgentContext['role'];
  label: string;
  runner: string;
  model: string;
  sessionId: string | null;
  sessionIdShort: string | null;
  slotId: string | null;
  runId: string;
  target: string | null;
}

/** One row per agent context, in the order the run recorded them. */
export function runAgentSessionRows(run: Pick<Run, 'agentContexts' | 'metrics'>): RunSessionRow[] {
  return (run.agentContexts ?? []).map((context) => {
    const sessionId = context.runnerSessionId?.trim() ? context.runnerSessionId.trim() : null;
    return {
      ...(!context.slotId && (context.nativeSession || context.target)
        ? { workspaceView: true }
        : {}),
      ...(context.nativeSessionHistory?.length ? { nativeHistory: true } : {}),
      ...((context.nativeSession || context.nativeSessionOwner) && context.runId && context.slotId
        ? {
            nativeHref: slotViewHash({
              slotId: context.slotId,
              runId: context.runId,
              contextId: context.id,
            }),
          }
        : {}),
      contextId: context.id,
      role: context.role,
      label: context.label,
      runner: context.runner ?? run.metrics.runner ?? 'unknown',
      model: context.model ?? run.metrics.model ?? 'unknown',
      sessionId,
      sessionIdShort: sessionId ? sessionId.slice(0, 8) : null,
      slotId: context.slotId?.trim() ? context.slotId.trim() : null,
      runId: context.runId,
      target: context.target?.target ?? null,
    };
  });
}

/** The exact command the gateway built for this button, or null when unsupported. */
export function runSessionCommandTextForKind(
  result: RunSessionCommandResult,
  kind: RunSessionCopyKind,
): string | null {
  if (!result.supported) return null;
  return kind === 'reopen' ? result.reopenCommand : result.attachCommand;
}

/**
 * Row state after an RPC round trip. Liveness is whatever the gateway proved,
 * and it survives a clipboard failure: knowing the worker is interrupted is
 * useful even when the browser refused the copy, and hiding it would throw away
 * an answer the gateway already gave.
 */
export function runSessionRowStateFromResult(
  result: RunSessionCommandResult,
  kind: RunSessionCopyKind,
  copyError?: string | null,
): RunSessionRowState {
  if (!result.supported) {
    return { status: 'error', message: result.detail };
  }
  const command = runSessionCommandTextForKind(result, kind);
  const location = {
    machine: result.machine,
    slotId: result.slotId,
    tmuxTarget: result.tmuxTarget,
    ...(result.ownership ? { ownership: result.ownership } : {}),
    ...(result.ownerRunId ? { ownerRunId: result.ownerRunId } : {}),
  };
  if (!command) {
    return {
      status: 'error',
      liveness: result.liveness,
      ...location,
      message: `No ${kind} command is available for this session.`,
    };
  }
  if (copyError) {
    return {
      status: 'error',
      liveness: result.liveness,
      ...location,
      command,
      message: copyError,
      copyBlocked: true,
    };
  }
  return { status: 'ready', liveness: result.liveness, copied: kind, command, ...location };
}

/** Slot and tmux target already known on the row, before any RPC. */
export function runSessionLocationLabel(
  row: Pick<RunSessionRow, 'slotId' | 'target'>,
): string | null {
  const slotId = row.slotId?.trim() || null;
  const target = row.target?.trim() || null;
  if (slotId && target && (target === slotId || target.startsWith(`${slotId}:`))) return target;
  const parts = [slotId, target].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Where to paste the gateway-built command. Never wraps SSH; the operator pastes on that node. */
export function runSessionPasteOnLabel(
  state: Pick<RunSessionRowState, 'machine' | 'slotId' | 'tmuxTarget'>,
): string | null {
  const machine = state.machine?.trim() || null;
  const slotId = state.slotId?.trim() || null;
  const target = state.tmuxTarget?.trim() || null;
  if (!machine && !slotId) return null;
  const where =
    machine && slotId && machine !== slotId ? `${machine} · ${slotId}` : (machine ?? slotId);
  return target && target !== slotId ? `Paste on ${where} · ${target}` : `Paste on ${where}`;
}

export function runSessionCopyButtonState(
  state: RunSessionRowState | undefined,
  kind: RunSessionCopyKind,
): 'idle' | 'loading' | 'copied' {
  if (state?.status === 'loading' || state?.status === 'opening') return 'loading';
  if (state?.copied === kind) return 'copied';
  return 'idle';
}

export function runSessionCopyButtonLabel(
  state: RunSessionRowState | undefined,
  kind: RunSessionCopyKind,
): string {
  if (state?.status === 'loading') return 'Copying…';
  if (state?.copied === kind) return 'Copied';
  return kind === 'reopen' ? 'Copy reopen' : 'Copy attach';
}

export function runSessionOpenButtonLabel(state: RunSessionRowState | undefined): string {
  if (state?.status === 'opening') return 'Opening…';
  return 'Open on host';
}

/** Live panes only need the terminal view. Dead panes on a live run get a host reload. */
export function shouldRestoreRunnerSessionOnHost(input: {
  liveness?: RunSessionLiveness;
  runStatus?: Run['status'];
}): boolean {
  if (input.liveness === 'live') return false;
  if (input.runStatus && isTerminalRunStatus(input.runStatus)) return false;
  return true;
}

/**
 * Open/restore may steer a pane. Copy remains the path when this run no longer
 * owns the slot (warm handoff) or ownership could not be proved.
 */
export function runnerSessionOpenRefusal(result: RunSessionCommandResult): string | null {
  if (!result.supported) return result.detail;
  if (result.ownership === 'owned') return null;
  if (result.ownership === 'transferred' && result.ownerRunId) {
    return `This session moved to run ${result.ownerRunId}. Copy the command and paste it on ${result.machine}.`;
  }
  return `Slot ownership is unknown. Copy the command and paste it on ${result.machine}.`;
}

export interface RunSessionRenderContext {
  states: Record<string, RunSessionRowState | undefined>;
  onCopy: (row: RunSessionRow, kind: RunSessionCopyKind) => void;
  onOpenOnHost?: (row: RunSessionRow) => void;
}

function copyGlyph(state: 'idle' | 'loading' | 'copied') {
  if (state === 'copied') {
    return html`<svg
      class="agent-session-copy-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>`;
  }
  return html`<svg
    class="agent-session-copy-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>`;
}

function renderSessionCopyButton(
  row: RunSessionRow,
  kind: RunSessionCopyKind,
  state: RunSessionRowState | undefined,
  onCopy: RunSessionRenderContext['onCopy'],
) {
  const copyState = runSessionCopyButtonState(state, kind);
  const title =
    kind === 'reopen'
      ? "Copy reopen command. Paste it on this slot's node"
      : "Copy tmux attach command. Paste it on this slot's node";
  return html`
    <button
      class="agent-session-copy"
      data-testid="run-agent-session-${kind}-${row.contextId}"
      data-copy-kind=${kind}
      data-copy-state=${copyState}
      title=${title}
      aria-label=${title}
      ?disabled=${state?.status === 'loading' || state?.status === 'opening'}
      @click=${() => onCopy(row, kind)}
    >
      ${copyGlyph(copyState)}
      <span>${runSessionCopyButtonLabel(state, kind)}</span>
    </button>
  `;
}

function openGlyph() {
  return html`<svg
    class="agent-session-open-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </svg>`;
}

function renderSessionOpenButton(
  row: RunSessionRow,
  state: RunSessionRowState | undefined,
  onOpenOnHost: (row: RunSessionRow) => void,
) {
  const opening = state?.status === 'opening';
  return html`
    <button
      class="agent-session-open"
      data-testid="run-agent-session-open-${row.contextId}"
      data-open-state=${opening ? 'opening' : 'idle'}
      title="Recover this session on the slot's node and open it in the terminal view"
      aria-label="Open this session on the host"
      ?disabled=${opening || state?.status === 'loading'}
      @click=${() => onOpenOnHost(row)}
    >
      ${openGlyph()}
      <span>${runSessionOpenButtonLabel(state)}</span>
    </button>
  `;
}

export function livenessLabel(liveness: RunSessionLiveness): string {
  if (liveness === 'live') return 'live';
  if (liveness === 'dead') return 'interrupted';
  return 'liveness unknown';
}

function livenessColor(liveness: RunSessionLiveness): string {
  if (liveness === 'live') return colors.statusOk;
  if (liveness === 'dead') return colors.statusFail;
  return colors.textMuted;
}

export function renderRunAgentSessions(
  run: Pick<Run, 'agentContexts' | 'metrics'>,
  ctx: RunSessionRenderContext,
): unknown {
  const rows = runAgentSessionRows(run);
  if (rows.length === 0) return nothing;
  return html`
    <style>
      .agent-sessions {
        margin-top: 16px;
        border: 1px solid ${colors.accent}55;
        border-radius: 6px;
        background: ${colors.bgSurface};
        padding: 12px 14px;
      }
      .agent-sessions-title {
        font-size: ${fonts.sizeXs};
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: ${colors.textMuted};
      }
      .agent-sessions-hint {
        color: ${colors.textSecondary};
        font-size: ${fonts.sizeXs};
        margin: 4px 0 10px;
        line-height: 1.4;
      }
      .agent-session-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 8px 0;
        border-top: 1px solid ${colors.bgCard};
        font-size: ${fonts.sizeSm};
      }
      .agent-session-row:first-of-type {
        border-top: none;
      }
      .agent-session-role {
        font-weight: 600;
        color: ${colors.textPrimary};
        min-width: 110px;
      }
      .agent-session-engine,
      .agent-session-id,
      .agent-session-location {
        font-family: ${fonts.mono};
        color: ${colors.textMuted};
      }
      .agent-session-location {
        font-size: ${fonts.sizeXs};
      }
      .agent-session-liveness {
        font-family: ${fonts.mono};
        font-weight: 600;
      }
      .agent-session-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-left: auto;
      }
      .agent-session-btn {
        background: transparent;
        border: 1px solid ${colors.accent}66;
        color: ${colors.accent};
        border-radius: 4px;
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        padding: 6px 10px;
        cursor: pointer;
      }
      .agent-session-btn:hover:not(:disabled) {
        background: ${colors.accent}18;
      }
      .agent-session-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .agent-session-copy {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: transparent;
        border: 1px solid ${colors.textMuted}44;
        color: ${colors.textSecondary};
        border-radius: 4px;
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        padding: 4px 8px;
        cursor: pointer;
      }
      .agent-session-copy:hover:not(:disabled) {
        color: ${colors.accent};
        border-color: ${colors.accent}66;
        background: ${colors.accent}14;
      }
      .agent-session-copy:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .agent-session-copy[data-copy-state='copied'] {
        color: ${colors.statusOk};
        border-color: ${colors.statusOk}55;
      }
      .agent-session-open {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: transparent;
        border: 1px solid ${colors.accent}66;
        color: ${colors.accent};
        border-radius: 4px;
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        padding: 4px 8px;
        cursor: pointer;
      }
      .agent-session-open:hover:not(:disabled) {
        background: ${colors.accent}18;
      }
      .agent-session-open:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .agent-session-copy-icon,
      .agent-session-open-icon {
        width: 12px;
        height: 12px;
        flex-shrink: 0;
      }
      .agent-session-copied-block {
        flex-basis: 100%;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .agent-session-paste-on {
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        color: ${colors.accent};
      }
      .agent-session-copied {
        font-family: ${fonts.mono};
        font-size: ${fonts.sizeXs};
        color: ${colors.textSecondary};
        background: ${colors.bgCard};
        border-radius: 4px;
        padding: 6px 8px;
        overflow-x: auto;
        white-space: pre;
      }
      .agent-session-opened {
        color: ${colors.textSecondary};
        flex-basis: 100%;
        font-size: ${fonts.sizeXs};
      }
      .agent-session-error {
        color: ${colors.statusFail};
        flex-basis: 100%;
      }
    </style>
    <section class="agent-sessions" aria-label="Runner sessions" data-testid="run-agent-sessions">
      <div class="agent-sessions-title">Runner sessions</div>
      <div class="agent-sessions-hint">
        ${rows.some((row) => row.nativeHref || row.nativeHistory || row.workspaceView)
          ? 'Use the run terminal or conversation below to inspect this worker.'
          : 'Copy a command and paste it on the named node, or open it here to recover on the host.'}
      </div>
      ${rows.map((row) => {
        const state = ctx.states[row.contextId];
        const location = runSessionLocationLabel(row);
        const pasteOn = state ? runSessionPasteOnLabel(state) : null;
        return html`
          <div
            class="agent-session-row"
            data-testid="run-agent-session-${row.contextId}"
            data-ownership=${state?.ownership ?? ''}
          >
            <span
              class="agent-session-role"
              data-testid="run-agent-session-role-${row.contextId}"
              data-role=${row.role}
              >${row.label}</span
            >
            <span class="agent-session-engine">${row.runner}/${row.model}</span>
            <span
              class="agent-session-id"
              title=${row.sessionId ?? ''}
              data-testid="run-agent-session-id-${row.contextId}"
              >${row.sessionIdShort ?? 'no session captured'}</span
            >
            ${location
              ? html`<span
                  class="agent-session-location"
                  title=${row.slotId ?? ''}
                  data-slot=${row.slotId ?? ''}
                  data-testid="run-agent-session-location-${row.contextId}"
                  >${location}</span
                >`
              : nothing}
            ${state?.liveness
              ? html`<span
                  class="agent-session-liveness"
                  style="color:${livenessColor(state.liveness)}"
                  data-testid="run-agent-session-liveness-${row.contextId}"
                  >${livenessLabel(state.liveness)}</span
                >`
              : nothing}
            <span class="agent-session-actions">
              ${row.nativeHref
                ? html`<a
                    class="agent-session-btn"
                    data-testid="run-native-session-${row.contextId}"
                    href=${row.nativeHref}
                    >Open conversation</a
                  >`
                : row.nativeHistory || row.workspaceView
                  ? nothing
                  : html`${renderSessionCopyButton(row, 'reopen', state, ctx.onCopy)}
                    ${renderSessionCopyButton(row, 'attach', state, ctx.onCopy)}
                    ${ctx.onOpenOnHost
                      ? renderSessionOpenButton(row, state, ctx.onOpenOnHost)
                      : nothing}`}
            </span>
            ${state?.command
              ? html`<div class="agent-session-copied-block">
                  ${pasteOn
                    ? html`<div
                        class="agent-session-paste-on"
                        data-testid="run-agent-session-paste-on-${row.contextId}"
                      >
                        ${pasteOn}
                      </div>`
                    : nothing}
                  <code
                    class="agent-session-copied"
                    data-testid="run-agent-session-copied-${row.contextId}"
                    >${state.command}</code
                  >
                </div>`
              : nothing}
            ${state?.status === 'ready' && state.message && !state.copied
              ? html`<span
                  class="agent-session-opened"
                  data-testid="run-agent-session-opened-${row.contextId}"
                  >${state.message}</span
                >`
              : nothing}
            ${state?.status === 'error' && state.message
              ? html`<span
                  class="agent-session-error"
                  role="alert"
                  data-testid="run-agent-session-error-${row.contextId}"
                  data-copy-blocked=${state.copyBlocked ? 'true' : 'false'}
                  >${state.message}</span
                >`
              : nothing}
          </div>
        `;
      })}
      <native-worker-history .contexts=${run.agentContexts ?? []}></native-worker-history>
    </section>
  `;
}
