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
 * says and never recomputes a verdict from evidence. A run with no ledger may get
 * manifest links instead; those render as "evidence linked", never as a verdict.
 */

import { css, html, nothing, type TemplateResult, unsafeCSS } from 'lit';

import type { EvidenceReviewJudgmentRow } from '@farmslot/adapter-sdk/evidence';
import {
  createEvidenceReviewModel,
  type EvidenceReviewClaim,
  type EvidenceReviewClaimOffers,
  type EvidenceReviewModel,
  proofStepGroups,
} from '@farmslot/adapter-sdk/evidence';
import type {
  AcceptanceCriterionRef,
  AcceptanceCriterionView,
  AcceptanceEvidenceLink,
  AcceptanceRegistration,
  AcceptanceStatusLedger,
  Run,
} from '@farmslot/protocol';
import {
  acceptanceClaimRows,
  acceptancePanelPresentation,
  acceptanceTimingCaption,
  untestableOverrideView,
} from '@farmslot/review-dispatch';

import '../shared/proof-step-details.js';

import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { reasonSheetStyles, renderReasonSheet } from '../shared/reason-sheet.js';

import {
  type AcceptanceClaimListActions,
  acceptanceClaimListStyles,
  renderAcceptanceClaimList,
} from './acceptance-claim-list.js';

export interface AcceptanceClaimOverrideEditor {
  claimId: string | null;
  reason: string;
  select: (id: string | null) => void;
  change: (reason: string) => void;
}

/** Evidence path shown in a row: the basename, with the full path as the tooltip. */
export function evidenceLabel(evidencePath: string): string {
  return evidencePath.split('/').pop() || evidencePath;
}

const AC_BORDER = '1px';
const AC_SUMMARY_HEIGHT = '44px';
const AC_SUMMARY_PADDING_Y = '4px';
/** The collapsed panel's outer height, margins included, for a host that holds its row. */
export const ACCEPTANCE_PANEL_COLLAPSED_HEIGHT = `calc(${AC_SUMMARY_HEIGHT} + 2 * ${AC_SUMMARY_PADDING_Y} + 2 * ${AC_BORDER} + 2 * ${spacing.sm})`;

export const acceptancePanelStyles = css`
  ${unsafeCSS(acceptanceClaimListStyles())}
  .ac-panel {
    margin: ${unsafeCSS(spacing.sm)} 0;
    border: ${unsafeCSS(AC_BORDER)} solid ${unsafeCSS(colors.bgCardHover)};
    border-radius: ${unsafeCSS(radii.sm)};
    background: ${unsafeCSS(colors.bgSurface)};
    font-size: ${unsafeCSS(fonts.sizeXs)};
  }

  .ac-summary {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    min-height: ${unsafeCSS(AC_SUMMARY_HEIGHT)};
    padding: ${unsafeCSS(AC_SUMMARY_PADDING_Y)} ${unsafeCSS(spacing.md)};
    cursor: pointer;
    list-style: none;
    user-select: none;
  }
  .ac-summary::-webkit-details-marker {
    display: none;
  }
  .ac-warning-details > summary {
    min-height: 44px;
    display: flex;
    align-items: center;
    cursor: pointer;
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

  .ac-verdict {
    flex-shrink: 0;
    padding: 0 5px;
    border-radius: 999px;
    border: 1px solid ${unsafeCSS(colors.accent)};
    color: ${unsafeCSS(colors.accent)};
    font-weight: 600;
    text-transform: uppercase;
  }
  .ac-source {
    color: ${unsafeCSS(colors.textMuted)};
    font-style: italic;
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
  button.ac-evidence {
    background: transparent;
    border: 0;
    padding: 0;
    cursor: pointer;
    text-align: left;
    font-size: inherit;
  }
  .ac-evidence:hover {
    text-decoration: underline;
  }

  /* A read failure is louder than any verdict: the record itself is broken. */
  .ac-error {
    color: ${unsafeCSS(colors.statusFail)};
    font-family: ${unsafeCSS(fonts.mono)};
  }

  .ac-package {
    color: ${unsafeCSS(colors.textSecondary)};
    margin-top: ${unsafeCSS(spacing.sm)};
  }
  .ac-package-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: ${unsafeCSS(spacing.sm)};
  }
  .ac-package[data-tone='error'] {
    color: ${unsafeCSS(colors.statusFail)};
  }
  .ac-package[data-tone='error'] .ac-verdict {
    border-color: currentColor;
    color: inherit;
  }
  .ac-package[data-status='Legacy'] .ac-verdict {
    color: inherit;
    border-color: currentColor;
  }
  .ac-package[data-status='Valid'] .ac-verdict {
    color: ${unsafeCSS(colors.statusOk)};
    border-color: currentColor;
  }
  .ac-package details > summary {
    cursor: pointer;
    margin-top: 4px;
  }

  .ac-note {
    padding-left: 3.2em;
    color: ${unsafeCSS(colors.textSecondary)};
  }

  .ac-more-actions {
    padding-left: 3.2em;
    color: ${unsafeCSS(colors.textMuted)};
  }
  .ac-more-actions > summary {
    min-height: 44px;
    display: flex;
    align-items: center;
    cursor: pointer;
  }
  .ac-more-actions > .ac-meta,
  .ac-more-actions > .ac-note {
    padding-left: 0;
  }
  .ac-checks {
    list-style: none;
    margin: 0 0 ${unsafeCSS(spacing.sm)};
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: ${unsafeCSS(spacing.sm)};
  }
  .ac-check {
    display: grid;
    grid-template-columns: 4.5em minmax(0, 1fr) auto;
    column-gap: ${unsafeCSS(spacing.sm)};
    align-items: baseline;
  }
  .ac-check-status {
    font-family: ${unsafeCSS(fonts.mono)};
    color: ${unsafeCSS(colors.textMuted)};
  }
  .ac-check-status[data-ok='true'] {
    color: ${unsafeCSS(colors.statusOk)};
  }
  .ac-check-status[data-ok='false'] {
    color: ${unsafeCSS(colors.statusFail)};
  }
  .ac-check-intent {
    color: ${unsafeCSS(colors.textSecondary)};
  }
  .ac-check-node {
    color: ${unsafeCSS(colors.textMuted)};
  }
  .ac-step-groups {
    display: flex;
    flex-direction: column;
    padding-left: 3.2em;
  }
  .ac-step-group > summary {
    display: flex;
    align-items: center;
    gap: ${unsafeCSS(spacing.sm)};
    min-height: 44px;
    cursor: pointer;
  }
  .ac-step-group-label {
    color: ${unsafeCSS(colors.textPrimary)};
    font-weight: 600;
  }
  .ac-step-group-count {
    color: ${unsafeCSS(colors.textMuted)};
  }
  button.ac-proof-step {
    width: 100%;
    padding: 4px 0;
    font: inherit;
    text-align: left;
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  button.ac-proof-step:hover .ac-check-intent {
    color: ${unsafeCSS(colors.accent)};
  }
  .ac-override {
    margin-top: ${unsafeCSS(spacing.sm)};
  }
  ${unsafeCSS(reasonSheetStyles())}
`;

/** A click on one of a criterion's evidence files: which criterion, its files in order, and which one. */
export interface AcceptanceEvidenceOpen {
  evidenceModel?: EvidenceReviewModel;
  criterion: AcceptanceCriterionView;
  evidence: readonly string[];
  index: number;
}

/** A plain left click; modified and middle clicks keep the browser's own new-tab behaviour. */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export interface AcceptanceEvidenceRow {
  view: EvidenceReviewClaim;
  /** The manifest link, only for a run with no ledger. */
  link?: AcceptanceEvidenceLink;
  /** The files the row lists, in order: the ledger's, else the manifest link's. */
  evidence: string[];
}

/**
 * The panel's rows with the evidence each one lists. Run detail resolves an
 * acceptance evidence link from the same rows, so a reload reopens exactly the
 * files the panel showed.
 */
export function acceptanceEvidenceRows(
  ledger: AcceptanceStatusLedger,
  criteria: ReadonlyArray<AcceptanceCriterionRef> = ledger.criteria,
  evidenceLinks: ReadonlyArray<AcceptanceEvidenceLink> = [],
  model = createEvidenceReviewModel({
    ledger,
    criteria,
    evidenceLinks: ledger.criteria.length ? [] : evidenceLinks,
  }),
): AcceptanceEvidenceRow[] {
  // The gateway sends links only without a ledger; a ledger still wins here.
  const links = ledger.criteria.length === 0 ? evidenceLinks : [];
  const linkById = new Map(links.map((link) => [link.id, link]));
  return model.claims.map((view) => {
    const link = linkById.get(view.id);
    return {
      view,
      ...(link ? { link } : {}),
      evidence: view.evidence.map((file) => file.artifactPath),
    };
  });
}

/** A run's acceptance data as run detail holds it; null means none or not loaded. */
export interface RunAcceptanceData {
  run?: Pick<Run, 'acceptanceRegistration'> | null;
  evidenceModel?: EvidenceReviewModel | null;
  acceptanceStatus?: AcceptanceStatusLedger | null;
  acceptanceCriteria?: AcceptanceCriterionRef[] | null;
  acceptanceStatusError?: string | null;
  acceptanceEvidenceLinks?: AcceptanceEvidenceLink[] | null;
  acceptanceEvidenceLinksError?: string | null;
}

export interface AcceptancePanelInputs {
  registration?: AcceptanceRegistration;
  evidenceModel?: EvidenceReviewModel;
  ledger: AcceptanceStatusLedger;
  criteria?: ReadonlyArray<AcceptanceCriterionRef>;
  error?: string;
  evidenceLinks?: ReadonlyArray<AcceptanceEvidenceLink>;
  evidenceLinksError?: string;
}

/**
 * The panel's ledger and inputs from a run's acceptance data, or null when the
 * panel is hidden. The run page renders from this, and run detail resolves an
 * acceptance evidence link from it, so both read the same rows.
 */
export function acceptancePanelInputs(data: RunAcceptanceData): AcceptancePanelInputs | null {
  const registration = data.run?.acceptanceRegistration;
  if (
    !data.evidenceModel?.claims.length &&
    !data.acceptanceStatus &&
    !data.acceptanceCriteria?.length &&
    !data.acceptanceStatusError &&
    !registration
  ) {
    return null;
  }
  return {
    ...(registration
      ? { registration, criteria: [...registration.original, ...registration.derived] }
      : {}),
    ledger: data.acceptanceStatus ?? { schemaVersion: 1, criteria: [] },
    ...(data.evidenceModel ? { evidenceModel: data.evidenceModel } : {}),
    ...(!registration && data.acceptanceCriteria?.length
      ? { criteria: data.acceptanceCriteria }
      : {}),
    ...(data.acceptanceStatusError ? { error: data.acceptanceStatusError } : {}),
    ...(data.acceptanceEvidenceLinks?.length
      ? { evidenceLinks: data.acceptanceEvidenceLinks }
      : {}),
    ...(data.acceptanceEvidenceLinksError
      ? { evidenceLinksError: data.acceptanceEvidenceLinksError }
      : {}),
  };
}

/** The rows the run page's panel shows, each with its evidence; empty when it is hidden. */
export function runAcceptanceEvidenceRows(data: RunAcceptanceData): AcceptanceEvidenceRow[] {
  const inputs = acceptancePanelInputs(data);
  return inputs
    ? acceptanceEvidenceRows(
        inputs.ledger,
        inputs.criteria,
        inputs.evidenceLinks,
        inputs.evidenceModel,
      )
    : [];
}

/** Each shown criterion with its evidence files: what an acceptance evidence link resolves against. */
export function runAcceptanceCriterionEvidence(
  data: RunAcceptanceData,
): Array<AcceptanceCriterionRef & { evidence: string[] }> {
  return runAcceptanceEvidenceRows(data).map(({ view, evidence }) => ({
    id: view.id,
    text: view.text,
    evidence,
  }));
}

function renderRowDetails(
  { view, evidence }: AcceptanceEvidenceRow,
  model: EvidenceReviewModel,
  evidenceHref?: (evidencePath: string) => string,
  openEvidence?: (open: AcceptanceEvidenceOpen) => void,
  markUntestable?: (id: string, reason: string) => void,
  editor?: AcceptanceClaimOverrideEditor,
): TemplateResult {
  const criterion = view.status;
  // A registered criterion with no verdict yet is a row, not an absence: the panel
  // must show what still has to be judged, and must not imply a verdict.
  const recipeNodes = criterion?.recipeNodes ?? [];
  const display = model.claimDisplay(view.id);
  const renderFiles = (files: typeof display.selected) =>
    html` <div class="ac-meta">
      ${files.map(({ artifactPath: evidencePath }) =>
        evidenceHref
          ? html`<a
              class="ac-evidence"
              data-testid="acceptance-evidence"
              href=${evidenceHref(evidencePath)}
              title=${evidencePath}
              target="_blank"
              rel="noreferrer"
              @click=${(event: MouseEvent) => {
                if (!openEvidence || !isPlainClick(event)) return;
                event.preventDefault();
                model.selectClaim(view.id, evidencePath);
                openEvidence({
                  criterion: view,
                  evidence,
                  index: evidence.indexOf(evidencePath),
                  evidenceModel: model,
                });
              }}
              >${evidenceLabel(evidencePath)}</a
            >`
          : html`<span class="ac-evidence" title=${evidencePath}
              >${evidenceLabel(evidencePath)}</span
            >`,
      )}
    </div>`;
  return html`
    <details class="ac-more-actions">
      <summary>More</summary>
      ${display.clip && !model?.errors.length && openEvidence
        ? html`<button
            class="ac-evidence"
            data-testid="acceptance-clip"
            @click=${() => {
              const selected = model?.selectClaim(view.id);
              const path = selected?.clips[0]?.videoPath;
              if (path)
                openEvidence({
                  criterion: view,
                  evidence,
                  index: evidence.indexOf(model?.artifactPath(path) ?? path),
                  evidenceModel: model,
                });
            }}
          >
            Play proof
          </button>`
        : nothing}
      ${display.selected.length ? renderFiles(display.selected) : nothing}
      ${display.raw.length
        ? html`<details class="ac-meta" data-testid="acceptance-raw-artifacts">
            <summary>raw artifacts (${display.raw.length})</summary>
            ${renderFiles(display.raw)}
          </details>`
        : nothing}
      ${recipeNodes.length || view.occurrences.length
        ? html`<ul class="ac-checks" data-testid="acceptance-check-details">
            ${view.occurrences.map(
              (occurrence) =>
                html`<li class="ac-check">
                  <span class="ac-check-status" data-ok=${String(occurrence.ok)}
                    >${occurrence.ok ? 'pass' : 'fail'}</span
                  >
                  <span class="ac-check-intent">${occurrence.intent}</span>
                  <proof-step-details
                    .step=${occurrence}
                    heading=${`${view.id} · ${occurrence.nodeId}`}
                  ></proof-step-details>
                </li>`,
            )}
            ${recipeNodes
              .filter((node) => !view.occurrences.some((occurrence) => occurrence.nodeId === node))
              .map(
                (node) =>
                  html`<li class="ac-check">
                    <span class="ac-check-status">not run</span>
                    <code class="ac-check-node">${node}</code>
                  </li>`,
              )}
          </ul>`
        : nothing}
      ${view.timing && view.timing !== 'measured'
        ? html`<div class="ac-note">${acceptanceTimingCaption(view.timing)}</div>`
        : nothing}
      ${criterion?.note ? html`<div class="ac-note">${criterion.note}</div>` : nothing}
      ${criterion?.engineVerdict
        ? html`<div class="ac-note">Engine verdict: ${criterion.engineVerdict}</div>`
        : nothing}
      ${markUntestable &&
      !(criterion?.proofMode === 'review' && criterion.verdict === 'proven') &&
      model?.claimOverrideCandidate(view.id)
        ? html`<div class="ac-override">
            ${renderUntestableOverride(view.id, editor, markUntestable)}
          </div>`
        : nothing}
    </details>
  `;
}

/**
 * Skip a criterion: the untestable override (ADR-062 Amendment 4) with its required
 * reason, one action that opens the shared reason sheet. Copy and rule are shared with
 * Companion; the gate's blocker list opens the same sheet.
 */
export function renderUntestableOverride(
  claimId: string,
  editor: AcceptanceClaimOverrideEditor | undefined,
  markUntestable: (claimId: string, reason: string) => void,
) {
  const open = editor?.claimId === claimId;
  const view = untestableOverrideView(claimId, open ? editor.reason : '');
  if (!open)
    return html`<button
      type="button"
      class="gate-secondary"
      data-testid="claim-override-open"
      @click=${() => editor?.select(claimId)}
    >
      ${view.action}
    </button>`;
  return renderReasonSheet({
    title: view.title,
    hint: view.hint,
    label: view.reasonLabel,
    placeholder: view.placeholder,
    value: editor.reason,
    confirmLabel: view.confirm,
    cancelLabel: view.cancel,
    canConfirm: view.canConfirm,
    testId: 'claim-override',
    change: (reason) => editor.change(reason),
    confirm: () => markUntestable(claimId, editor.reason),
    cancel: () => editor.select(null),
  });
}

/**
 * Render the ledger panel. `evidenceHref` turns a task-dir relative evidence path
 * into a link the host can serve; without it the paths render as plain text, which
 * is what a surface with no artifact endpoint should show. `openEvidence` lets the
 * host show a clicked file in its own viewer instead of a new browser window.
 */
export function renderAcceptancePanel(
  ledger: AcceptanceStatusLedger,
  options: {
    expanded?: boolean;
    criterionDrafts?: import('@farmslot/review-dispatch').CriterionDraft[];
    attestationReason?: string;
    registration?: AcceptanceRegistration;
    evidenceModel?: EvidenceReviewModel;
    judgments?: AcceptanceClaimListActions & { rows: readonly EvidenceReviewJudgmentRow[] };
    markUntestable?: (id: string, reason: string) => void;
    overrideEditor?: AcceptanceClaimOverrideEditor;
    showOccurrences?: boolean;
    openOccurrence?: (traceIndex: number) => void;
    evidenceHref?: (evidencePath: string) => string;
    openEvidence?: (open: AcceptanceEvidenceOpen) => void;
    /** Registered criteria, so an unjudged one still gets a row. */
    criteria?: ReadonlyArray<AcceptanceCriterionRef>;
    /** Why the ledger could not be read; shown instead of an empty panel. */
    error?: string | null;
    /** Manifest links for a run with no ledger; labelled as such, never a verdict. */
    evidenceLinks?: ReadonlyArray<AcceptanceEvidenceLink>;
    /** Why the manifest behind the fallback could not be read; shown muted. */
    evidenceLinksError?: string | null;
  } = {},
): TemplateResult | typeof nothing {
  const model =
    options.evidenceModel ??
    createEvidenceReviewModel({
      ledger,
      criteria: options.criteria,
      evidenceLinks: ledger.criteria.length ? [] : options.evidenceLinks,
    });
  const rows = acceptanceEvidenceRows(
    ledger,
    options.criteria ?? ledger.criteria,
    options.evidenceLinks,
    model,
  );
  if (
    rows.length === 0 &&
    !options.error &&
    !options.registration &&
    !model?.packageStatus &&
    !(options.showOccurrences && model?.occurrences.length)
  )
    return nothing;
  const view = acceptancePanelPresentation(
    ledger,
    options.criteria ?? ledger.criteria,
    model,
    options.registration,
  );
  const linked = rows.filter((row) => row.link).length;
  // Like the links, a manifest read error only matters while there is no ledger.
  const linksError = ledger.criteria.length === 0 ? options.evidenceLinksError : null;
  return html`
    <details
      class="ac-panel"
      data-testid="acceptance-panel"
      ?data-proof-steps=${Boolean(options.showOccurrences)}
      ?open=${options.expanded ||
      view.defaultOpen ||
      Boolean(options.error) ||
      Boolean(model?.errors.length) ||
      Boolean(model?.claims.some((claim) => claim.kind === 'qa-case'))}
    >
      <summary class="ac-summary">
        <span class="ac-caret"></span>
        <span class="ac-label">Acceptance criteria</span>
        <span class="ac-count" data-testid="acceptance-counts" title=${view.countsTooltip}
          >${view.counts}${linked > 0 ? ` · ${linked} evidence linked` : ''}</span
        >
        ${linked > 0
          ? html`<span
              class="ac-source"
              data-testid="acceptance-source"
              title="No acceptance ledger: rows show which criteria artifacts/evidence-manifest.json covers. Not a verdict."
              >from evidence manifest, not verdicts</span
            >`
          : nothing}
      </summary>
      ${view.registration?.pending.map(
        (message) =>
          html`<p class="ac-note" data-testid="acceptance-registration-pending">${message}</p>`,
      )}
      ${view.registration?.exclusions.length
        ? html`<details class="ac-note" data-testid="acceptance-exclusions">
            <summary>Excluded sources (${view.registration.exclusions.length})</summary>
            ${view.registration.exclusions.map(
              (source) =>
                html`<p data-source-id=${source.sourceId}>
                  ${source.url
                    ? html`<a href=${source.url} target="_blank" rel="noopener noreferrer"
                        >${source.label}</a
                      >`
                    : source.label}:
                  ${source.reason}
                </p>`,
            )}
          </details>`
        : nothing}
      <div class="ac-rows">
        ${options.error
          ? html`<div class="ac-error" data-testid="acceptance-error">
              ledger unreadable: ${options.error}
            </div>`
          : nothing}
        ${linksError
          ? html`<div class="ac-note ac-source" data-testid="acceptance-evidence-error">
              evidence manifest unreadable: ${linksError}
            </div>`
          : nothing}
        ${renderAcceptanceClaimList(
          acceptanceClaimRows({
            criterionDrafts: options.criterionDrafts,
            attestationReason: options.attestationReason,
            criteria: options.criteria,
            ledger,
            registration: options.registration,
            claims: rows.map(({ view, link }) => ({ ...view, evidenceLinked: Boolean(link) })),
            judgmentRows: options.judgments?.rows ?? model.judgmentRows(null),
            pendingVisualClaimIds: model.pendingVisualClaimIds,
          }),
          {
            ...options.judgments,
            canFocus: options.judgments?.focusClaim
              ? undefined
              : (id) => Boolean(model.claimFocusPath(id)),
            focusClaim:
              options.judgments?.focusClaim ??
              (options.openEvidence
                ? (id) => {
                    const row = rows.find(({ view }) => view.id === id);
                    if (!row || !model.claimFocusPath(id)) return;
                    model.selectClaim(id);
                    const selected = model.claimDisplay(id).selected[0]?.artifactPath;
                    options.openEvidence?.({
                      criterion: row.view,
                      evidence: row.evidence,
                      index: selected ? Math.max(0, row.evidence.indexOf(selected)) : 0,
                      evidenceModel: model,
                    });
                  }
                : undefined),
            details: (id) => {
              const row = rows.find(({ view }) => view.id === id);
              const offers: EvidenceReviewClaimOffers = {
                playable: Boolean(options.openEvidence),
                overridable: Boolean(options.markUntestable),
              };
              return row && model.claimHasDetails(id, offers)
                ? renderRowDetails(
                    row,
                    model,
                    options.evidenceHref,
                    options.openEvidence,
                    options.markUntestable,
                    options.overrideEditor,
                  )
                : nothing;
            },
          },
        )}
        ${model.packageStatus
          ? html`<div
              class="ac-package"
              data-testid="evidence-package-status"
              data-status=${model.packageStatus.status}
              data-tone=${model.packageStatus.tone}
            >
              <div class="ac-package-heading">
                <span class="ac-verdict">${model.packageStatus.status}</span>
                <code>${model.packageStatus.path}</code>
                <span>${model.packageStatus.summary}</span>
              </div>
              ${model.packageStatus.action ? html`<p>${model.packageStatus.action}</p>` : nothing}
              ${model.packageStatus.issues.length
                ? html`<details data-testid="evidence-package-details">
                    <summary>Show details (${model.packageStatus.issues.length} issues)</summary>
                    <ul>
                      ${model.packageStatus.issues.map(
                        (issue) =>
                          html`<li>${issue.message} <span>(${issue.count} messages)</span></li>`,
                      )}
                    </ul>
                  </details>`
                : nothing}
            </div>`
          : nothing}
        ${model.displayWarnings.length
          ? html`<details
              class="ac-note ac-warning-details"
              data-testid="acceptance-warning-details"
            >
              <summary>Evidence details (${model.displayWarnings.length})</summary>
              ${model.displayWarnings.map((warning) => html`<p>${warning}</p>`)}
            </details>`
          : nothing}
        ${options.showOccurrences && model?.occurrences.length
          ? html`<div class="ac-step-groups" data-testid="recipe-proof-steps">
              ${proofStepGroups(model.occurrences).map(
                (group) =>
                  html`<details class="ac-step-group" ?open=${group.failed > 0}>
                    <summary>
                      <span class="ac-step-group-label">${group.label}</span>
                      <span class="ac-step-group-count">${group.steps.length} steps</span>
                      <span class="ac-check-status" data-ok=${String(group.failed === 0)}
                        >${group.failed ? `${group.failed} failed` : 'pass'}</span
                      >
                    </summary>
                    <ul class="ac-checks">
                      ${group.steps.map(
                        (occurrence) =>
                          html`<li>
                            <button
                              class="ac-check ac-proof-step"
                              data-testid="recipe-proof-step"
                              data-trace-index=${occurrence.traceIndex}
                              @click=${() => options.openOccurrence?.(occurrence.traceIndex)}
                            >
                              <span class="ac-check-status" data-ok=${String(occurrence.ok)}
                                >${occurrence.ok ? 'pass' : 'fail'}</span
                              >
                              <span class="ac-check-intent">${occurrence.intent}</span>
                              <code class="ac-check-node">${occurrence.nodeId}</code>
                            </button>
                          </li>`,
                      )}
                    </ul>
                  </details>`,
              )}
            </div>`
          : nothing}
      </div>
    </details>
  `;
}
