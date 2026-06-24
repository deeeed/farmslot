import { html, nothing } from 'lit';

import type { SlotStatus } from '@farmslot/protocol';

import { colors, fonts } from '../../styles/theme-tokens.js';
import { isSlotPinned } from '../../utils/pinned-slots.js';

import type { SlotView } from './slot-view.js';
import { EDITORS } from './slot-view-model.js';

export interface SlotViewHeaderRenderContext {
  slot: SlotStatus | null;
  hasSlotData: boolean;
  hasResources: boolean;
  lcColor: string;
}

export function renderSlotViewHeader(
  view: SlotView,
  { slot, hasSlotData, hasResources, lcColor }: SlotViewHeaderRenderContext,
) {
  const pinned = view.slotId ? isSlotPinned(view.slotId) : false;
  return html`
    <!-- Header -->
    <div class="sv-header">
      <button class="sv-back-btn" @click=${view._handleBack}>&larr;</button>
      <span class="sv-slot-title">${hasSlotData ? slot!.slot : view.slotId || 'workspace'}</span>
      ${view.slotId
        ? html`
            <button
              class="sv-run-ctrl"
              style="background:${pinned ? colors.accent : colors.bgCard}22; color:${pinned
                ? colors.accent
                : colors.textMuted}; border:1px solid ${pinned
                ? colors.accent
                : colors.bgCardHover}; padding:2px 8px; border-radius:4px; font-size:11px; font-family:${fonts.mono}; cursor:pointer; margin-left:4px"
              @click=${() => view._togglePinnedSlot()}
              title="Toggle this slot in the Command Center pinned slots list"
            >
              ${pinned ? 'Pinned' : 'Pin slot'}
            </button>
            ${pinned
              ? html`
                  <button
                    class="sv-run-ctrl"
                    style="background:${colors.bgCard}22; color:${colors.textMuted}; border:1px solid ${colors.bgCardHover}; padding:2px 8px; border-radius:4px; font-size:11px; font-family:${fonts.mono}; cursor:pointer; margin-left:4px"
                    @click=${() => view._renamePinnedSlot()}
                    title="Override the label shown for this pinned slot"
                  >
                    Rename pin
                  </button>
                `
              : nothing}
          `
        : nothing}
      ${hasSlotData
        ? html`
            <span class="sv-lifecycle-badge" style="background:${lcColor}22; color:${lcColor}">
              ${slot!.phase ? `${slot!.lifecycle} (${slot!.phase})` : slot!.lifecycle}
            </span>
            ${view._manualToggling
              ? html`
                  <button
                    style="background:${colors.bgCard}; color:${colors.textMuted}; border:1px solid ${colors.bgCard}; padding:2px 8px; border-radius:4px; font-size:11px; font-family:${fonts.mono}; cursor:wait; margin-left:4px; opacity:0.6"
                    disabled
                  >
                    ...
                  </button>
                `
              : slot!.lifecycle === 'ready' || slot!.lifecycle === 'held'
                ? html`
                    <button
                      style="background:${colors.lifecycleManual}22; color:${colors.lifecycleManual}; border:1px solid ${colors.lifecycleManual}44; padding:2px 8px; border-radius:4px; font-size:11px; font-family:${fonts.mono}; cursor:pointer; margin-left:4px"
                      ?disabled=${view._isRecoveryBlocked}
                      @click=${() => view._toggleManual(true)}
                      title="Reserve this slot for manual work — prevents auto-dispatch"
                    >
                      Hold for manual work
                    </button>
                  `
                : slot!.lifecycle === 'manual'
                  ? html`
                      <button
                        style="background:${colors.lifecycleReady}22; color:${colors.lifecycleReady}; border:1px solid ${colors.lifecycleReady}44; padding:2px 8px; border-radius:4px; font-size:11px; font-family:${fonts.mono}; cursor:pointer; margin-left:4px"
                        ?disabled=${view._isRecoveryBlocked}
                        @click=${() => view._toggleManual(false)}
                        title="Make this slot available for dispatch again"
                      >
                        Release to pool
                      </button>
                    `
                  : ''}
          `
        : ''}
      ${view._linkedRun && view._linkedRun.status === 'monitoring'
        ? html`
            <button
              class="sv-run-ctrl"
              style="background:${colors.statusWarn}22; color:${colors.statusWarn}; border:1px solid ${colors.statusWarn}44; padding:2px 8px; border-radius:4px; font-size:11px; font-family:${fonts.mono}; cursor:pointer; margin-left:4px"
              ?disabled=${view._isRecoveryBlocked}
              @click=${() => view._pauseRun()}
              title="Pause worker (Ctrl+C)"
            >
              Pause
            </button>
          `
        : view._linkedRun && view._linkedRun.status === 'paused'
          ? html`
              <button
                class="sv-run-ctrl"
                style="background:${colors.statusOk}22; color:${colors.statusOk}; border:1px solid ${colors.statusOk}44; padding:2px 8px; border-radius:4px; font-size:11px; font-family:${fonts.mono}; cursor:pointer; margin-left:4px"
                ?disabled=${view._isRecoveryBlocked}
                @click=${() => view._resumeRun()}
                title="Resume worker"
              >
                Resume
              </button>
            `
          : ''}
      ${hasSlotData
        ? html`
            <button
              class="sv-run-ctrl history"
              @click=${() => {
                view._historyOpen = true;
                view._syncUrlState();
              }}
              title="View recent retained runs for this slot"
            >
              History
            </button>
            <button
              class="sv-run-ctrl"
              @click=${() => {
                view._loadRunOpen = true;
              }}
              title="Browse all runs and warm-switch this slot onto one"
            >
              Load run →
            </button>
          `
        : nothing}
      ${view._prNumber && view._prRepo
        ? html`
            <a
              class="sv-run-ctrl sv-pr-link"
              href=${`https://github.com/${view._prRepo}/pull/${view._prNumber}`}
              target="_blank"
              rel="noopener"
              title=${`Open PR #${view._prNumber} on github.com/${view._prRepo}`}
              >PR #${view._prNumber}</a
            >
          `
        : nothing}
      ${hasResources
        ? html`
            <div class="sv-resource-chips">
              ${view._resources.map(
                (r) => html`
                  <button
                    class="sv-resource-chip ${view._resourcePanelOpen ? 'active' : ''}"
                    @click=${() => view._onHeaderResourceClick(r.id)}
                    title="${r.definition.label} (${r.status}${r.stream?.state &&
                    r.stream.state !== 'unknown'
                      ? `, stream ${r.stream.state}`
                      : ''}${r.stream?.detail ? `: ${r.stream.detail}` : ''})"
                  >
                    <span class="sv-rchip-dot ${r.status}"></span>
                    ${r.definition.label}
                    ${r.stream?.state === 'starting'
                      ? html`<span style="color:${colors.accent}">…</span>`
                      : nothing}
                    ${r.stream?.state === 'error'
                      ? html`<span style="color:${colors.statusWarn}">!</span>`
                      : nothing}
                    ${r.stream?.state === 'ready'
                      ? html`<span style="color:${colors.statusOk}">•</span>`
                      : nothing}
                  </button>
                `,
              )}
            </div>
          `
        : ''}
      ${view._slotHeaderActions().length > 0
        ? html`
            <div class="sv-slot-actions">
              ${view._slotHeaderActions().map((action) => {
                const failed = view._failedSlotActionId === action.id;
                return html`
                  <button
                    class="sv-slot-action-btn ${action.style} ${failed ? 'failed' : ''}"
                    ?disabled=${view._runningSlotActionIds.includes(action.id) ||
                    view._isRecoveryBlocked}
                    @click=${() => view._runConfiguredSlotAction(action.id)}
                    title=${failed
                      ? `Failed: ${view._failedSlotActionMsg}`
                      : (action.confirm ??
                        action.description ??
                        (action.mode === 'copy' ? `Copy command: ${action.label}` : action.label))}
                  >
                    ${view._runningSlotActionIds.includes(action.id)
                      ? '...'
                      : view._pendingConfirm === `slot-action:${action.id}`
                        ? 'Confirm?'
                        : view._copiedSlotActionId === action.id
                          ? 'Copied'
                          : failed
                            ? 'Failed'
                            : action.label}
                  </button>
                `;
              })}
            </div>
          `
        : nothing}
      <div class="sv-header-right">
        ${hasSlotData && view._isLocal && slot?.taskFile
          ? html`
              <button
                class="sv-open-editor-btn"
                @click=${view._revealArtifacts}
                title="Reveal task artifacts in Finder"
              >
                Artifacts
              </button>
            `
          : ''}
        ${hasSlotData && view._repoPath
          ? html`
              <button class="sv-open-editor-btn" @click=${view._openEditor}>
                Open in ${EDITORS.find((e) => e.id === view._editor)!.label}
              </button>
              <div class="sv-editor-group">
                ${EDITORS.map(
                  (e) => html`
                    <button
                      class="sv-editor-btn ${view._editor === e.id ? 'active' : ''}"
                      @click=${() => view._setEditor(e.id)}
                    >
                      ${e.label}
                    </button>
                  `,
                )}
              </div>
            `
          : ''}
      </div>
    </div>
  `;
}
