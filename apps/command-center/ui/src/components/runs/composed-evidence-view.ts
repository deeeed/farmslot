import {
  css,
  html,
  LitElement,
  nothing,
  type PropertyValues,
  type TemplateResult,
  unsafeCSS,
} from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { repeat } from 'lit/directives/repeat.js';

import type {
  RunEvidenceFile,
  RunEvidenceFlow,
  RunEvidenceFlowNode,
  RunEvidenceFlowOccurrence,
  RunEvidenceInvocationTiming,
  RunEvidenceView,
} from '@farmslot/adapter-sdk/evidence';
import type { RecipeTimingQualification } from '@farmslot/protocol/recipe';

import '../shared/media-lightbox.js';

import { colors, spacing } from '../../styles/theme-tokens.js';
import { navigateHash } from '../../utils/url-state.js';
import type { MediaLightbox } from '../shared/media-lightbox.js';
import type { LightboxItem } from '../shared/media-lightbox-types.js';
import { workspaceArtifactBasename } from '../workspace/workspace-artifacts.js';

import {
  composedEvidenceNode,
  composedEvidenceOccurrenceKey,
  type ComposedEvidencePosition,
  composedEvidencePositionFromHash,
  composedEvidenceSelectionHash,
} from './composed-evidence-model.js';

function timingValue(ms: number | null, qualification: RecipeTimingQualification): string {
  if (ms === null || qualification === 'unknown') return 'Unavailable';
  return qualification === 'partial' ? `At least ${ms} ms` : `${ms} ms`;
}

function renderInvocationTiming(timing: RunEvidenceInvocationTiming | undefined) {
  if (!timing) return nothing;
  return html`<dl class="timing" aria-label="Invocation timing">
    <dt>Inclusive</dt>
    <dd>${timingValue(timing.inclusiveMs, timing.qualification.inclusive)}</dd>
    <dt>Self</dt>
    <dd>${timingValue(timing.selfMs, timing.qualification.self)}</dd>
  </dl>`;
}

function renderTimingRollups({ claimTimings, unassignedTiming }: RunEvidenceFlow) {
  const claims = Object.entries(claimTimings ?? {});
  if (!claims.length && !unassignedTiming) return nothing;
  return html`<details class="timing-rollups" aria-label="Timing rollups" open>
    <summary>Timing rollups</summary>
    <dl class="timing">
      ${unassignedTiming
        ? html`<dt>Unassigned</dt>
            <dd>${timingValue(unassignedTiming.durationMs, unassignedTiming.qualification)}</dd>`
        : nothing}
      ${repeat(
        claims,
        ([id]) => id,
        ([id, { durationMs, qualification }]) =>
          html`<dt>${id}</dt>
            <dd>${timingValue(durationMs, qualification)}</dd>`,
      )}
    </dl>
  </details>`;
}

@customElement('composed-evidence-view')
export class ComposedEvidenceView extends LitElement {
  @property({
    attribute: false,
    hasChanged: (next: RunEvidenceView | null, previous: RunEvidenceView | null) =>
      next?.updateId && previous?.updateId
        ? next.updateId !== previous.updateId
        : next !== previous,
  })
  view: RunEvidenceView | null = null;

  @property({ attribute: false }) runId = '';
  @property({ attribute: false }) resolveUrl?: (path: string) => string;
  @state() private position: ComposedEvidencePosition | null = null;
  @state() private collapsed = new Set<string>();
  @state() private opened: LightboxItem[] = [];
  @query('media-lightbox') private player?: MediaLightbox;
  private seekMs: number | null = null;
  private executionId: string | null = null;
  private revealCall = false;
  private nodes = new Map<string, RunEvidenceFlowNode>();

  static styles = css`
    :host {
      display: block;
    }
    section {
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 6px;
      padding: ${unsafeCSS(spacing.md)};
      color: ${unsafeCSS(colors.textPrimary)};
    }
    header,
    .row {
      display: flex;
      align-items: center;
      gap: ${unsafeCSS(spacing.sm)};
    }
    header {
      justify-content: space-between;
      flex-wrap: wrap;
    }
    h3,
    h4 {
      margin: 0;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(15rem, 2fr) minmax(0, 3fr);
      gap: ${unsafeCSS(spacing.md)};
      margin-top: ${unsafeCSS(spacing.sm)};
    }
    .tree {
      max-height: 24rem;
      overflow: auto;
    }
    ul {
      list-style: none;
      margin: 0;
      padding-left: 1rem;
    }
    .tree > ul {
      padding-left: 0;
    }
    button {
      font: inherit;
      color: inherit;
      background: ${unsafeCSS(colors.bgSurface)};
      border: 1px solid ${unsafeCSS(colors.bgCardHover)};
      border-radius: 4px;
      padding: 4px 8px;
      cursor: pointer;
      overflow-wrap: anywhere;
      text-align: left;
    }
    button[aria-current='true'] {
      border-color: ${unsafeCSS(colors.accent)};
    }
    .row {
      margin-bottom: 3px;
    }
    .call {
      flex: 1;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .status,
    .crumbs,
    .binding {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .status {
      white-space: nowrap;
    }
    .call[data-status='fail'] .status {
      color: ${unsafeCSS(colors.statusFail)};
    }
    .details {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .binding,
    .timing-rollups {
      margin: ${unsafeCSS(spacing.sm)} 0;
    }
    .timing-rollups summary {
      cursor: pointer;
    }
    .timing {
      display: grid;
      grid-template-columns: minmax(0, max-content) minmax(6rem, 1fr);
      gap: 4px ${unsafeCSS(spacing.md)};
      margin: ${unsafeCSS(spacing.sm)} 0;
    }
    .timing dt {
      color: ${unsafeCSS(colors.textMuted)};
    }
    .timing dd {
      margin: 0;
      font-variant-numeric: tabular-nums;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    media-lightbox {
      display: block;
      min-height: 300px;
      margin-top: 8px;
    }
    @media (max-width: 760px) {
      .layout {
        grid-template-columns: minmax(0, 1fr);
      }
      .tree {
        max-height: 15rem;
      }
    }
  `;

  private readPosition = () => {
    this.position = composedEvidencePositionFromHash(this.runId, location.hash);
    this.revealCall = true;
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('hashchange', this.readPosition);
    this.readPosition();
  }

  override disconnectedCallback() {
    window.removeEventListener('hashchange', this.readPosition);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    const flow = this.view?.flow;
    const executionId = flow?.recipeRunId ?? null;
    if (changed.has('runId')) this.readPosition();
    if (changed.has('runId') || executionId !== this.executionId) {
      this.executionId = executionId;
      this.revealCall = true;
      this.collapsed = new Set();
      this.opened = [];
      this.seekMs = null;
    }
    if (changed.has('view')) this.nodes = new Map(flow?.nodes.map((node) => [node.id, node]));
  }

  protected override updated() {
    if (this.revealCall) {
      this.revealCall = false;
      const tree = this.renderRoot.querySelector<HTMLElement>('.tree');
      const selected = tree?.querySelector('.call[aria-current="true"]');
      if (tree && selected) {
        const panel = tree.getBoundingClientRect();
        const row = selected.getBoundingClientRect();
        if (row.bottom > panel.bottom) tree.scrollTop += row.bottom - panel.bottom;
        else if (row.top < panel.top) tree.scrollTop -= panel.top - row.top;
      }
    }
    if (this.seekMs === null || !this.player) return;
    this.player.seekToMs(this.seekMs);
    this.seekMs = null;
  }

  private selectCall(recipeRunId: string, invocationId: string) {
    const position = { recipeRunId, invocationId };
    this.position = position;
    navigateHash(composedEvidenceSelectionHash(this.runId, position, location.hash), 'replace');
  }

  private toggle(id: string) {
    const next = new Set(this.collapsed);
    if (!next.delete(id)) next.add(id);
    this.collapsed = next;
  }

  private open(path: string, purpose: string, seekMs: number | null = null) {
    const url = this.resolveUrl?.(path);
    if (!url) return;
    if (this.opened[0]?.path !== path || this.opened[0]?.url !== url) {
      this.opened = [{ path, purpose, url, resolveArtifactUrl: this.resolveUrl }];
    }
    this.seekMs = seekMs;
    this.requestUpdate();
  }

  private closeMedia = () => {
    this.opened = [];
    this.seekMs = null;
  };

  private openFile(file: RunEvidenceFile) {
    this.open(
      file.path,
      file.mediaType === 'video'
        ? 'recording'
        : file.mediaType === 'image'
          ? 'screenshot'
          : 'evidence',
    );
  }

  private renderOccurrence(occurrence: RunEvidenceFlowOccurrence) {
    const cue = occurrence.cue;
    return html`
      <div class="binding" data-occurrence=${composedEvidenceOccurrenceKey(occurrence)}>
        <span>${occurrence.status}</span>
        ${occurrence.claimIds.length
          ? html`<span> · ${occurrence.claimIds.join(', ')}</span>`
          : nothing}
        ${occurrence.decision.case !== null
          ? html`<span> · Branch ${occurrence.decision.case}</span>`
          : nothing}
        ${occurrence.decision.next !== null
          ? html`<span>
              · Next
              ${(occurrence.recipeRunId === this.executionId
                ? this.nodes.get(occurrence.decision.next)?.label
                : undefined) ?? occurrence.decision.next}</span
            >`
          : nothing}
        <div class="actions">
          ${cue
            ? html`<button
                type="button"
                @click=${() => this.open(cue.videoPath, 'recording', cue.startMs)}
              >
                Play step
              </button>`
            : nothing}
          ${repeat(
            occurrence.files,
            (file) => file.path,
            (file) =>
              html`<button type="button" @click=${() => this.openFile(file)}>${file.name}</button>`,
          )}
        </div>
      </div>
    `;
  }

  private renderNodes(
    ids: readonly string[],
    recipeRunId: string,
    selected: string | undefined,
  ): TemplateResult {
    return html`<ul>
      ${repeat(
        ids,
        (id) => JSON.stringify([recipeRunId, id]),
        (id) => {
          const node = this.nodes.get(id);
          if (!node) return nothing;
          const expanded = !this.collapsed.has(id);
          return html`<li>
            <div class="row">
              ${node.children.length
                ? html`<button
                    type="button"
                    aria-label=${`${expanded ? 'Collapse' : 'Expand'} ${node.label}`}
                    aria-expanded=${expanded}
                    @click=${() => this.toggle(id)}
                  >
                    ${expanded ? '−' : '+'}
                  </button>`
                : nothing}
              <button
                type="button"
                class="call"
                aria-current=${selected === id}
                data-invocation=${id}
                data-status=${node.status}
                @click=${() => this.selectCall(recipeRunId, id)}
              >
                <span>${node.label}</span
                ><span class="status"
                  >${node.status}${this.view?.flow?.activeId === id ? ' · Active' : ''}</span
                >
              </button>
            </div>
            ${expanded && node.children.length
              ? this.renderNodes(node.children, recipeRunId, selected)
              : nothing}
          </li>`;
        },
      )}
    </ul>`;
  }

  override render() {
    const flow = this.view?.flow;
    if (!flow) return nothing;
    const selected = composedEvidenceNode(flow, this.position);
    const retained = (this.view?.criteria ?? []).flatMap((criterion) =>
      (criterion.occurrences ?? [])
        .filter((occurrence) => occurrence.recipeRunId !== flow.recipeRunId)
        .map((occurrence) => ({ criterionId: criterion.id, occurrence })),
    );
    return html`
      <section aria-label="Recipe flow" data-testid="composed-evidence-view">
        <header>
          <h3>Recipe flow</h3>
          ${this.view?.run
            ? html`<span data-run-status=${this.view.run.status}>Run ${this.view.run.status}</span>`
            : nothing}
          <span role="status"
            >${flow.progress.total === null
              ? `${flow.progress.completed} complete · total unknown`
              : `${flow.progress.completed}/${flow.progress.total} complete`}</span
          >
        </header>
        <div class="layout">
          <div class="tree">${this.renderNodes([flow.rootId], flow.recipeRunId, selected?.id)}</div>
          <div class="details">
            ${selected
              ? html`
                  <p class="crumbs">
                    ${selected.breadcrumbIds.map((id) => this.nodes.get(id)?.label).join(' › ')}
                  </p>
                  <h4>${selected.label}</h4>
                  ${renderInvocationTiming(selected.timing)}
                  ${repeat(selected.occurrences, composedEvidenceOccurrenceKey, (occurrence) =>
                    this.renderOccurrence(occurrence),
                  )}
                `
              : nothing}
            ${renderTimingRollups(flow)}
            ${retained.length
              ? html`<details>
                  <summary>Evidence from earlier executions</summary>
                  ${repeat(
                    retained,
                    ({ criterionId, occurrence }) =>
                      JSON.stringify([criterionId, composedEvidenceOccurrenceKey(occurrence)]),
                    ({ occurrence }) => this.renderOccurrence(occurrence),
                  )}
                </details>`
              : nothing}
            ${this.view?.videos.length
              ? html`<div class="actions" aria-label="Recordings">
                  ${repeat(
                    this.view.videos,
                    (video) => video.path,
                    (video) => html`
                      <button type="button" @click=${() => this.open(video.path, 'recording')}>
                        ${workspaceArtifactBasename(video.path)}${video.measured
                          ? ''
                          : ' · Untimed'}
                      </button>
                    `,
                  )}
                </div>`
              : nothing}
            ${this.opened.length
              ? html`<button type="button" @click=${this.closeMedia}>Close media</button> ${keyed(
                    JSON.stringify([this.opened[0].path, this.opened[0].url]),
                    html`<media-lightbox
                      embedded
                      open
                      hide-timeline
                      .confine=${false}
                      .items=${this.opened}
                      .selectedIndex=${0}
                      @lightbox-close=${this.closeMedia}
                    ></media-lightbox>`,
                  )}`
              : nothing}
          </div>
        </div>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'composed-evidence-view': ComposedEvidenceView;
  }
}
