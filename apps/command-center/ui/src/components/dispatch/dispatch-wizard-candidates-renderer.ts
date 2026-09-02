import { html, nothing } from 'lit';

import { DEFAULT_BRANCH, type DispatchCandidatesResult, type SlotStatus } from '@farmslot/protocol';

import '../shared/slot-choice-list.js';

import { colors } from '../../styles/theme-tokens.js';
import type {
  SlotChoiceActionDetail,
  SlotChoiceBadge,
  SlotChoiceChangeDetail,
  SlotChoiceOption,
} from '../shared/slot-choice-list.js';

type DispatchCandidate = DispatchCandidatesResult['candidates'][number];
type NudgeIntent = 'nudge' | 'fresh';

export interface DispatchCandidateSelectionRenderContext {
  project: string;
  slotOverride: string;
  loadingCandidates: boolean;
  candidateRefreshFailed: boolean;
  candidates: readonly DispatchCandidate[];
  dispatchableCandidates: readonly DispatchCandidate[];
  nudgeIntents: ReadonlyMap<string, NudgeIntent>;
  nudgeIntentVersion: number;
  sameTaskSlot: SlotStatus | null;
  candidateDispatchable: (candidate: DispatchCandidate) => boolean;
  /** Backend-flagged overridable pressure rejection on this row. */
  pressureOverrideAvailable: (candidate: DispatchCandidate) => boolean;
  slotSummaryLabel: (slotId: string) => string;
  selectSlot: (slotId: string) => void;
  refreshSlots: () => void;
  setNudgeIntent: (slotId: string, intent: NudgeIntent) => void;
  /** Select a pressure-rejected row to collect the deliberate override. The
   * intent keeps a busy nudge candidate on its reuse path (nudge/fresh)
   * instead of degrading to an invalid busy-slot fresh dispatch. */
  beginPressureOverride: (slotId: string, intent?: NudgeIntent) => void;
}

function candidateBadges(
  candidate: DispatchCandidate,
  hadTask: boolean,
): SlotChoiceOption['badges'] {
  const badges: SlotChoiceBadge[] = [];
  if (candidate.ineligibleReason) {
    badges.push({
      label: candidate.ineligibilitySource === 'pressure' ? 'PRESSURE REJECTED' : 'NOT ELIGIBLE',
      tone: 'danger',
      title: candidate.ineligibleReason,
    });
  }
  if (candidate.nudgeEligible) badges.push({ label: 'REUSE WORKER', tone: 'warning' });
  if (candidate.replaceableWarm) {
    badges.push({
      label: 'WARM · REPLACE',
      tone: 'warning',
      title: 'No active run owns this warm runner. A new dispatch replaces it before prepare.',
    });
  }
  if (badges.length > 0) return badges;
  if (candidate.familyAffinity) return [{ label: 'same family', tone: 'positive' }];
  if (hadTask) return [{ label: 'same task', tone: 'accent' }];
  return [];
}

function pressureCauseDetails(candidate: DispatchCandidate): SlotChoiceBadge[] {
  const decision = candidate.pressureAdmission;
  if (decision?.outcome !== 'rejected') return [];
  return decision.causes.slice(0, 3).map((cause) => ({
    label: `${cause.process} ${Math.round(cause.cpuPercent)}%`,
    title: `${cause.classification}/${cause.confidence}, ${cause.processCount} process(es)${cause.cleanupEligible ? '' : '; explains pressure, not a cleanup target'}`,
    tone: 'warning' as const,
  }));
}

function candidateDetails(candidate: DispatchCandidate): SlotChoiceBadge[] {
  const meta = candidate.nudgeMeta;
  if (!meta) return pressureCauseDetails(candidate);
  return [
    {
      label: `ctx ${meta.ctxPct != null ? `${meta.ctxPct}%` : '?'}`,
      title: 'Worker context-window utilization',
      tone: meta.ctxPct != null && meta.ctxPct >= 80 ? 'danger' : 'neutral',
    },
    {
      label: `files ${meta.uncommittedCount}`,
      title: 'Uncommitted files in worker repo (git status --porcelain)',
      tone: meta.uncommittedCount > 0 ? 'danger' : 'neutral',
    },
    ...(meta.nudgeCount > 0
      ? [{ label: `×${meta.nudgeCount}`, title: 'Nudges sent to this worker so far' }]
      : []),
    {
      label: meta.prMatchKind === 'pr-number' ? 'PR# match' : 'branch slug only',
      title: "How the slot's branch matched the PR",
    },
    ...meta.riskFlags.map((flag) => ({
      label: flag,
      title: 'Risk flag from gateway eligibility check',
      tone: 'warning' as const,
    })),
    ...pressureCauseDetails(candidate),
  ];
}

function candidateOption(
  ctx: DispatchCandidateSelectionRenderContext,
  candidate: DispatchCandidate,
  index: number,
  selectedSlot: string,
): SlotChoiceOption {
  const dispatchable = ctx.candidateDispatchable(candidate);
  const selected = dispatchable && candidate.slotId === selectedSlot;
  const hadTask = ctx.sameTaskSlot?.slot === candidate.slotId;
  const meta = candidate.nudgeMeta;
  const canNudge = Boolean(meta?.canNudge);
  const intent = candidate.nudgeEligible
    ? (ctx.nudgeIntents.get(candidate.slotId) ?? (canNudge ? 'nudge' : 'fresh'))
    : undefined;
  const titleSuffix = candidate.nudgeEligible
    ? canNudge
      ? " — busy worker on this PR's branch; pick Nudge to reuse session or Fresh to relaunch"
      : " — busy worker on this PR's branch (runner doesn't support live nudge — Fresh dispatch only)"
    : candidate.replaceableWarm
      ? ' — unowned warm runner; dispatch replaces it before prepare'
      : '';
  return {
    slotId: candidate.slotId,
    rank: selected ? '#1' : dispatchable ? `#${index + 1}` : '--',
    branch: candidate.branch || DEFAULT_BRANCH,
    task: ctx.slotSummaryLabel(candidate.slotId),
    lifecycle: candidate.lifecycle,
    state: String(candidate.score),
    stateSortValue: candidate.score,
    disabled: !dispatchable,
    stale: !candidate.onMain,
    warning: candidate.nudgeEligible || candidate.replaceableWarm,
    title: dispatchable
      ? `Select ${candidate.slotId}${titleSuffix}`
      : candidate.ineligibleReason
        ? `${candidate.slotId}: ${candidate.ineligibleReason}`
        : `${candidate.slotId} is ${candidate.lifecycle}; use Queue or choose a free slot`,
    badges: candidateBadges(candidate, hadTask),
    details: candidateDetails(candidate),
    actions:
      candidate.nudgeEligible && !candidate.ineligibleReason
        ? [
            {
              id: 'nudge',
              label: 'Nudge',
              active: intent === 'nudge',
              disabled: !canNudge,
              title: canNudge
                ? 'Reuse the existing tmux session — skip prepare and deliver the new task'
                : 'Nudge unavailable for this runner/candidate. Use Fresh dispatch.',
            },
            {
              id: 'fresh',
              label: 'Fresh',
              active: intent === 'fresh',
              title: 'Stop the current worker on this slot and dispatch a fresh run',
            },
          ]
        : ctx.pressureOverrideAvailable(candidate)
          ? candidate.replaceableWarm
            ? [
                {
                  id: 'pressure-override-fresh',
                  label: 'Override + Fresh',
                  active: candidate.slotId === selectedSlot,
                  title:
                    'Machine is pressure-rejected. Review the decision, confirm a one-dispatch override, and replace the unowned warm runner.',
                },
              ]
            : candidate.nudgeEligible
              ? canNudge
                ? [
                    {
                      id: 'pressure-override-nudge',
                      label: 'Override + Nudge',
                      active: candidate.slotId === selectedSlot,
                      title:
                        'Machine is pressure-rejected. Review the decision, confirm a one-dispatch override, and reuse the existing worker session.',
                    },
                  ]
                : [
                    {
                      id: 'pressure-override-fresh',
                      label: 'Override + Fresh',
                      active: candidate.slotId === selectedSlot,
                      title:
                        'Machine is pressure-rejected and this runner cannot be nudged. Review the decision, confirm a one-dispatch override, and relaunch fresh.',
                    },
                  ]
              : [
                  {
                    id: 'pressure-override',
                    label: 'Override',
                    active: candidate.slotId === selectedSlot,
                    title:
                      'Machine is pressure-rejected. Select to review the decision and confirm a one-dispatch override.',
                  },
                ]
          : [],
  };
}

export function renderDispatchCandidateSelection(ctx: DispatchCandidateSelectionRenderContext) {
  if (!ctx.project) return nothing;
  void ctx.nudgeIntentVersion;
  const sameTask = ctx.sameTaskSlot;
  const isWorking =
    sameTask && !ctx.candidates.some((candidate) => candidate.slotId === sameTask.slot);
  const firstDispatchable = ctx.dispatchableCandidates[0]?.slotId ?? '';
  const selectedSlot = ctx.slotOverride || firstDispatchable;
  const options = ctx.candidates.map((candidate, index) =>
    candidateOption(ctx, candidate, index, selectedSlot),
  );

  return html`
    <div>
      <div class="section-label slot-section-label">
        <span>Slot${ctx.slotOverride ? '' : ' (auto)'}</span>
        ${ctx.loadingCandidates ? html` <span class="slot-loading">loading...</span>` : nothing}
        <button
          class="slot-refresh"
          type="button"
          ?disabled=${ctx.loadingCandidates}
          title="Recheck slot availability on each host"
          @click=${() => ctx.refreshSlots()}
        >
          Refresh
        </button>
      </div>
      ${ctx.candidateRefreshFailed
        ? html`<div class="error-inline">
            Slot list failed to refresh. Use Refresh to retry without changing farm or type.
          </div>`
        : nothing}
      ${isWorking
        ? html`
            <div class="same-task-warning">
              <span>Already dispatched:</span>
              <span class="stw-slot">${sameTask.slot}</span>
              <span class="stw-status">${sameTask.lifecycle} / ${sameTask.agent}</span>
            </div>
          `
        : nothing}
      ${options.length > 0
        ? html`<slot-choice-list
            .project=${ctx.project}
            .options=${options}
            .selectedSlots=${selectedSlot ? [selectedSlot] : []}
            .showAnyEligible=${false}
            selectionMode="single"
            secondaryLabel="Score"
            @slot-choice-change=${(event: CustomEvent<SlotChoiceChangeDetail>) => {
              const slotId = event.detail.allowedSlots?.[0];
              if (slotId) ctx.selectSlot(slotId);
            }}
            @slot-choice-action=${(event: CustomEvent<SlotChoiceActionDetail>) => {
              if (event.detail.actionId === 'nudge' || event.detail.actionId === 'fresh') {
                ctx.setNudgeIntent(event.detail.slotId, event.detail.actionId);
              } else if (event.detail.actionId === 'pressure-override') {
                ctx.beginPressureOverride(event.detail.slotId);
              } else if (event.detail.actionId === 'pressure-override-nudge') {
                ctx.beginPressureOverride(event.detail.slotId, 'nudge');
              } else if (event.detail.actionId === 'pressure-override-fresh') {
                ctx.beginPressureOverride(event.detail.slotId, 'fresh');
              }
            }}
          ></slot-choice-list>`
        : html`<span style="font-size:11px; color:${colors.textMuted}">No free slots</span>`}
    </div>
  `;
}
