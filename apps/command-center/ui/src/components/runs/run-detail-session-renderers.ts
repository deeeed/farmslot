import { html, nothing } from 'lit';

import type {
  AgentContext,
  Run,
  RunSessionCommandResult,
  RunSessionLiveness,
} from '@farmslot/protocol';

import { colors, fonts } from '../../styles/theme-tokens.js';

export type RunSessionCopyKind = 'reopen' | 'attach';

export interface RunSessionRowState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  liveness?: RunSessionLiveness;
  copied?: RunSessionCopyKind;
  message?: string;
  /**
   * The gateway answered but the browser refused the clipboard. A discrete flag
   * so callers never have to pattern-match the human-readable message.
   */
  copyBlocked?: true;
}

export interface RunSessionRow {
  contextId: string;
  role: AgentContext['role'];
  label: string;
  runner: string;
  model: string;
  sessionId: string | null;
  sessionIdShort: string | null;
  target: string | null;
}

/** One row per agent context, in the order the run recorded them. */
export function runAgentSessionRows(run: Pick<Run, 'agentContexts' | 'metrics'>): RunSessionRow[] {
  return (run.agentContexts ?? []).map((context) => {
    const sessionId = context.runnerSessionId?.trim() ? context.runnerSessionId.trim() : null;
    return {
      contextId: context.id,
      role: context.role,
      label: context.label,
      runner: context.runner ?? run.metrics.runner ?? 'unknown',
      model: context.model ?? run.metrics.model ?? 'unknown',
      sessionId,
      sessionIdShort: sessionId ? sessionId.slice(0, 8) : null,
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
  if (!command) {
    return {
      status: 'error',
      liveness: result.liveness,
      message: `No ${kind} command is available for this session.`,
    };
  }
  if (copyError) {
    return { status: 'error', liveness: result.liveness, message: copyError, copyBlocked: true };
  }
  return { status: 'ready', liveness: result.liveness, copied: kind };
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

export interface RunSessionRenderContext {
  states: Record<string, RunSessionRowState | undefined>;
  onCopy: (row: RunSessionRow, kind: RunSessionCopyKind) => void;
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
        border: 1px solid ${colors.bgCard};
        border-radius: 4px;
        background: ${colors.bgSurface};
        padding: 10px 12px;
      }
      .agent-sessions-title {
        font-size: ${fonts.sizeXs};
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: ${colors.textMuted};
        margin-bottom: 8px;
      }
      .agent-session-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 6px 0;
        border-top: 1px solid ${colors.bgCard};
        font-size: ${fonts.sizeXs};
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
      .agent-session-id {
        font-family: ${fonts.mono};
        color: ${colors.textMuted};
      }
      .agent-session-liveness {
        font-family: ${fonts.mono};
      }
      .agent-session-btn {
        background: transparent;
        border: 1px solid ${colors.bgCardHover};
        color: ${colors.textMuted};
        border-radius: 4px;
        font-family: ${fonts.mono};
        font-size: 10px;
        padding: 2px 6px;
        cursor: pointer;
      }
      .agent-session-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .agent-session-error {
        color: ${colors.statusFail};
        flex-basis: 100%;
      }
    </style>
    <section class="agent-sessions" aria-label="Runner sessions" data-testid="run-agent-sessions">
      <div class="agent-sessions-title">Runner sessions</div>
      ${rows.map((row) => {
        const state = ctx.states[row.contextId];
        const busy = state?.status === 'loading';
        return html`
          <div class="agent-session-row" data-testid="run-agent-session-${row.contextId}">
            <span
              class="agent-session-role"
              data-testid="run-agent-session-role-${row.contextId}"
              data-role=${row.role}
              >${row.label}</span
            >
            <span class="agent-session-engine">${row.runner}/${row.model}</span>
            <span class="agent-session-id" data-testid="run-agent-session-id-${row.contextId}"
              >${row.sessionIdShort ?? 'no session captured'}</span
            >
            ${state?.liveness
              ? html`<span
                  class="agent-session-liveness"
                  style="color:${livenessColor(state.liveness)}"
                  data-testid="run-agent-session-liveness-${row.contextId}"
                  >${livenessLabel(state.liveness)}</span
                >`
              : nothing}
            <button
              class="agent-session-btn"
              data-testid="run-agent-session-reopen-${row.contextId}"
              ?disabled=${busy}
              @click=${() => ctx.onCopy(row, 'reopen')}
            >
              ${busy ? 'Loading…' : state?.copied === 'reopen' ? 'Copied' : 'Reopen session'}
            </button>
            <button
              class="agent-session-btn"
              data-testid="run-agent-session-attach-${row.contextId}"
              ?disabled=${busy}
              @click=${() => ctx.onCopy(row, 'attach')}
            >
              ${busy ? 'Loading…' : state?.copied === 'attach' ? 'Copied' : 'Attach tmux'}
            </button>
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
    </section>
  `;
}
