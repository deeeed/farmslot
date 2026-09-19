/**
 * One renderer for the acceptance-criteria panel (ADR-060 phase 5): the run's
 * ledger, a row per criterion, shared by every surface that shows a run's proof.
 *
 * The ledger belongs to the task directory, not to a step, so this is a panel
 * beside the progress block rather than markup under a step row. Styles follow the
 * child-unit block: scoped `ac-` classes so a host's own rules cannot collide,
 * and `data-testid` hooks so a CDP check can read verdicts off the DOM.
 *
 * Verdicts are the worker's claim, not the gateway's: this renders what the ledger
 * says and never recomputes a verdict from evidence.
 */

import { css, html, nothing, type TemplateResult, unsafeCSS } from 'lit';

import type {
  AcceptanceCriterionRef,
  AcceptanceCriterionView,
  AcceptanceStatusLedger,
} from '@farmslot/protocol';
import { acceptanceCriteriaView, summarizeAcceptanceStatus } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';

export interface AcceptancePanelPresentation {
  /** `2/3 proven`, the count every surface leads with. */
  counts: string;
  /** Long-form tally for the header tooltip, including the zero buckets. */
  countsTooltip: string;
  /** True while any criterion is unproven — the panel opens in that case. */
  hasOpenCriteria: boolean;
}

export function acceptancePanelPresentation(
  ledger: AcceptanceStatusLedger,
  criteria: ReadonlyArray<AcceptanceCriterionRef> = ledger.criteria,
): AcceptancePanelPresentation {
  const summary = summarizeAcceptanceStatus(ledger, criteria);
  return {
    counts: `${summary.proven}/${summary.total} proven`,
    countsTooltip:
      `proven ${summary.proven} · weak ${summary.weak} · missing ${summary.missing} · ` +
      `untestable ${summary.untestable} · no verdict ${summary.unrecorded}`,
    hasOpenCriteria: summary.proven + summary.untestable < summary.total,
  };
}

/** Evidence path shown in a row: the basename, with the full path as the tooltip. */
export function evidenceLabel(evidencePath: string): string {
  return evidencePath.split('/').pop() || evidencePath;
}

export const acceptancePanelStyles = css`
  .ac-panel {
    margin: ${unsafeCSS(spacing.sm)} 0;
    border: 1px solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }

  .ac-summary {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    padding: 4px ${unsafeCSS(spacing.md)};
    cursor: pointer;
    list-style: none;
    user-select: none;
  }
  .ac-summary::-webkit-details-marker {
    display: none;
  }
  .ac-summary:hover {
    background: ${unsafeCSS(colors.bgCardHover)};
  }

  .ac-caret {
    flex-shrink: 0;
    width: 8px;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .ac-caret::before {
    content: '\\25B8';
  }
  details[open] > .ac-summary .ac-caret::before {
    content: '\\25BE';
  }

  .ac-label {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .ac-count {
    color: ${unsafeCSS(colors.textSecondary)};
    font-family: ${unsafeCSS(fonts.mono)};
  }

  .ac-rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.sm)};
  }

  .ac-row {
    display: flex;
    align-items: baseline;
    gap: ${unsafeCSS(spacing.sm)};
  }

  .ac-id {
    flex-shrink: 0;
    width: 3.2em;
    color: ${unsafeCSS(colors.textMuted)};
    font-family: ${unsafeCSS(fonts.mono)};
  }

  .ac-text {
    flex: 1;
    min-width: 0;
    color: ${unsafeCSS(colors.textPrimary)};
  }

  .ac-verdict {
    flex-shrink: 0;
    padding: 0 5px;
    border-radius: 999px;
    border: 1px solid ${unsafeCSS(colors.accent)};
    color: ${unsafeCSS(colors.accent)};
    font-weight: 600;
    text-transform: uppercase;
  }
  .ac-row.ac-proven .ac-verdict {
    border-color: ${unsafeCSS(colors.statusOk)};
    color: ${unsafeCSS(colors.statusOk)};
  }
  /* Weak and missing are the verdicts that block a terminal mark. */
  .ac-row.ac-weak .ac-verdict,
  .ac-row.ac-missing .ac-verdict {
    border-color: ${unsafeCSS(colors.statusFail)};
    color: ${unsafeCSS(colors.statusFail)};
  }
  /* No verdict yet: the neutral accent, never a status colour. */
  .ac-row.ac-none .ac-verdict {
    border-style: dashed;
  }
  .ac-row.ac-untestable .ac-verdict {
    border-style: dashed;
    border-color: ${unsafeCSS(colors.statusWarn)};
    color: ${unsafeCSS(colors.statusWarn)};
  }

  .ac-mode {
    flex-shrink: 0;
    color: ${unsafeCSS(colors.textMuted)};
    font-family: ${unsafeCSS(fonts.mono)};
  }

  .ac-meta {
    display: flex;
    flex-wrap: wrap;
    gap: ${unsafeCSS(spacing.sm)};
    padding-left: 3.2em;
    color: ${unsafeCSS(colors.textMuted)};
  }

  .ac-evidence {
    color: ${unsafeCSS(colors.accent)};
    text-decoration: none;
    font-family: ${unsafeCSS(fonts.mono)};
  }
  .ac-evidence:hover {
    text-decoration: underline;
  }

  .ac-note {
    padding-left: 3.2em;
    color: ${unsafeCSS(colors.textSecondary)};
  }
`;

function renderRow(
  view: AcceptanceCriterionView,
  evidenceHref?: (evidencePath: string) => string,
): TemplateResult {
  const criterion = view.status;
  // A registered criterion with no verdict yet is a row, not an absence: the panel
  // must show what still has to be judged, and must not imply a verdict.
  const verdict = criterion?.verdict ?? 'none';
  return html`
    <div
      class="ac-row ac-${verdict}"
      data-testid="acceptance-row"
      data-ac-id=${view.id}
      data-ac-verdict=${verdict}
    >
      <span class="ac-id">${view.id}</span>
      <span class="ac-text">${view.text}</span>
      ${criterion?.proofMode ? html`<span class="ac-mode">${criterion.proofMode}</span>` : nothing}
      <span class="ac-verdict">${criterion ? criterion.verdict : 'no verdict'}</span>
    </div>
    ${criterion && (criterion.evidence.length > 0 || criterion.recipeNodes.length > 0)
      ? html`
          <div class="ac-meta">
            ${criterion.evidence.map((evidencePath) =>
              evidenceHref
                ? html`<a
                    class="ac-evidence"
                    data-testid="acceptance-evidence"
                    href=${evidenceHref(evidencePath)}
                    title=${evidencePath}
                    target="_blank"
                    rel="noreferrer"
                    >${evidenceLabel(evidencePath)}</a
                  >`
                : html`<span class="ac-evidence" title=${evidencePath}
                    >${evidenceLabel(evidencePath)}</span
                  >`,
            )}
            ${criterion.recipeNodes.map((node) => html`<span>${node}</span>`)}
          </div>
        `
      : nothing}
    ${criterion?.note ? html`<div class="ac-note">${criterion.note}</div>` : nothing}
  `;
}

/**
 * Render the ledger panel. `evidenceHref` turns a task-dir relative evidence path
 * into a link the host can serve; without it the paths render as plain text, which
 * is what a surface with no artifact endpoint should show.
 */
export function renderAcceptancePanel(
  ledger: AcceptanceStatusLedger,
  options: {
    evidenceHref?: (evidencePath: string) => string;
    /** Registered criteria, so an unjudged one still gets a row. */
    criteria?: ReadonlyArray<AcceptanceCriterionRef>;
  } = {},
): TemplateResult | typeof nothing {
  const rows = acceptanceCriteriaView(options.criteria ?? ledger.criteria, ledger);
  if (rows.length === 0) return nothing;
  const view = acceptancePanelPresentation(ledger, options.criteria ?? ledger.criteria);
  return html`
    <details class="ac-panel" data-testid="acceptance-panel" ?open=${view.hasOpenCriteria}>
      <summary class="ac-summary">
        <span class="ac-caret"></span>
        <span class="ac-label">Acceptance criteria</span>
        <span class="ac-count" data-testid="acceptance-counts" title=${view.countsTooltip}
          >${view.counts}</span
        >
      </summary>
      <div class="ac-rows">${rows.map((row) => renderRow(row, options.evidenceHref))}</div>
    </details>
  `;
}
