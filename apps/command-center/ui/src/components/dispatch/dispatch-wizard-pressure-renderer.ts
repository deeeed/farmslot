import { html, nothing } from 'lit';

import type { PressureAdmissionDecision } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

export interface DispatchPressurePanelContext {
  /** Backend decision for the selected slot's machine. */
  decision: PressureAdmissionDecision | null;
  overrideConfirmed: boolean;
  overrideReason: string;
  setOverrideConfirmed: (confirmed: boolean) => void;
  setOverrideReason: (reason: string) => void;
  /** Re-fetch candidates so the operator can act on a fresh decision. */
  refreshDecision: () => void;
}

function formatRatio(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Render the backend-owned pressure decision for the selected slot: sustained
 * sample evidence, attributed causes, rejection reason, refresh state, and the
 * deliberate override confirmation. Display-only — every value comes from the
 * gateway decision; the wizard computes no thresholds.
 */
export function renderDispatchPressurePanel(ctx: DispatchPressurePanelContext) {
  const decision = ctx.decision;
  if (!decision || decision.outcome !== 'rejected') return nothing;
  const evidence = decision.evidence;
  return html`
    <div
      class="config-group"
      style="border:1px solid ${colors.statusFail}; border-radius:4px; padding:8px"
      data-testid="pressure-admission-panel"
    >
      <div class="section-label" style="color:${colors.statusFail}">
        Pressure rejected: ${decision.code}
      </div>
      <div style="font-size:11px; color:${colors.textPrimary}; margin:4px 0">
        ${decision.reason}
      </div>
      <div style="font-size:11px; color:${colors.textMuted}">
        ${evidence.consecutiveCriticalSamples}/${evidence.requiredConsecutiveCriticalSamples}
        consecutive critical
        samples${evidence.latestSampleAt
          ? html` · newest ${evidence.latestSampleAt}`
          : nothing}${evidence.validationFixture ? html` · validation fixture` : nothing}
      </div>
      ${evidence.samples.length > 0
        ? html`<div style="font-size:10px; color:${colors.textMuted}; margin-top:2px">
            ${evidence.samples
              .slice(-4)
              .map(
                (sample) => html`
                  <div>
                    ${sample.collectedAt} — cpu ${formatRatio(sample.cpu)} · mem
                    ${formatRatio(sample.memory)} · disk ${formatRatio(sample.disk)}
                    ${sample.load1 !== undefined
                      ? html`· load1 ${sample.load1.toFixed(2)}`
                      : nothing}
                    ${sample.critical
                      ? html`<span style="color:${colors.statusFail}">critical</span>`
                      : html`<span style="color:${colors.textMuted}">ok</span>`}
                  </div>
                `,
              )}
          </div>`
        : nothing}
      ${decision.causes.length > 0
        ? html`<div style="font-size:11px; margin-top:6px">
            <div class="section-label">Last cached attributed causes</div>
            ${decision.causes.map(
              (cause) => html`
                <div style="color:${colors.textPrimary}">
                  ${cause.process} ×${cause.processCount} — ${Math.round(cause.cpuPercent)}% cpu ·
                  ${(cause.rssBytes / 1073741824).toFixed(1)}GB ·
                  ${cause.classification}/${cause.confidence}
                  ${cause.slotId ? html`· slot ${cause.slotId}` : nothing}
                  ${cause.cleanupEligible
                    ? nothing
                    : html`<span style="color:${colors.textMuted}"
                        >(explains pressure; not a cleanup target)</span
                      >`}
                </div>
              `,
            )}
          </div>`
        : decision.state === 'sustained-critical'
          ? html`<div style="font-size:10px; color:${colors.textMuted}; margin-top:6px">
              Process attribution is not cached yet. Open this machine's Runs & relief details to
              take an explicit resource snapshot; dispatch admission will not start that work
              automatically.
            </div>`
          : nothing}
      <div style="margin-top:6px; display:flex; gap:8px; align-items:center">
        <button
          class="choice-action"
          style="font-size:11px"
          data-testid="pressure-refresh"
          @click=${() => ctx.refreshDecision()}
        >
          Refresh decision
        </button>
        <span style="font-size:10px; color:${colors.textMuted}">
          Evidence generation: ${evidence.generation ?? 'none'}
        </span>
      </div>
      ${decision.overridable
        ? html`
            <div style="margin-top:8px" data-testid="pressure-override-controls">
              <label style="display:flex; gap:6px; align-items:center; font-size:11px">
                <input
                  type="checkbox"
                  .checked=${ctx.overrideConfirmed}
                  data-testid="pressure-override-confirm"
                  @change=${(event: Event) =>
                    ctx.setOverrideConfirmed((event.target as HTMLInputElement).checked)}
                />
                Override for this one dispatch only (audited with my principal)
              </label>
              <input
                type="text"
                style="width:100%; margin-top:4px; font-size:11px"
                placeholder="Why this one dispatch is safe despite sustained pressure"
                .value=${ctx.overrideReason}
                data-testid="pressure-override-reason"
                @input=${(event: Event) =>
                  ctx.setOverrideReason((event.target as HTMLInputElement).value)}
              />
            </div>
          `
        : html`<div style="font-size:11px; color:${colors.textMuted}; margin-top:6px">
            This rejection fails closed and cannot be overridden.
          </div>`}
    </div>
  `;
}
