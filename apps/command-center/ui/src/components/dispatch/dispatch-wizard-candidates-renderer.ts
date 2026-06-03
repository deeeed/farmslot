import { html, nothing } from 'lit';

import type { DispatchCandidatesResult, SlotStatus } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

type DispatchCandidate = DispatchCandidatesResult['candidates'][number];
type NudgeIntent = 'nudge' | 'fresh';
type NudgeMeta = NonNullable<DispatchCandidate['nudgeMeta']>;

export interface DispatchCandidateSelectionRenderContext {
  project: string;
  slotOverride: string;
  loadingCandidates: boolean;
  candidates: readonly DispatchCandidate[];
  dispatchableCandidates: readonly DispatchCandidate[];
  nudgeIntents: ReadonlyMap<string, NudgeIntent>;
  nudgeIntentVersion: number;
  sameTaskSlot: SlotStatus | null;
  candidateDispatchable: (candidate: DispatchCandidate) => boolean;
  slotSummaryLabel: (slotId: string) => string;
  selectSlot: (slotId: string) => void;
  setNudgeIntent: (slotId: string, intent: NudgeIntent) => void;
}

export function renderNudgeChips(meta: NudgeMeta) {
  const ctxClass = meta.ctxPct != null && meta.ctxPct >= 80 ? 'chip danger' : 'chip';
  const uncommittedClass = meta.uncommittedCount > 0 ? 'chip danger' : 'chip';
  const matchKindLabel = meta.prMatchKind === 'pr-number' ? 'PR# match' : 'branch slug only';
  return html`
    <span class="cand-nudge-chips">
      <span class=${ctxClass} title="Worker context-window utilization"
        >ctx ${meta.ctxPct != null ? `${meta.ctxPct}%` : '?'}</span
      >
      <span
        class=${uncommittedClass}
        title="Uncommitted files in worker repo (git status --porcelain)"
        >files ${meta.uncommittedCount}</span
      >
      ${meta.nudgeCount > 0
        ? html`<span class="chip" title="Nudges sent to this worker so far"
            >×${meta.nudgeCount}</span
          >`
        : nothing}
      <span class="chip" title="How the slot's branch matched the PR">${matchKindLabel}</span>
      ${meta.riskFlags.length > 0
        ? meta.riskFlags.map(
            (flag) =>
              html`<span class="chip warn" title="Risk flag from gateway eligibility check"
                >${flag}</span
              >`,
          )
        : nothing}
    </span>
  `;
}

export function renderDispatchCandidateSelection(ctx: DispatchCandidateSelectionRenderContext) {
  if (!ctx.project) return nothing;
  const sameTask = ctx.sameTaskSlot;
  const isWorking =
    sameTask && !ctx.candidates.some((candidate) => candidate.slotId === sameTask.slot);

  return html`
    <div>
      <div class="section-label">
        Slot${ctx.slotOverride ? '' : ' (auto)'}${ctx.loadingCandidates
          ? html` <span
              style="color:${colors.textMuted}; text-transform:none; letter-spacing:normal"
              >loading...</span
            >`
          : ''}
      </div>
      ${isWorking
        ? html`
            <div class="same-task-warning">
              <span>Already dispatched:</span>
              <span class="stw-slot">${sameTask.slot}</span>
              <span class="stw-status">${sameTask.lifecycle} / ${sameTask.agent}</span>
            </div>
          `
        : nothing}
      ${ctx.candidates.length > 0
        ? renderCandidateRows(ctx)
        : html`<span style="font-size:11px; color:${colors.textMuted}">No free slots</span>`}
    </div>
  `;
}

function renderCandidateRows(ctx: DispatchCandidateSelectionRenderContext) {
  // Force re-render when nudge intent changes — nudgeIntentVersion is the observable hook
  // into the otherwise mutation-only intents Map.
  void ctx.nudgeIntentVersion;
  const firstDispatchable = ctx.dispatchableCandidates[0]?.slotId ?? '';

  return html`
    <div class="candidate-list">
      ${ctx.candidates.map((candidate, index) =>
        renderCandidateRow(ctx, candidate, index, firstDispatchable),
      )}
    </div>
  `;
}

function renderCandidateRow(
  ctx: DispatchCandidateSelectionRenderContext,
  candidate: DispatchCandidate,
  index: number,
  firstDispatchable: string,
) {
  const dispatchable = ctx.candidateDispatchable(candidate);
  const isSelected =
    dispatchable &&
    (ctx.slotOverride
      ? ctx.slotOverride === candidate.slotId
      : candidate.slotId === firstDispatchable);
  const sameTask = ctx.sameTaskSlot;
  const hadTask = sameTask?.slot === candidate.slotId;
  const taskLabel = ctx.slotSummaryLabel(candidate.slotId);
  const meta = candidate.nudgeMeta;
  const canNudge = Boolean(meta?.canNudge);
  const intent = candidate.nudgeEligible
    ? (ctx.nudgeIntents.get(candidate.slotId) ?? (canNudge ? 'nudge' : 'fresh'))
    : undefined;
  const titleSuffix = candidate.nudgeEligible
    ? canNudge
      ? ` — busy worker on this PR's branch; pick Nudge to reuse session or Fresh to relaunch`
      : ` — busy worker on this PR's branch (runner doesn't support live nudge — Fresh dispatch only)`
    : '';

  return html`
    <button
      class="candidate-row ${isSelected ? 'selected' : ''} ${candidate.nudgeEligible
        ? 'nudge-eligible'
        : ''}"
      ?disabled=${!dispatchable}
      title=${dispatchable
        ? `Select ${candidate.slotId}${titleSuffix}`
        : `${candidate.slotId} is ${candidate.lifecycle}; use Queue or choose a free slot`}
      @click=${() => {
        if (dispatchable) ctx.selectSlot(candidate.slotId);
      }}
    >
      <span class="cand-rank">${isSelected ? '#1' : dispatchable ? `#${index + 1}` : '--'}</span>
      <span class="cand-id">${candidate.slotId}</span>
      ${candidate.nudgeEligible
        ? html`<span class="cand-nudge-badge">REUSE WORKER</span>`
        : nothing}
      ${hadTask && !candidate.nudgeEligible
        ? html`<span class="cand-reuse">same task</span>`
        : nothing}
      <span class="cand-summary">
        <span class="cand-branch ${candidate.onMain ? '' : 'stale'}"
          >${candidate.onMain ? 'main' : candidate.branch || 'main'}</span
        >
        ${taskLabel ? html`<span class="cand-task">${taskLabel}</span>` : nothing}
        ${meta ? renderNudgeChips(meta) : nothing}
      </span>
      <span class="cand-meta">
        ${candidate.nudgeEligible
          ? renderNudgeActions(ctx, candidate, canNudge, intent)
          : renderFreeSlotMeta(candidate)}
      </span>
    </button>
  `;
}

function renderNudgeActions(
  ctx: DispatchCandidateSelectionRenderContext,
  candidate: DispatchCandidate,
  canNudge: boolean,
  intent: NudgeIntent | undefined,
) {
  return html`
    <span class="cand-actions" @click=${(event: Event) => event.stopPropagation()}>
      <button
        class="nudge-action ${intent === 'nudge' ? 'on' : ''}"
        ?disabled=${!canNudge}
        title=${canNudge
          ? 'Reuse the existing tmux session — skip prepare, send-keys the new TASK.md prompt'
          : `Nudge unavailable for this runner/candidate. Use Fresh dispatch.`}
        @click=${() => {
          if (canNudge) ctx.setNudgeIntent(candidate.slotId, 'nudge');
        }}
      >
        Nudge
      </button>
      <button
        class="nudge-action ${intent === 'fresh' ? 'on' : ''}"
        title="Kill the current worker on this slot and dispatch a fresh run"
        @click=${() => ctx.setNudgeIntent(candidate.slotId, 'fresh')}
      >
        Fresh
      </button>
    </span>
  `;
}

function renderFreeSlotMeta(candidate: DispatchCandidate) {
  return html`
    <span class="cand-cdp" style="color:${candidate.cdpLive ? colors.statusOk : colors.textMuted}"
      >${candidate.cdpLive ? 'CDP' : '---'}</span
    >
    <span class="cand-lifecycle">${candidate.lifecycle}</span>
    <span class="cand-score">${candidate.score}</span>
  `;
}
