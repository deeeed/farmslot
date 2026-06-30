import DOMPurify from 'dompurify';
import { html, nothing } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { marked } from 'marked';

import { primaryRoleForFlow, type Run, type RunDecision } from '@farmslot/protocol';

import { colors, fonts } from '../../styles/theme-tokens.js';

const SIGNAL_EXAMPLE = `{
  "status": "complete",
  "timestamp": "2026-06-30T12:00:00.000Z",
  "step": "complete",
  "outcome": "success",
  "disposition": "fixed"
}`;

export interface InteractiveHandoffRenderContext {
  actionsBlocked: boolean;
  pendingConfirm: string | null;
  signalCheckBusy: boolean;
  signalCheckError: string | null;
  confirmResolve: (runId: string, decision: RunDecision, actionId: string) => void;
  checkSignalAndResume: (runId: string, decision: RunDecision) => void;
}

function workerSignalFileForRun(run: Run, decision: RunDecision): string | null {
  const fromContext = decision.context?.signalFile;
  if (typeof fromContext === 'string' && fromContext.trim()) return fromContext;
  const role = primaryRoleForFlow(run.flowType);
  const ctx =
    run.agentContexts?.find((entry) => entry.role === role) ?? run.agentContexts?.[0] ?? null;
  return ctx?.signalFile ?? null;
}

export function renderInteractiveHandoffGate(
  run: Run,
  decision: RunDecision,
  context: InteractiveHandoffRenderContext,
) {
  const signalFile = workerSignalFileForRun(run, decision);
  const primaryAction = decision.actions.find((action) => action.id === 'signal-written');
  const abortAction = decision.actions.find((action) => action.id === 'abort');
  const primaryHelp = primaryAction?.description ?? '';

  return html`
    <style>
      .ih-error {
        margin-top: 10px;
        padding: 10px 12px;
        border-radius: 4px;
        border: 1px solid ${colors.statusFail}55;
        background: ${colors.statusFail}11;
        color: ${colors.statusFail};
        font-size: ${fonts.sizeSm};
        line-height: 1.5;
      }
      .ih-help {
        margin-top: 12px;
        padding: 10px 12px;
        border-radius: 4px;
        border: 1px solid ${colors.bgCard};
        background: ${colors.bgSurface};
        font-size: ${fonts.sizeXs};
        color: ${colors.textMuted};
        line-height: 1.6;
      }
      .ih-help summary {
        cursor: pointer;
        color: ${colors.textPrimary};
        font-weight: 600;
        margin-bottom: 8px;
      }
      .ih-help ol {
        margin: 8px 0 0 18px;
        padding: 0;
      }
      .ih-help pre {
        margin: 8px 0 0;
        padding: 8px;
        border-radius: 4px;
        background: ${colors.bgCard};
        overflow-x: auto;
        font-family: ${fonts.mono};
        font-size: 11px;
        color: ${colors.textPrimary};
      }
      .ih-path {
        font-family: ${fonts.mono};
        color: ${colors.textPrimary};
      }
    </style>
    <div class="gate-body">
      <div class="gate-description md-body">
        ${unsafeHTML(
          DOMPurify.sanitize(marked.parse(decision.description ?? '', { async: false }) as string),
        )}
      </div>
      <details class="ih-help">
        <summary>SIGNAL.json help</summary>
        <div>
          ${signalFile
            ? html`<div>Expected path: <code class="ih-path">${signalFile}</code></div>`
            : html`<div>Expected path: resolve from the worker task directory in Slot View.</div>`}
          <ol>
            <li>Do any manual PR work in the slot terminal.</li>
            <li>Mark checklist progress: <code>./mark 1</code>, <code>./mark 2</code>, …</li>
            <li>
              When done, write a terminal signal:
              <code>./mark complete</code> or <code>./mark no-change --reason "…"</code>
            </li>
            <li>Click <strong>Check SIGNAL.json &amp; resume</strong>.</li>
          </ol>
          <div>Minimum terminal example (success):</div>
          <pre>${SIGNAL_EXAMPLE}</pre>
        </div>
      </details>
      ${context.signalCheckError
        ? html`<div class="ih-error" role="alert">${context.signalCheckError}</div>`
        : nothing}
      <div class="gate-actions">
        ${primaryAction
          ? html`
              <div class="gate-action-cell">
                <button
                  class="gate-action-btn"
                  style="background:${colors.accent}; border-color:${colors.accent}; color:#fff"
                  ?disabled=${context.actionsBlocked || context.signalCheckBusy}
                  title=${primaryHelp}
                  @click=${() => context.checkSignalAndResume(run.id, decision)}
                >
                  ${context.signalCheckBusy ? 'Checking…' : primaryAction.label}
                </button>
                ${primaryHelp ? html`<div class="gate-action-help">${primaryHelp}</div>` : nothing}
              </div>
            `
          : nothing}
        ${abortAction
          ? html`
              <div class="gate-action-cell">
                <button
                  class="gate-action-btn ${context.pendingConfirm === abortAction.id
                    ? 'gate-confirming'
                    : ''}"
                  style="${context.pendingConfirm === abortAction.id
                    ? ''
                    : `border-color:${colors.statusFail}; color:${colors.statusFail}`}"
                  ?disabled=${context.actionsBlocked || context.signalCheckBusy}
                  @click=${() => context.confirmResolve(run.id, decision, abortAction.id)}
                >
                  ${context.pendingConfirm === abortAction.id
                    ? `Confirm ${abortAction.label}?`
                    : abortAction.label}
                </button>
              </div>
            `
          : nothing}
      </div>
    </div>
  `;
}
