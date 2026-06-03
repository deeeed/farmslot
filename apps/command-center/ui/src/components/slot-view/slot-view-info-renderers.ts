import { html, nothing } from 'lit';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';
import { flowColor, flowLabel, runStatusColor } from '../runs/run-utils.js';

import type { SlotView } from './slot-view.js';

export function renderSlotViewSidebarInfo(view: SlotView) {
  const slot = view._slot;
  if (!slot)
    return html`<div
      style="padding: ${spacing.sm}; color: ${colors.textMuted}; font-size: ${fonts.sizeXs}"
    >
      No slot data
    </div>`;

  return html`
    <div class="sv-info-grid">
      <span class="sv-info-key">Machine</span>
      <span class="sv-info-val">${slot.machine}</span>
      <span class="sv-info-key">Platform</span>
      <span class="sv-info-val">${slot.platform}</span>
      <span class="sv-info-key">Project</span>
      <span class="sv-info-val">${slot.project}</span>
      <span class="sv-info-key">Branch</span>
      <span class="sv-info-val">${slot.branch || 'main'}</span>
      <span class="sv-info-key">Agent</span>
      <span class="sv-info-val">${slot.agent}</span>
      <span class="sv-info-key">Enabled</span>
      <span class="sv-info-val">
        <slot-toggle slotId=${slot.slot} ?enabled=${slot.enabled} lifecycle=${slot.lifecycle}>
        </slot-toggle>
      </span>
      <span class="sv-info-key">Runner</span>
      <span class="sv-info-val">${slot.runner || '-'}</span>
      <span class="sv-info-key">Model</span>
      <span class="sv-info-val">${slot.model || '-'}</span>
      ${slot.currentFamilyId
        ? html`
            <span class="sv-info-key">Family</span>
            <span class="sv-info-val">${slot.currentFamilyId.slice(0, 8)}</span>
          `
        : ''}
      ${slot.currentLane
        ? html`
            <span class="sv-info-key">Lane</span>
            <span class="sv-info-val">${slot.currentLane}</span>
          `
        : ''}
      ${slot.currentVariant
        ? html`
            <span class="sv-info-key">Variant</span>
            <span class="sv-info-val">${slot.currentVariant}</span>
          `
        : ''}
      ${slot.health.devserver && slot.health.devserver !== '-'
        ? html`
            <span class="sv-info-key">DevServer</span>
            <span class="sv-info-val">${slot.health.devserver}</span>
          `
        : ''}
      ${slot.deviceName
        ? html`
            <span class="sv-info-key">Device</span>
            <span class="sv-info-val">${slot.deviceName}</span>
          `
        : ''}
      ${slot.taskId
        ? html`
            <span class="sv-info-key">Task</span>
            <span class="sv-info-val">${slot.taskId}</span>
          `
        : ''}
      ${slot.dispatchedAt
        ? html`
            <span class="sv-info-key">Dispatched</span>
            <span class="sv-info-val">${new Date(slot.dispatchedAt).toLocaleString()}</span>
          `
        : ''}
    </div>
    <!-- Health dots -->
    ${view._checks.length > 0
      ? html`
          <div class="sv-check-list">
            ${view._checks.map(
              (c) => html`
                <div class="sv-check-item">
                  <span
                    class="sv-check-dot"
                    style="background:${c.status === 'pass' ? colors.statusOk : colors.statusFail}"
                  ></span>
                  <span class="sv-check-name">${c.name}</span>
                  <span class="sv-check-detail">${c.detail}</span>
                </div>
              `,
            )}
          </div>
        `
      : html`
          <div class="sv-health-grid">
            <span class="sv-health-label">SSH</span
            ><span class="sv-health-val">${slot.health.ssh}</span>
            ${view
              ._resourceHealthItems(slot)
              .map(
                ([label, val]) => html`
                  <span class="sv-health-label">${label}</span
                  ><span class="sv-health-val">${val}</span>
                `,
              )}
            <span class="sv-health-label">Fixtures</span
            ><span class="sv-health-val">${slot.health.fixtures}</span>
          </div>
        `}
  `;
}

export function renderSlotViewInfoPanel(view: SlotView) {
  const slot = view._slot;
  if (!slot)
    return html`<div style="padding: 12px; color: ${colors.textMuted}; font-size: ${fonts.sizeSm}">
      No slot data
    </div>`;
  const identityMismatch =
    view._linkedRun &&
    ((slot.currentFamilyId && slot.currentFamilyId !== view._linkedRun.familyId) ||
      (slot.currentLane && slot.currentLane !== view._linkedRun.lane) ||
      ((slot.currentVariant ?? null) !== (view._linkedRun.variant ?? null) &&
        Boolean(slot.currentVariant || view._linkedRun.variant)));
  const legacyIdentity = slot.currentRunId && !slot.currentFamilyId;

  return html`
    ${legacyIdentity
      ? html`
          <div class="error-box" style="margin-bottom: 12px;">
            Legacy slot identity: this slot has an active run binding, but family/lane/variant
            identity fields are missing. Compatibility reuse rules may still apply until the slot is
            recycled.
          </div>
        `
      : nothing}
    ${identityMismatch
      ? html`
          <div class="error-box" style="margin-bottom: 12px;">
            Slot/run identity mismatch: family=${slot.currentFamilyId ?? '-'},
            lane=${slot.currentLane ?? '-'}, variant=${slot.currentVariant ?? '-'} vs run
            family=${view._linkedRun!.familyId}, lane=${view._linkedRun!.lane},
            variant=${view._linkedRun!.variant ?? '-'}.
          </div>
        `
      : nothing}
    <!-- Info section -->
    <div class="sv-section-header" @click=${() => view._toggleSection('info')}>
      <span class="sv-section-arrow">${view._sections.info ? '\u25BE' : '\u25B8'}</span>
      <span class="sv-section-title">Slot Info</span>
    </div>
    ${view._sections.info
      ? html` <div class="sv-section-body sv-info-body">${view._renderSidebarInfo()}</div> `
      : nothing}

    <!-- Actions section -->
    <div class="sv-section-header" @click=${() => view._toggleSection('actions')}>
      <span class="sv-section-arrow">${view._sections.actions ? '\u25BE' : '\u25B8'}</span>
      <span class="sv-section-title">Actions</span>
    </div>
    ${view._sections.actions
      ? html` <div class="sv-section-body sv-actions-body">${view._renderSidebarActions()}</div> `
      : nothing}

    <!-- Run section (when slot has a linked run) -->
    ${view._linkedRun
      ? html`
          <div class="sv-section-header" @click=${() => view._toggleSection('run')}>
            <span class="sv-section-arrow">${view._sections.run ? '\u25BE' : '\u25B8'}</span>
            <span class="sv-section-title">Run</span>
            <span
              class="sv-section-badge"
              style="background:${runStatusColor(view._linkedRun.status)}22; color:${runStatusColor(
                view._linkedRun.status,
              )}"
              >${view._linkedRun.status}</span
            >
          </div>
          ${view._sections.run
            ? html`
                <div class="sv-section-body" style="padding: 8px 12px">
                  <div
                    style="display:flex; align-items:center; gap:8px; margin-bottom:8px; font-family:${fonts.mono}; font-size:${fonts.sizeXs}"
                  >
                    <span style="font-weight:600; color:${colors.textPrimary}"
                      >RUN ${view._linkedRun.id.slice(0, 8)}</span
                    >
                    <span
                      style="padding:1px 6px; border-radius:3px; font-size:10px; font-weight:600; background:${flowColor(
                        view._linkedRun.flowType,
                      )}22; color:${flowColor(view._linkedRun.flowType)}"
                      >${flowLabel(view._linkedRun.flowType)}</span
                    >
                    <span
                      style="padding:1px 6px; border-radius:3px; font-size:10px; font-weight:600; background:${colors.textMuted}22; color:${colors.textMuted}"
                      >${view._linkedRun.lane}</span
                    >
                    ${view._linkedRun.variant
                      ? html`<span
                          style="padding:1px 6px; border-radius:3px; font-size:10px; font-weight:600; background:${colors.accent}22; color:${colors.accent}"
                          >${view._linkedRun.variant}</span
                        >`
                      : ''}
                    <span
                      style="padding:1px 6px; border-radius:3px; font-size:10px; font-weight:600; background:${colors.bgCard}22; color:${colors.textMuted}"
                      >family:${view._linkedRun.familyId.slice(0, 8)}</span
                    >
                    <a
                      href="#runs?family=${encodeURIComponent(view._linkedRun.familyId)}"
                      style="color:${colors.accent}; text-decoration:none; font-size:10px"
                      >runs</a
                    >
                    <a
                      href="#family/${view._linkedRun.familyId}?run=${encodeURIComponent(
                        view._linkedRun.id,
                      )}"
                      style="color:${colors.accent}; text-decoration:none; font-size:10px"
                      >retrospective</a
                    >
                    ${view._linkedRun.ticketOrPr
                      ? html`<span style="color:${colors.textSecondary}"
                          >${view._linkedRun.ticketOrPr}</span
                        >`
                      : ''}
                  </div>
                  <div
                    style="cursor:pointer"
                    @click=${() => {
                      location.hash = ['done', 'failed', 'cancelled'].includes(
                        view._linkedRun!.status,
                      )
                        ? `family/${view._linkedRun!.familyId}?run=${encodeURIComponent(view._linkedRun!.id)}`
                        : `run/${view._linkedRun!.id}`;
                    }}
                    title=${['done', 'failed', 'cancelled'].includes(view._linkedRun!.status)
                      ? 'Click to open retrospective'
                      : 'Click to open full run detail'}
                  >
                    <run-pipeline .run=${view._linkedRun}></run-pipeline>
                  </div>
                </div>
              `
            : nothing}
        `
      : ''}

    <!-- Task section (only when working) -->
    ${view._shouldShowTaskUI()
      ? html`
          <div class="sv-section-header" @click=${() => view._toggleSection('task')}>
            <span class="sv-section-arrow">${view._sections.task ? '\u25BE' : '\u25B8'}</span>
            <span class="sv-section-title">Task</span>
            ${view._structuredProgress
              ? html`
                  <span class="sv-section-badge"
                    >${Math.round(
                      (view._structuredProgress.completedSteps /
                        Math.max(view._structuredProgress.totalSteps, 1)) *
                        100,
                    )}%</span
                  >
                `
              : view._taskSteps.length > 0
                ? html`
                    <span class="sv-section-badge">${Math.round(view._taskProgress * 100)}%</span>
                  `
                : ''}
          </div>
          ${view._sections.task
            ? html` <div class="sv-section-body sv-task-body">${view._renderSidebarTask()}</div> `
            : nothing}
        `
      : ''}
  `;
}
