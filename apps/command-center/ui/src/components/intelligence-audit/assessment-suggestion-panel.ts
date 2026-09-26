import { css, html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import {
  type AssessmentSuggestionInput,
  type AssessmentSuggestionKind,
  type AssessmentSuggestionView,
  Methods,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { getHashParam } from '../../utils/url-state.js';

/** An explicit, text-only experiment. All three suggestions share one provider path. */
@customElement('assessment-suggestion-panel')
export class AssessmentSuggestionPanel extends LitElement {
  @state() private kind: AssessmentSuggestionKind = 'static-review-checklist';
  @state() private classification: 'public' | 'synthetic' = 'synthetic';
  @state() private sourceRef = '';
  @state() private repo = '';
  @state() private host = 'github.com';
  @state() private number = '';
  @state() private headSha = '';
  @state() private runId = '';
  @state() private context = '';
  @state() private items: Array<{ id: string; text: string; evidence: string }> = [
    { id: '', text: '', evidence: '' },
  ];
  @state() private candidates: Array<{ id: string; description: string }> = [
    { id: '', description: '' },
    { id: '', description: '' },
  ];
  @state() private preview?: AssessmentSuggestionView;
  @state() private result?: AssessmentSuggestionView;
  @state() private approved = false;
  @state() private busy = false;
  @state() private error = '';
  private previewInput?: AssessmentSuggestionInput;
  private revision = 0;
  @state() private linked = false;
  private linkKey = '';
  private readonly onHashChange = () => this.readLink();

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('hashchange', this.onHashChange);
    this.readLink();
  }

  disconnectedCallback() {
    window.removeEventListener('hashchange', this.onHashChange);
    super.disconnectedCallback();
  }

  private readLink() {
    const kind = getHashParam('suggestion');
    const key = kind ? location.hash : '';
    if (!key || key === this.linkKey) return;
    if (
      kind !== 'static-review-checklist' &&
      kind !== 'copilot-context' &&
      kind !== 'review-routing'
    )
      return;
    this.linkKey = key;
    this.changed();
    this.linked = true;
    this.kind = kind;
    if (kind === 'copilot-context') {
      this.runId = getHashParam('run') ?? '';
      this.repo = '';
      this.host = 'github.com';
      this.number = '';
      this.headSha = '';
    } else {
      this.runId = '';
      this.repo = getHashParam('repo') ?? '';
      this.host = getHashParam('host') ?? 'github.com';
      this.number = getHashParam('pr') ?? '';
      // Never use a prior review's head: the operator supplies the exact current SHA.
      this.headSha = '';
    }
    this.context = '';
    this.sourceRef = '';
  }

  static styles = css`
    :host {
      display: block;
    }
    details {
      border: 1px solid #353548;
      border-radius: 6px;
      padding: 12px;
      margin: 14px 0;
    }
    summary {
      cursor: pointer;
      font-weight: 600;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 8px 0;
      font-size: 12px;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .row > label {
      min-width: 160px;
      flex: 1;
    }
    input,
    select,
    textarea,
    button {
      background: #171720;
      color: inherit;
      border: 1px solid #414153;
      border-radius: 4px;
      padding: 7px;
      font: inherit;
    }
    textarea {
      min-height: 76px;
      resize: vertical;
    }
    textarea[name='context'] {
      min-height: 110px;
    }
    button {
      cursor: pointer;
      margin-right: 8px;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .approve {
      display: flex;
      flex-direction: row;
      align-items: center;
    }
    .error {
      color: #ff7777;
    }
    .muted {
      color: #a4a4af;
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 280px;
      overflow-y: auto;
    }
    article {
      padding: 10px;
      border: 1px solid #414153;
      border-radius: 4px;
      margin: 10px 0;
    }
  `;

  private changed() {
    this.revision++;
    this.preview = undefined;
    this.previewInput = undefined;
    this.result = undefined;
    this.approved = false;
    this.error = '';
  }
  private input(): AssessmentSuggestionInput {
    return {
      kind: this.kind,
      source: { classification: this.classification, ref: this.sourceRef.trim() },
      context: this.context.trim(),
      ...(this.kind === 'copilot-context'
        ? {
            runId: this.runId.trim(),
            candidates: this.candidates.map((c) => ({
              id: c.id.trim(),
              description: c.description.trim(),
            })),
          }
        : {
            pr: {
              host: this.host.trim(),
              repo: this.repo.trim(),
              number: Number(this.number),
              headSha: this.headSha.trim(),
            },
          }),
      ...(this.kind === 'static-review-checklist'
        ? {
            items: this.items.map((item) => ({
              id: item.id.trim(),
              text: item.text.trim(),
              evidence: item.evidence.trim(),
            })),
          }
        : {}),
    };
  }
  private async previewPacket() {
    this.changed();
    const revision = this.revision;
    this.busy = true;
    try {
      const input = this.input();
      const preview = await gateway.request<AssessmentSuggestionView>(
        Methods.ASSESSMENT_SUGGESTION_PREVIEW,
        input,
      );
      if (revision !== this.revision) return;
      this.preview = preview;
      this.previewInput = input;
    } catch (error) {
      if (revision === this.revision)
        this.error = error instanceof Error ? error.message : 'Could not preview suggestion';
    } finally {
      this.busy = false;
    }
  }
  private async analyze() {
    if (!this.previewInput || !this.preview?.eligible || !this.preview.packetHash || !this.approved)
      return;
    const revision = this.revision;
    this.busy = true;
    this.error = '';
    try {
      const result = await gateway.request<AssessmentSuggestionView>(
        Methods.ASSESSMENT_SUGGESTION_ANALYZE,
        { input: this.previewInput, expectedPacketHash: this.preview.packetHash, confirmed: true },
      );
      if (revision === this.revision) {
        this.result = result;
        if (!result.eligible) {
          this.preview = undefined;
          this.previewInput = undefined;
          this.approved = false;
        }
      }
      this.dispatchEvent(
        new CustomEvent('suggestion-completed', { bubbles: true, composed: true }),
      );
    } catch (error) {
      if (revision === this.revision)
        this.error = error instanceof Error ? error.message : 'Suggestion could not be assessed';
    } finally {
      this.busy = false;
    }
  }
  private updateItem(index: number, field: 'id' | 'text' | 'evidence', value: string) {
    this.items = this.items.map((item, n) => (n === index ? { ...item, [field]: value } : item));
    this.changed();
  }
  private updateCandidate(index: number, field: 'id' | 'description', value: string) {
    this.candidates = this.candidates.map((item, n) =>
      n === index ? { ...item, [field]: value } : item,
    );
    this.changed();
  }
  render() {
    const result = this.result?.assessment;
    const reason =
      this.result?.reason === 'saved-attempt'
        ? 'Saved failed attempt. Change the packet and preview again to retry.'
        : this.result?.reason === 'assessment-interrupted'
          ? 'The previous attempt was interrupted. Change the packet and preview again to retry.'
          : this.result?.reason;
    return html`<details data-assessment-suggestions ?open=${this.linked}>
      <summary>Try an opt-in assessment suggestion</summary>
      <p class="muted">
        Supply approved public or synthetic text. Preview the exact packet before a call. The answer
        cannot start a review, choose a route, or send a Co-Pilot instruction.
      </p>
      ${this.linked
        ? html`<p class="muted">
            Linked identity only. Add the current evidence yourself and check the exact packet
            before sending.
          </p>`
        : nothing}
      <div class="row">
        <label
          >Suggestion
          <select
            data-action="suggestion-kind"
            .value=${this.kind}
            @change=${(e: Event) => {
              this.kind = (e.target as HTMLSelectElement).value as AssessmentSuggestionKind;
              this.changed();
            }}
          >
            <option value="static-review-checklist">Static-review checklist</option>
            <option value="copilot-context">Co-Pilot next context read</option>
            <option value="review-routing">PR validation depth</option>
          </select>
        </label>
        <label
          >Source type
          <select
            .value=${this.classification}
            @change=${(e: Event) => {
              this.classification = (e.target as HTMLSelectElement).value as 'public' | 'synthetic';
              this.changed();
            }}
          >
            <option value="synthetic">Synthetic</option>
            <option value="public">Public</option>
          </select>
        </label>
        <label
          >${this.classification === 'public' ? 'Public PR URL' : 'Synthetic source ID'}
          <input
            name="source-ref"
            placeholder=${this.classification === 'public'
              ? 'https://github.com/org/repo/pull/123'
              : 'synthetic:pilot-case'}
            .value=${this.sourceRef}
            @input=${(e: Event) => {
              this.sourceRef = (e.target as HTMLInputElement).value;
              this.changed();
            }}
          />
        </label>
      </div>
      ${this.kind === 'copilot-context'
        ? html`<label
            >Linked run ID
            <input
              name="run-id"
              .value=${this.runId}
              @input=${(e: Event) => {
                this.runId = (e.target as HTMLInputElement).value;
                this.changed();
              }}
            />
          </label>`
        : html`<div class="row">
            <label
              >PR host<input
                name="pr-host"
                .value=${this.host}
                @input=${(e: Event) => {
                  this.host = (e.target as HTMLInputElement).value;
                  this.changed();
                }}
            /></label>
            <label
              >Repository (owner/name)<input
                name="repo"
                .value=${this.repo}
                @input=${(e: Event) => {
                  this.repo = (e.target as HTMLInputElement).value;
                  this.changed();
                }}
            /></label>
            <label
              >PR number<input
                name="pr-number"
                type="number"
                min="1"
                .value=${this.number}
                @input=${(e: Event) => {
                  this.number = (e.target as HTMLInputElement).value;
                  this.changed();
                }}
            /></label>
            <label
              >Exact head SHA<input
                name="head-sha"
                .value=${this.headSha}
                @input=${(e: Event) => {
                  this.headSha = (e.target as HTMLInputElement).value;
                  this.changed();
                }}
            /></label>
          </div>`}
      <label
        >${this.kind === 'copilot-context'
          ? 'Diagnostic question and observed facts'
          : 'PR change summary and observed facts'}
        <textarea
          name="context"
          maxlength="4000"
          .value=${this.context}
          @input=${(e: Event) => {
            this.context = (e.target as HTMLTextAreaElement).value;
            this.changed();
          }}
        ></textarea>
      </label>
      ${this.kind === 'static-review-checklist'
        ? html`${this.items.map(
              (item, index) =>
                html`<article>
                  <div class="row">
                    <label
                      >Item ID<input
                        .value=${item.id}
                        @input=${(e: Event) =>
                          this.updateItem(index, 'id', (e.target as HTMLInputElement).value)}
                    /></label>
                    <label
                      >Criterion<input
                        .value=${item.text}
                        @input=${(e: Event) =>
                          this.updateItem(index, 'text', (e.target as HTMLInputElement).value)}
                    /></label>
                  </div>
                  <label
                    >Changed-line excerpt and existing review evidence<textarea
                      .value=${item.evidence}
                      @input=${(e: Event) =>
                        this.updateItem(index, 'evidence', (e.target as HTMLTextAreaElement).value)}
                    ></textarea>
                  </label>
                  ${this.items.length > 1
                    ? html`<button
                        @click=${() => {
                          this.items = this.items.filter((_, n) => n !== index);
                          this.changed();
                        }}
                      >
                        Remove item
                      </button>`
                    : nothing}
                </article>`,
            )}
            <button
              ?disabled=${this.items.length >= 12}
              @click=${() => {
                this.items = [...this.items, { id: '', text: '', evidence: '' }];
                this.changed();
              }}
            >
              Add checklist item
            </button>`
        : nothing}
      ${this.kind === 'copilot-context'
        ? html`${this.candidates.map(
              (item, index) =>
                html`<div class="row">
                  <label
                    >Read-only source ID<input
                      .value=${item.id}
                      @input=${(e: Event) =>
                        this.updateCandidate(index, 'id', (e.target as HTMLInputElement).value)}
                  /></label>
                  <label
                    >What it can reveal<input
                      .value=${item.description}
                      @input=${(e: Event) =>
                        this.updateCandidate(
                          index,
                          'description',
                          (e.target as HTMLInputElement).value,
                        )}
                  /></label>
                  ${this.candidates.length > 2
                    ? html`<button
                        @click=${() => {
                          this.candidates = this.candidates.filter((_, n) => n !== index);
                          this.changed();
                        }}
                      >
                        Remove
                      </button>`
                    : nothing}
                </div>`,
            )}<button
              ?disabled=${this.candidates.length >= 8}
              @click=${() => {
                this.candidates = [...this.candidates, { id: '', description: '' }];
                this.changed();
              }}
            >
              Add source
            </button>`
        : nothing}
      <button data-action="suggestion-preview" ?disabled=${this.busy} @click=${this.previewPacket}>
        Preview packet (no call)
      </button>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${this.preview
        ? html`<article data-suggestion-preview>
            <p>
              Packet ${this.preview.packetHash?.slice(0, 12)} ·
              ${this.preview.provider ?? 'No provider'} / ${this.preview.model ?? 'No model'} ·
              ${this.preview.eligible
                ? 'Ready'
                : `Unavailable: ${this.preview.reason ?? 'check provider and price policy'}`}
            </p>
            <pre>${JSON.stringify(this.preview.packet, null, 2)}</pre>
            <label class="approve"
              ><input
                type="checkbox"
                .checked=${this.approved}
                @change=${(e: Event) => {
                  this.approved = (e.target as HTMLInputElement).checked;
                }}
              />I approve sending this exact public or synthetic packet to the configured
              provider.</label
            >
            <button
              data-action="suggestion-analyze"
              ?disabled=${this.busy || !this.approved || !this.preview.eligible}
              @click=${this.analyze}
            >
              Assess
            </button>
          </article>`
        : nothing}
      ${this.result
        ? html`<article data-suggestion-result>
            <p>
              ${reason ?? result?.status ?? 'Unavailable'} · ${result?.provider ?? 'No provider'} /
              ${result?.returnedModel ?? result?.requestedModel ?? 'No model'}
            </p>
            ${result?.answers
              ? html`<ul>
                  ${Object.entries(result.answers).map(
                    ([id, answer]) =>
                      html`<li>
                        ${id}: ${answer.type === 'choice' ? answer.choice : 'Unavailable'}
                      </li>`,
                  )}
                </ul>`
              : nothing}
            <p>
              ${result?.usage
                ? `${result.usage.inputTokens ?? '?'} input / ${result.usage.outputTokens ?? '?'} output tokens · ${result.usage.durationMs} ms · ${result.usage.costUsd === undefined ? 'cost unknown' : `$${result.usage.costUsd.toFixed(6)} ${result.usage.costKind ?? ''}`}`
                : 'Usage not reported'}
            </p>
            ${result?.assessmentId
              ? html`<a
                  href=${`#intelligence?tab=assessments&assessment=${encodeURIComponent(result.assessmentId)}`}
                  >Inspect and rate saved assessment</a
                >`
              : nothing}
          </article>`
        : nothing}
    </details>`;
  }
}
