import { css, html, nothing, unsafeCSS } from 'lit';

import type { Run } from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

type EvalRunBadgeInput = Partial<Pick<Run, 'lane'>> & { variant?: string | null };

/** Eval and comparison runs: the comparison lane, which every eval experiment also runs in. */
export function isEvalRun(run: Partial<Pick<Run, 'lane'>>): boolean {
  return run.lane === 'comparison';
}

/**
 * The eval marker for a run list row or run detail header, with the compared variant. When the
 * flow badge already reads EVAL (eval candidates), the marker names only the variant.
 */
export function evalRunBadge(
  run: EvalRunBadgeInput,
  flowSaysEval = false,
): { label: string; title: string } | null {
  if (!isEvalRun(run)) return null;
  const variant = run.variant?.trim();
  if (!variant)
    return flowSaysEval ? null : { label: 'EVAL', title: 'Evaluation run (comparison lane)' };
  return {
    label: flowSaysEval ? variant : `EVAL · ${variant}`,
    title: `Evaluation run (comparison lane), variant ${variant}`,
  };
}

/** Outlined so it never reads as a flow badge; shared by the run list rows and run detail header. */
export const evalRunBadgeStyles = css`
  .eval-run-badge {
    display: inline-block;
    padding: 1px 6px;
    border: 1px solid ${unsafeCSS(colors.accent)};
    border-radius: 4px;
    color: ${unsafeCSS(colors.accent)};
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    white-space: nowrap;
    vertical-align: middle;
  }
`;

export function renderEvalRunBadge(run: EvalRunBadgeInput, flowSaysEval = false) {
  const badge = evalRunBadge(run, flowSaysEval);
  if (!badge) return nothing;
  return html`<span class="badge eval-run-badge" data-testid="eval-run-badge" title=${badge.title}
    >${badge.label}</span
  >`;
}
