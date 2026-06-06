import DOMPurify from 'dompurify';
import { html, nothing } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { marked } from 'marked';

import type {
  BranchAffinityNudgePayload,
  PRStatus,
  RecipeRunArtifactGroup,
  Run,
  RunDecision,
  SlotPickerPayload,
} from '@farmslot/protocol';

import { colors, fonts } from '../../styles/theme-tokens.js';
import { decisionPayloadKind } from '../shared/decision-payload-model.js';
import type { RecipeCompleteDetail } from '../workspace/recipe-output-panel.js';

import {
  renderCollisionDescription,
  renderCollisionPriorRuns,
} from './run-detail-collision-renderers.js';

/**
 * Client-side fallback help text for decision actions where the gateway didn't persist a
 * `description` on the action record. Existing pending decisions created before the gateway
 * gained the description field still show useful guidance via this lookup. New decisions
 * dispatched from the updated gateway populate `action.description` directly and bypass
 * this fallback.
 *
 * Keyed by `${decisionType}::${actionId}` — decisionType is the persisted form
 * (`engine_collision`, `engine_recipe_strategy`, …). Add entries lazily as decision UI
 * surfaces start needing operator-facing explanations.
 */
const DECISION_ACTION_FALLBACK_HELP: Record<string, string> = {
  'engine_collision::create-new':
    'Creates a fresh task dir with a timestamp suffix and dispatches as a new production-lane root run. Use when the prior dirs are stale/abandoned and you just want to retry from scratch — does not link to existing runs.',
  'engine_collision::start-comparison':
    'Files this run as a comparison-lane sibling of the existing family (same ticket, same family ID, new variant tag). Use when you want to A/B compare runner/model/template changes against a prior run for the same bug.',
  'engine_collision::abort':
    'Cancels the current dispatch without touching existing task dirs. Use when the collision was unexpected and you need to investigate the prior runs before re-dispatching.',
};

export function decisionActionHelp(
  decisionType: string | undefined,
  action: { id: string; description?: string },
): string {
  if (action.description) return action.description;
  if (!decisionType) return '';
  return DECISION_ACTION_FALLBACK_HELP[`${decisionType}::${action.id}`] ?? '';
}

export interface RunDecisionRenderContext {
  allRuns: Run[];
  bootstrapFailed: boolean;
  directRunRefreshFailed: boolean;
  actionsBlocked: boolean;
  pendingConfirm: string | null;
  recipeRuns: RecipeRunArtifactGroup[];
  selectedRecipeRunId: string;
  selectedSlotId: string | null;
  resetBranch: boolean;
  branchNudgeShowPicker: boolean;
  liveTimeoutPrStatus: PRStatus | null;
  liveTimeoutPrStatusRefreshing: boolean;
  liveTimeoutPrStatusFailed: boolean;
  isLiveTimeoutAllGreen: () => boolean;
  setSelectedSlot: (slotId: string | null, resetBranch?: boolean) => void;
  setResetBranch: (resetBranch: boolean) => void;
  setBranchNudgeShowPicker: (show: boolean) => void;
  confirmResolve: (runId: string, decision: RunDecision, actionId: string) => void;
  resolveSlotPick: (runId: string, decisionId: string) => void;
  resolveBranchNudgePick: (runId: string, decisionId: string) => void;
  handleRecipeRunArtifacts: (
    run: Run,
    detail: RecipeCompleteDetail,
    preferSelectedArtifacts: boolean,
  ) => void;
}

export function renderRunGateSection(run: Run, context: RunDecisionRenderContext) {
  // Show gate section for ANY unresolved decision (not just ones with payload)
  const pending = run.decisions.find((d) => !d.resolvedAt);
  if (!pending) return nothing;

  const kind = decisionPayloadKind(pending.payload);
  const isReview = kind === 'review';
  const isReady = kind === 'ready';
  const isSlotPicker = kind === 'slot_picker';
  const isBranchNudge = kind === 'branch_affinity_nudge';
  const isCollision = pending.type === 'engine_collision';
  const isRetrospective = pending.type === 'retrospective' || kind === 'retrospective';
  const hasPayload = isReview || isReady;
  const retrospectiveHref = `#family/${run.familyId}?run=${encodeURIComponent(run.id)}`;

  const recoveredTimeout = pending.type === 'ci_ci_timeout' && context.isLiveTimeoutAllGreen();
  const title = isReview
    ? 'Review ready for your decision'
    : isReady
      ? 'Worker finished — verify before marking ready'
      : isSlotPicker
        ? 'No suitable slot — pick one'
        : isBranchNudge
          ? "Worker on this PR's branch is busy — choose how to dispatch"
          : isCollision
            ? 'Task dir collision — prior runs exist'
            : isRetrospective
              ? 'Retrospective ready for review'
              : recoveredTimeout
                ? 'CI timeout recovered'
                : 'Action required';
  const retrospectivePayload = isRetrospective
    ? (pending.payload as
        | {
            whatThisIs?: string;
            outcome?: string;
            ciWatch?: { result?: string; passed?: number; total?: number };
          }
        | undefined)
    : undefined;

  return html`
    <div class=${`gate-section ${isReady ? 'ready-gate' : isReview ? 'review-gate' : ''}`}>
      <div class="gate-header">
        <span class="gate-icon">!</span>
        <div style="flex:1">
          <div class="gate-title">${title}</div>
        </div>
        ${isRetrospective
          ? html` <a class="gate-slot-link" href=${retrospectiveHref}>Open retrospective</a> `
          : run.slotId
            ? html`
                <a
                  class="gate-slot-link"
                  href=${`#slot/${run.slotId}?runId=${encodeURIComponent(run.id)}`}
                  >Open in Slot View</a
                >
              `
            : nothing}
      </div>
      ${hasPayload && context.actionsBlocked
        ? html`
            <div class="gate-body">
              <div class="gate-description">
                ${context.bootstrapFailed
                  ? 'Run refresh failed. Cached gate data is visible, but actions are paused until the run snapshot refreshes.'
                  : context.directRunRefreshFailed
                    ? 'Run refresh failed. Cached gate data is visible, but actions are paused until the direct run refresh succeeds.'
                    : 'Reconnecting. Cached gate data is visible, but actions are paused until the run snapshot refreshes.'}
              </div>
            </div>
          `
        : hasPayload
          ? html`
              <div class="gate-workspace">
                ${isReview
                  ? html`
                      <review-workspace
                        .runId=${run.id}
                        .decision=${pending}
                        slotId=${run.slotId ?? ''}
                        branch=${run.branch ?? ''}
                      ></review-workspace>
                    `
                  : html`
                      <ready-workspace
                        .runId=${run.id}
                        .decision=${pending}
                        .run=${run}
                        .recipeRuns=${context.recipeRuns}
                        selectedRecipeRunId=${context.selectedRecipeRunId}
                        slotId=${run.slotId ?? ''}
                        branch=${run.branch ?? ''}
                        runner=${run.metrics.runner ?? ''}
                        @recipe-complete=${(event: CustomEvent<RecipeCompleteDetail>) =>
                          context.handleRecipeRunArtifacts(run, event.detail, true)}
                        @recipe-artifacts-request=${(event: CustomEvent<RecipeCompleteDetail>) =>
                          context.handleRecipeRunArtifacts(run, event.detail, false)}
                      ></ready-workspace>
                    `}
              </div>
            `
          : isRetrospective
            ? html`
                <div class="gate-body">
                  <div class="gate-description md-body">
                    <p>
                      ${retrospectivePayload?.whatThisIs ??
                      'This completed run has a retrospective decision. Open the retrospective view to inspect the run evidence and decide whether it should feed the self-improvement loop.'}
                    </p>
                    ${retrospectivePayload?.outcome || retrospectivePayload?.ciWatch
                      ? html`
                          <p>
                            ${retrospectivePayload?.outcome
                              ? html`Outcome: <strong>${retrospectivePayload.outcome}</strong>`
                              : nothing}
                            ${retrospectivePayload?.ciWatch
                              ? html`
                                  ${retrospectivePayload?.outcome ? html`<br />` : nothing} CI
                                  Watch:
                                  <strong
                                    >${retrospectivePayload.ciWatch.result ??
                                    'unknown'}${retrospectivePayload.ciWatch.total != null
                                      ? ` · ${retrospectivePayload.ciWatch.passed ?? 0}/${retrospectivePayload.ciWatch.total} passed`
                                      : ''}</strong
                                  >
                                `
                              : nothing}
                          </p>
                        `
                      : nothing}
                    ${pending.description
                      ? html`
                          <details>
                            <summary>Run summary</summary>
                            ${unsafeHTML(
                              DOMPurify.sanitize(
                                marked.parse(pending.description, { async: false }) as string,
                              ),
                            )}
                          </details>
                        `
                      : nothing}
                  </div>
                  <div class="gate-actions">
                    <a
                      class="gate-action-btn"
                      style="background:${colors.accent}; border-color:${colors.accent}; color:#fff; text-decoration:none"
                      href=${retrospectiveHref}
                    >
                      Open retrospective to decide
                    </a>
                  </div>
                </div>
              `
            : isSlotPicker
              ? html`
                  <div class="gate-body">
                    <div class="gate-description md-body">
                      ${unsafeHTML(
                        DOMPurify.sanitize(
                          marked.parse(pending.description ?? '', { async: false }) as string,
                        ),
                      )}
                    </div>
                    ${renderSlotPicker(run, pending, context)}
                  </div>
                `
              : isBranchNudge
                ? html`
                    <div class="gate-body">
                      <div class="gate-description md-body">
                        ${unsafeHTML(
                          DOMPurify.sanitize(
                            marked.parse(pending.description ?? '', { async: false }) as string,
                          ),
                        )}
                      </div>
                      ${renderBranchAffinityNudge(run, pending, context)}
                    </div>
                  `
                : html`
                    <div class="gate-body">
                      ${pending.type === 'ci_ci_timeout'
                        ? renderCITimeoutDecisionDescription(pending, context)
                        : isCollision
                          ? renderCollisionDescription(pending, run.project, context.allRuns)
                          : html`
                              <div class="gate-description md-body">
                                ${unsafeHTML(
                                  DOMPurify.sanitize(
                                    marked.parse(pending.description ?? '', {
                                      async: false,
                                    }) as string,
                                  ),
                                )}
                              </div>
                            `}
                      ${isCollision ? renderCollisionPriorRuns(pending, context.allRuns) : nothing}
                      ${recoveredTimeout
                        ? html`
                            <div
                              class="gate-description"
                              style="padding-top:0; margin-bottom:0; color:${colors.textMuted}; font-size:${fonts.sizeXs}"
                            >
                              Resuming CI-watch automatically because the current watched checks are
                              green.
                            </div>
                          `
                        : html`
                            <div class="gate-actions">
                              ${pending.actions.map((a) => {
                                const confirming = context.pendingConfirm === a.id;
                                const help = decisionActionHelp(pending.type, a);
                                return html`
                                  <div class="gate-action-cell">
                                    <button
                                      class="gate-action-btn ${confirming ? 'gate-confirming' : ''}"
                                      style="${confirming
                                        ? ''
                                        : a.style === 'primary'
                                          ? `background:${colors.accent}; border-color:${colors.accent}; color:#fff`
                                          : a.style === 'danger'
                                            ? `border-color:${colors.statusFail}; color:${colors.statusFail}`
                                            : `border-color:${colors.textMuted}; color:${colors.textMuted}`}"
                                      ?disabled=${context.actionsBlocked}
                                      title=${help}
                                      @click=${() => context.confirmResolve(run.id, pending, a.id)}
                                    >
                                      ${confirming ? `Confirm ${a.label}?` : a.label}
                                    </button>
                                    ${help
                                      ? html`<div class="gate-action-help">${help}</div>`
                                      : nothing}
                                  </div>
                                `;
                              })}
                            </div>
                          `}
                    </div>
                  `}
    </div>
  `;
}

function renderCITimeoutDecisionDescription(
  decision: RunDecision,
  context: RunDecisionRenderContext,
) {
  const live = context.liveTimeoutPrStatus;
  const liveSummary = live?.checkSummary;
  const liveLabel = liveSummary
    ? `${liveSummary.passed}/${liveSummary.total} passed${liveSummary.failed ? ` · ${liveSummary.failed} failed` : ''}${liveSummary.pending ? ` · ${liveSummary.pending} pending` : ''}`
    : context.liveTimeoutPrStatusRefreshing
      ? 'Refreshing current GitHub checks…'
      : context.liveTimeoutPrStatusFailed
        ? 'Current GitHub checks could not be refreshed'
        : 'Current GitHub checks have not loaded yet';
  const liveColor = liveSummary?.failed
    ? colors.statusFail
    : liveSummary?.pending
      ? colors.statusWarn
      : liveSummary?.total
        ? colors.statusOk
        : colors.textMuted;
  const description = decision.description ?? '';

  return html`
    <div class="gate-description">
      <div style="display:grid; gap:10px">
        <div>
          <div
            style="color:${colors.textMuted}; font-size:${fonts.sizeXs}; text-transform:uppercase; margin-bottom:4px"
          >
            Current GitHub status
          </div>
          <div style="color:${liveColor}; font-weight:700">${liveLabel}</div>
          ${live?.recommendation
            ? html`
                <div style="color:${colors.textMuted}; font-size:${fonts.sizeXs}; margin-top:2px">
                  ${live.recommendation}
                </div>
              `
            : nothing}
        </div>
        <div>
          <div
            style="color:${colors.textMuted}; font-size:${fonts.sizeXs}; text-transform:uppercase; margin-bottom:4px"
          >
            Timeout snapshot
          </div>
          <pre style="white-space:pre-wrap; margin:0">${description}</pre>
        </div>
        ${liveSummary?.total && liveSummary.passed === liveSummary.total
          ? html`
              <div style="color:${colors.textMuted}; font-size:${fonts.sizeXs}">
                The timeout decision was created from the older monitor snapshot above; the current
                check state is green.
              </div>
            `
          : nothing}
      </div>
    </div>
  `;
}

function renderSlotPicker(run: Run, decision: RunDecision, context: RunDecisionRenderContext) {
  const payload = decision.payload as SlotPickerPayload;
  const candidates = payload.candidates;
  const freeOnes = candidates.filter((c) => c.score >= 0);
  const busyOnes = candidates.filter((c) => c.score < 0);

  return html`
    <style>
      .sp-list {
        margin: 8px 0;
      }
      .sp-slot {
        display: grid;
        grid-template-columns: 1fr 80px 120px 100px;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-bottom: 1px solid ${colors.bgCard};
        cursor: pointer;
        border-left: 3px solid transparent;
      }
      .sp-slot:hover {
        background: ${colors.bgSurface};
      }
      .sp-slot.selected {
        border-left-color: ${colors.accent};
        background: ${colors.accent}11;
      }
      .sp-slot.busy {
        opacity: 0.4;
        cursor: default;
      }
      .sp-name {
        font-weight: 600;
        font-size: 12px;
      }
      .sp-branch {
        font-size: 11px;
        color: ${colors.textMuted};
      }
      .sp-branch.stale {
        color: ${colors.statusFail};
      }
      .sp-score {
        font-weight: 700;
        font-size: 13px;
        text-align: right;
      }
      .sp-score.good {
        color: ${colors.statusOk};
      }
      .sp-score.bad {
        color: ${colors.statusFail};
      }
      .sp-lifecycle {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 3px;
      }
      .sp-actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
        align-items: center;
      }
      .sp-reset-label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: ${colors.textMuted};
        margin-left: 12px;
      }
      .sp-reset-label input {
        accent-color: ${colors.accent};
      }
    </style>
    <div class="sp-list">
      ${freeOnes.map((c) => {
        const isStale = !!(c.branch && c.branch !== 'main' && c.branch !== '');
        const selected = context.selectedSlotId === c.slotId;
        return html`
          <div
            class="sp-slot ${selected ? 'selected' : ''}"
            @click=${() => {
              context.setSelectedSlot(c.slotId, isStale);
            }}
          >
            <div>
              <div class="sp-name">${c.slotId}</div>
              <div class="sp-branch ${isStale ? 'stale' : ''}">${c.branch || 'main'}</div>
            </div>
            <div class="sp-score ${c.score < 50 ? 'good' : 'bad'}">${c.score}</div>
            <div class="sp-lifecycle">${c.lifecycle}</div>
            <div style="font-size:10px;color:${colors.textMuted}">${c.machine}</div>
          </div>
        `;
      })}
      ${busyOnes.length > 0
        ? html`
            <div style="font-size:10px;color:${colors.textMuted};padding:8px 12px">
              ${busyOnes.length} busy/disabled slot(s) not shown
            </div>
          `
        : nothing}
    </div>
    <div class="sp-actions">
      <button
        class="gate-action-btn"
        style="background:${colors.accent}; border-color:${colors.accent}; color:#fff"
        ?disabled=${!context.selectedSlotId || context.actionsBlocked}
        @click=${() => context.resolveSlotPick(run.id, decision.id)}
      >
        ${context.selectedSlotId ? `Use ${context.selectedSlotId}` : 'Select a slot'}
      </button>
      ${context.selectedSlotId && context.resetBranch
        ? html`
            <label class="sp-reset-label">
              <input
                type="checkbox"
                .checked=${context.resetBranch}
                @change=${(e: Event) => {
                  context.setResetBranch((e.target as HTMLInputElement).checked);
                }}
              />
              Reset to main first
            </label>
          `
        : nothing}
      <button
        class="gate-action-btn"
        style="border-color:${colors.statusFail}; color:${colors.statusFail}; margin-left:auto"
        ?disabled=${context.actionsBlocked}
        @click=${() => context.confirmResolve(run.id, decision, 'abort')}
      >
        Abort Run
      </button>
    </div>
  `;
}

function renderBranchAffinityNudge(
  run: Run,
  decision: RunDecision,
  context: RunDecisionRenderContext,
) {
  const payload = decision.payload as BranchAffinityNudgePayload;
  const cand = payload.candidate;

  return html`
    <style>
      .ban-card {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        padding: 12px;
        background: ${colors.bgSurface};
        border: 1px solid ${colors.bgCard};
        border-left: 3px solid ${colors.accent};
        border-radius: 3px;
        margin: 8px 0;
      }
      .ban-slot {
        font-weight: 600;
        font-size: 14px;
        color: ${colors.textPrimary};
      }
      .ban-meta {
        font-size: 11px;
        color: ${colors.textMuted};
        line-height: 1.6;
      }
      .ban-meta a {
        color: ${colors.accent};
      }
      .ban-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 6px;
      }
      .ban-chip {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 3px;
        background: ${colors.bgCard};
        border: 1px solid ${colors.bgCard};
        color: ${colors.textMuted};
      }
      .ban-chip.danger {
        color: ${colors.statusFail};
        border-color: ${colors.statusFail}55;
      }
      .ban-chip.warn {
        color: ${colors.statusWarn};
        border-color: ${colors.statusWarn}55;
      }
      .ban-files {
        margin-top: 8px;
        padding: 6px 8px;
        background: ${colors.bgCard};
        border-radius: 3px;
        font-size: 10px;
        color: ${colors.textMuted};
        font-family: ${fonts.mono};
      }
      .ban-files-title {
        color: ${colors.statusFail};
        margin-bottom: 4px;
      }
      .ban-files li {
        list-style: none;
        padding-left: 0;
      }
      .ban-actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
        flex-wrap: wrap;
      }
    </style>
    <div class="ban-card">
      <div>
        <div class="ban-slot">${cand.slotId}</div>
        <div class="ban-meta">
          machine ${cand.machine} · branch <code>${cand.branch || '(none)'}</code>
          ${cand.runner ? html` · ${cand.runner}${cand.model ? `/${cand.model}` : ''}` : nothing}
          <br />
          ${cand.currentRunId
            ? html`prior run
                <a href="#run/${cand.currentRunId}">${cand.currentRunId.slice(0, 8)}</a>`
            : 'no prior run'}
          ${cand.currentFlowType ? html` · ${cand.currentFlowType}` : nothing}
          ${cand.dispatchedAt ? html` · dispatched ${cand.dispatchedAt}` : nothing}
        </div>
        <div class="ban-chips">
          <span
            class=${`ban-chip ${cand.ctxPct != null && cand.ctxPct >= 80 ? 'danger' : ''}`}
            title="Worker context-window utilization"
            >ctx ${cand.ctxPct != null ? `${cand.ctxPct}%` : '?'}</span
          >
          <span
            class=${`ban-chip ${cand.uncommittedCount > 0 ? 'danger' : ''}`}
            title="Uncommitted files in worker repo"
            >files ${cand.uncommittedCount}</span
          >
          ${cand.nudgeCount > 0
            ? html`<span class="ban-chip" title="Nudges sent so far">×${cand.nudgeCount}</span>`
            : nothing}
          <span class="ban-chip" title="How the slot's branch matched the PR"
            >${cand.prMatchKind === 'pr-number' ? 'PR# match' : 'branch slug only'}</span
          >
          ${payload.riskFlags.map(
            (f) =>
              html`<span class="ban-chip warn" title="Risk flag from gateway eligibility check"
                >${f}</span
              >`,
          )}
        </div>
      </div>
    </div>
    ${cand.uncommittedCount > 0 && cand.uncommittedFiles.length > 0
      ? html`
          <div class="ban-files">
            <div class="ban-files-title">
              ${cand.uncommittedCount} uncommitted file(s) — worker may stomp these:
            </div>
            <ul>
              ${cand.uncommittedFiles.map((f) => html`<li>${f}</li>`)}
            </ul>
          </div>
        `
      : nothing}
    ${context.branchNudgeShowPicker
      ? html`
          <div style="margin-top:12px; padding-top:12px; border-top:1px solid ${colors.bgCard}">
            <div style="font-size:12px; color:${colors.textMuted}; margin-bottom:8px">
              Pick a free slot to dispatch on instead:
            </div>
            ${renderBranchNudgeFreeSlots(run, decision, payload, context)}
          </div>
        `
      : html`
          <div class="ban-actions">
            ${decision.actions.map((a) => {
              const confirming = context.pendingConfirm === a.id;
              const onClick =
                a.id === 'pick'
                  ? () => {
                      context.setBranchNudgeShowPicker(true);
                      context.setSelectedSlot(null);
                    }
                  : () => context.confirmResolve(run.id, decision, a.id);
              return html`
                <button
                  class="gate-action-btn ${confirming ? 'gate-confirming' : ''}"
                  style="${confirming
                    ? ''
                    : a.style === 'primary'
                      ? `background:${colors.accent}; border-color:${colors.accent}; color:#fff`
                      : a.style === 'danger'
                        ? `border-color:${colors.statusFail}; color:${colors.statusFail}`
                        : `border-color:${colors.textMuted}; color:${colors.textMuted}`}"
                  ?disabled=${context.actionsBlocked}
                  @click=${onClick}
                >
                  ${confirming ? `Confirm ${a.label}?` : a.label}
                </button>
              `;
            })}
          </div>
        `}
  `;
}

function renderBranchNudgeFreeSlots(
  run: Run,
  decision: RunDecision,
  payload: BranchAffinityNudgePayload,
  context: RunDecisionRenderContext,
) {
  const candidates = payload.freeSlotCandidates;
  if (candidates.length === 0) {
    return html`
      <div style="font-size:11px; color:${colors.textMuted}">
        No free slots available.
        <button
          class="gate-action-btn"
          style="border-color:${colors.textMuted}; color:${colors.textMuted}; margin-left:8px"
          @click=${() => {
            context.setBranchNudgeShowPicker(false);
          }}
        >
          Back
        </button>
      </div>
    `;
  }
  return html`
    <style>
      .bnp-slot {
        display: grid;
        grid-template-columns: 1fr 80px 120px 100px;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-bottom: 1px solid ${colors.bgCard};
        cursor: pointer;
        border-left: 3px solid transparent;
      }
      .bnp-slot:hover {
        background: ${colors.bgSurface};
      }
      .bnp-slot.selected {
        border-left-color: ${colors.accent};
        background: ${colors.accent}11;
      }
      .bnp-name {
        font-weight: 600;
        font-size: 12px;
      }
      .bnp-branch {
        font-size: 11px;
        color: ${colors.textMuted};
      }
      .bnp-branch.stale {
        color: ${colors.statusFail};
      }
      .bnp-score {
        font-weight: 700;
        font-size: 13px;
        text-align: right;
      }
      .bnp-actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }
    </style>
    ${candidates.map((c) => {
      const isStale = !!(c.branch && c.branch !== 'main' && c.branch !== '');
      const selected = context.selectedSlotId === c.slotId;
      return html`
        <div
          class="bnp-slot ${selected ? 'selected' : ''}"
          @click=${() => {
            context.setSelectedSlot(c.slotId);
          }}
        >
          <div>
            <div class="bnp-name">${c.slotId}</div>
            <div class="bnp-branch ${isStale ? 'stale' : ''}">${c.branch || 'main'}</div>
          </div>
          <div
            class="bnp-score ${c.score < 50 ? '' : ''}"
            style="color:${c.score < 50 ? colors.statusOk : colors.statusFail}"
          >
            ${c.score}
          </div>
          <div style="font-size:10px;color:${colors.textMuted}">${c.lifecycle}</div>
          <div style="font-size:10px;color:${colors.textMuted}">${c.machine}</div>
        </div>
      `;
    })}
    <div class="bnp-actions">
      <button
        class="gate-action-btn"
        style="background:${colors.accent}; border-color:${colors.accent}; color:#fff"
        ?disabled=${!context.selectedSlotId || context.actionsBlocked}
        @click=${() => context.resolveBranchNudgePick(run.id, decision.id)}
      >
        ${context.selectedSlotId ? `Use ${context.selectedSlotId}` : 'Select a slot'}
      </button>
      <button
        class="gate-action-btn"
        style="border-color:${colors.textMuted}; color:${colors.textMuted}"
        @click=${() => {
          context.setBranchNudgeShowPicker(false);
          context.setSelectedSlot(null);
        }}
      >
        Back
      </button>
    </div>
  `;
}
