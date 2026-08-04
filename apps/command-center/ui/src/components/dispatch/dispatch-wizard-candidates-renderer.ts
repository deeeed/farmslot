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

function candidateBadges(
  candidate: DispatchCandidate,
  hadTask: boolean,
): SlotChoiceOption['badges'] {
  if (candidate.ineligibleReason) {
    return [{ label: 'NOT ELIGIBLE', tone: 'danger', title: candidate.ineligibleReason }];
  }
  if (candidate.nudgeEligible) return [{ label: 'REUSE WORKER', tone: 'warning' }];
  if (candidate.familyAffinity) return [{ label: 'same family', tone: 'positive' }];
  if (hadTask) return [{ label: 'same task', tone: 'accent' }];
  return [];
}

function candidateDetails(candidate: DispatchCandidate): SlotChoiceBadge[] {
  const meta = candidate.nudgeMeta;
  if (!meta) return [];
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
    warning: candidate.nudgeEligible,
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
              }
            }}
          ></slot-choice-list>`
        : html`<span style="font-size:11px; color:${colors.textMuted}">No free slots</span>`}
    </div>
  `;
}
