/**
 * One renderer for the child checklist unit block (ADR-060), shared by every
 * surface that draws step rows from `TaskProgressStructured`: the progress
 * tracker, the run-detail pipeline panel, and the step inspector.
 *
 * Depth is one level. Each host passes its own row renderer for the child's
 * steps, and that renderer must NOT draw a nested block again — the schema is
 * recursive but v1 renders a single level, matching the depth the mark engine
 * enforces.
 *
 * Parent progress maths stay parent-only: this block is additive markup under a
 * step row and never contributes to the parent's completed/total counts.
 */

import { css, html, nothing, type TemplateResult, unsafeCSS } from 'lit';

import type { TaskStepProgress, TaskStepSubtaskProgress } from '@farmslot/protocol';
import { isSettledSubtaskStatus } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

/** Status pill text. Unknown statuses print raw rather than being swallowed. */
const SUBTASK_STATUS_LABELS: Record<string, string> = {
  running: 'running',
  stale: 'stale',
  blocked: 'blocked',
  complete: 'complete',
  done: 'done',
  failed: 'failed',
};

export interface SubtaskPresentation {
  /** Source ref basename, or `inline` when the child came from command-line text. */
  title: string;
  /** Full provenance for the title tooltip: kind plus the untruncated ref. */
  titleTooltip: string;
  statusLabel: string;
  /** `stale` explains itself with the last child mark time; others name the source of truth. */
  statusTooltip: string;
  counts: string;
  currentStep: string | null;
  settled: boolean;
}

export function subtaskPresentation(subtask: TaskStepSubtaskProgress): SubtaskPresentation {
  const ref = subtask.source.ref?.trim();
  const progress = subtask.progress;
  const statusLabel = SUBTASK_STATUS_LABELS[subtask.status] ?? subtask.status;
  return {
    title: ref ? ref.split('/').pop() || ref : 'inline',
    titleTooltip: ref ? `${subtask.source.kind} · ${ref}` : `${subtask.source.kind} text`,
    statusLabel,
    statusTooltip:
      subtask.status === 'stale'
        ? `No child mark since ${subtask.lastEventAt ?? 'the unit started'}`
        : `Child unit ${subtask.id}: ${statusLabel}`,
    counts: `${progress.completedSteps}/${progress.totalSteps}`,
    currentStep: progress.currentStep,
    settled: isSettledSubtaskStatus(subtask.status),
  };
}

/** One run's view of the open-state memory, as the renderer sees it. */
export interface SubtaskOpenScope {
  /** Open state to bind for this unit, seeding the default on first sight. */
  openFor(subtask: TaskStepSubtaskProgress): boolean;
  /** Record the viewer's choice, from the `<details>` `toggle` event. */
  set(id: string, open: boolean): void;
}

/**
 * Per-host memory of which child units the viewer has opened.
 *
 * The status-derived default (open while the unit is not settled) applies only
 * the first time a unit id is seen in a run. After that the viewer's own
 * expand/collapse wins, so live progress updates — which re-render the whole
 * block on every signal change — cannot snap an open unit shut or re-open one
 * the viewer closed.
 *
 * Entries are keyed by run as well as unit id: a host outlives the run it is
 * showing (run detail swaps runs in place, the slot view follows a slot from
 * one run to the next), and a unit id such as `perps-review` repeats across
 * runs. Without the run in the key, the next run would open showing the last
 * run's expand state.
 */
export class SubtaskOpenState {
  private readonly open = new Map<string, boolean>();
  private readonly scopes = new Map<string, SubtaskOpenScope>();

  /**
   * The scope for a run. Hosts call this every render with their current run
   * id; a run change hands back a scope whose units start from the default
   * again, while re-renders inside one run keep what the viewer chose.
   */
  scope(runId: string | null | undefined): SubtaskOpenScope {
    const run = runId?.trim() || 'no-run';
    const existing = this.scopes.get(run);
    if (existing) return existing;
    const scope: SubtaskOpenScope = {
      openFor: (subtask) => {
        const key = `${run}:${subtask.id}`;
        const remembered = this.open.get(key);
        if (remembered !== undefined) return remembered;
        const initial = !isSettledSubtaskStatus(subtask.status);
        this.open.set(key, initial);
        return initial;
      },
      set: (id, open) => {
        this.open.set(`${run}:${id}`, open);
      },
    };
    this.scopes.set(run, scope);
    return scope;
  }
}

/**
 * Block styles, scoped with an `st-` prefix so a host's own `.step` / `.phase`
 * rules cannot collide. Add to a component's `static styles` array.
 */
export const subtaskBlockStyles = css`
  .st-unit {
    margin: ${unsafeCSS(spacing.xs)} 0 ${unsafeCSS(spacing.xs)} ${unsafeCSS(spacing.lg)};
    border-left: 2px solid ${unsafeCSS(colors.accent)};
    border-radius: 0 ${unsafeCSS(radii.sm)} ${unsafeCSS(radii.sm)} 0;
    background: ${unsafeCSS(colors.bgSurface)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }
  .st-unit.st-complete,
  .st-unit.st-done {
    border-left-color: ${unsafeCSS(colors.statusOk)};
  }
  .st-unit.st-blocked,
  .st-unit.st-failed {
    border-left-color: ${unsafeCSS(colors.statusFail)};
  }
  /* Stale is a muted warning, not an error: the child still owns the step. */
  .st-unit.st-stale {
    border-left-style: dashed;
    border-left-color: ${unsafeCSS(colors.statusWarn)};
    background: ${unsafeCSS(colors.bgSurface)};
    opacity: 0.85;
  }

  .st-summary {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    padding: 3px ${unsafeCSS(spacing.md)};
    cursor: pointer;
    list-style: none;
    user-select: none;
  }
  .st-summary::-webkit-details-marker {
    display: none;
  }
  .st-summary:hover {
    background: ${unsafeCSS(colors.bgCardHover)};
  }

  .st-caret {
    flex-shrink: 0;
    width: 8px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .st-caret::before {
    content: '\\25B8';
  }
  details[open] > .st-summary .st-caret::before {
    content: '\\25BE';
  }

  .st-kind {
    flex-shrink: 0;
    color: ${unsafeCSS(colors.textMuted)};
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .st-title {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .st-id {
    flex-shrink: 0;
    color: ${unsafeCSS(colors.textMuted)};
  }

  .st-pill {
    flex-shrink: 0;
    padding: 0 5px;
    border-radius: 999px;
    border: 1px solid ${unsafeCSS(colors.accent)};
    color: ${unsafeCSS(colors.accent)};
    font-weight: 600;
  }
  .st-complete > .st-summary .st-pill,
  .st-done > .st-summary .st-pill {
    border-color: ${unsafeCSS(colors.statusOk)};
    color: ${unsafeCSS(colors.statusOk)};
  }
  .st-blocked > .st-summary .st-pill,
  .st-failed > .st-summary .st-pill {
    border-color: ${unsafeCSS(colors.statusFail)};
    color: ${unsafeCSS(colors.statusFail)};
  }
  .st-stale > .st-summary .st-pill {
    border-style: dashed;
    border-color: ${unsafeCSS(colors.statusWarn)};
    color: ${unsafeCSS(colors.statusWarn)};
  }

  .st-count {
    flex-shrink: 0;
    color: ${unsafeCSS(colors.textSecondary)};
    font-family: ${unsafeCSS(fonts.mono)};
  }

  .st-current {
    flex: 1;
    min-width: 0;
    color: ${unsafeCSS(colors.textMuted)};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .st-steps {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0 ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.sm)} ${unsafeCSS(spacing.lg)};
  }

  .st-phase {
    display: flex;
    gap: ${unsafeCSS(spacing.sm)};
    padding-top: ${unsafeCSS(spacing.xs)};
    color: ${unsafeCSS(colors.textSecondary)};
    font-weight: 600;
  }
`;

/**
 * Render the child block under a parent step row.
 *
 * @param renderChildStep the host's own step-row renderer, used so the child
 * rows look like the surface they appear on. It is called for child steps only
 * and must not itself render a nested block.
 * @param openScope the host's memory of what the viewer expanded, scoped to the
 * run being shown. Progress updates re-render this block on every signal
 * change, so the open state must come from there and not from the unit's
 * status, which would fight the viewer.
 */
export function renderSubtaskBlock(
  subtask: TaskStepSubtaskProgress,
  renderChildStep: (step: TaskStepProgress) => unknown,
  openScope: SubtaskOpenScope,
): TemplateResult {
  const view = subtaskPresentation(subtask);
  return html`
    <details
      class="st-unit st-${subtask.status}"
      data-testid="subtask-unit"
      data-subtask-id=${subtask.id}
      data-subtask-status=${subtask.status}
      ?open=${openScope.openFor(subtask)}
      @toggle=${(event: Event) =>
        openScope.set(subtask.id, (event.target as HTMLDetailsElement).open)}
    >
      <summary class="st-summary">
        <span class="st-caret"></span>
        <span class="st-kind">sub</span>
        <span class="st-title" title=${view.titleTooltip}>${view.title}</span>
        <span class="st-id">${subtask.id}</span>
        <span class="st-pill" title=${view.statusTooltip}>${view.statusLabel}</span>
        <span class="st-count">${view.counts}</span>
        ${view.currentStep ? html`<span class="st-current">${view.currentStep}</span>` : nothing}
      </summary>
      <div class="st-steps">
        ${subtask.progress.phases.map(
          (phase) => html`
            <div class="st-phase">
              <span>${phase.name}</span>
              <span>${phase.completedSteps}/${phase.totalSteps}</span>
            </div>
            ${phase.steps.map((step) => renderChildStep(step))}
          `,
        )}
      </div>
    </details>
  `;
}
