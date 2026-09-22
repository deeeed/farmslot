import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { type AssessmentRecord, type FailureTriageView, Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

const checks: Record<string, string> = {
  inspect_prepare: 'Inspect preparation and configuration',
  inspect_dependency_resolution: 'Inspect installed dependencies',
  inspect_failed_assertion: 'Inspect the failing assertion and application code',
  inspect_test_fixture: 'Inspect test setup and expectations',
  inspect_evidence: 'Inspect the validation evidence',
  inspect_external_response: 'Inspect the recorded service response',
  inspect_more_context: 'Collect more causal context',
};

@customElement('failure-triage-panel')
export class FailureTriagePanel extends LitElement {
  @property() runId = '';
  @property() runVersion = '';
  @state() private view?: FailureTriageView;
  @state() private busy = false;
  @state() private analyzing = false;
  @state() private error = '';
  @state() private used = false;
  @state() private correction = '';
  private generation = 0;
  static styles = css`
    :host {
      display: block;
      margin: 12px 0;
      color: inherit;
    }
    details {
      border: 1px solid var(--border-color, #374151);
      border-radius: 8px;
      padding: 12px;
    }
    summary {
      cursor: pointer;
      font-weight: 600;
    }
    p {
      margin: 8px 0;
      font-size: 13px;
    }
    button,
    select {
      color: inherit;
      background: #171727;
      border: 1px solid #555570;
      border-radius: 4px;
      font: inherit;
      font-size: 12px;
      margin: 4px 6px 4px 0;
      padding: 6px 10px;
      cursor: pointer;
    }
    button:disabled {
      cursor: default;
      opacity: 0.5;
    }
    .warning {
      color: var(--warning-color, #eab308);
    }
    pre {
      max-height: 260px;
      overflow: auto;
      white-space: pre-wrap;
      font-size: 12px;
    }
    small {
      display: block;
      opacity: 0.75;
    }
  `;
  protected updated(changed: Map<string, unknown>) {
    if (changed.has('runId') || changed.has('runVersion')) {
      this.view = undefined;
      this.used = false;
      this.correction = '';
      if (this.runId) void this.load();
    }
  }
  private async load(includeEvidence = false) {
    const generation = ++this.generation;
    this.busy = true;
    this.analyzing = false;
    this.error = '';
    try {
      const view = await gateway.request<FailureTriageView>(Methods.FAILURE_TRIAGE_GET, {
        runId: this.runId,
        includeEvidence,
      });
      if (generation === this.generation) {
        if (this.view?.record?.id !== view.record?.id) {
          this.correction = '';
          this.used = false;
        }
        this.view = view;
      }
    } catch {
      if (generation === this.generation)
        this.error = 'Advice could not be loaded. Refresh to retry.';
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
  private async analyze() {
    const v = this.view;
    if (!v?.snapshotHash || v.availability !== 'ready') return;
    const generation = ++this.generation;
    const retryOf = v.retryAllowed && v.record ? v.record.id : undefined;
    this.busy = true;
    this.analyzing = true;
    this.error = '';
    try {
      const view = await gateway.request<FailureTriageView>(Methods.FAILURE_TRIAGE_ANALYZE, {
        runId: this.runId,
        step: v.step,
        snapshotHash: v.snapshotHash,
        ...(retryOf ? { retryOf } : {}),
      });
      if (generation === this.generation) {
        if (this.view?.record?.id !== view.record?.id) {
          this.correction = '';
          this.used = false;
        }
        this.view = view;
      }
    } catch {
      if (generation === this.generation)
        this.error = 'Advice was not returned. Refresh its saved status before retrying.';
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.analyzing = false;
      }
    }
  }
  private async feedback(verdict: 'correct' | 'incorrect' | 'insufficient-context') {
    const record = this.view?.record;
    if (!record || this.busy || (verdict === 'incorrect' && !this.correction)) return;
    const generation = ++this.generation;
    this.busy = true;
    this.error = '';
    try {
      const updated = await gateway.request<AssessmentRecord>(Methods.FAILURE_TRIAGE_FEEDBACK, {
        id: record.id,
        expectedRevision: record.feedback.length,
        questionId: 'cause',
        verdict,
        adviceUsed: this.used,
        adviceShown: true,
        evidenceRef: 'operator:manual-check',
        ...(verdict === 'incorrect' ? { correctedAnswer: this.correction } : {}),
      });
      if (generation === this.generation && this.view)
        this.view = { ...this.view, record: updated };
    } catch {
      if (generation === this.generation)
        this.error = 'Feedback was not saved. Refresh before retrying.';
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
  render() {
    const v = this.view?.runId === this.runId ? this.view : undefined,
      record = v?.record,
      usage = record?.result?.usage;
    const displayState = this.busy
      ? this.analyzing
        ? 'analyzing'
        : 'loading'
      : !v
        ? 'loading configuration'
        : v.availability !== 'ready'
          ? v.availability.replaceAll('-', ' ')
          : v.stale && record
            ? 'stale'
            : ['skipped', 'disabled'].includes(record?.status ?? '') &&
                record?.result?.attempted === false
              ? 'not assessed'
              : record?.status === 'started'
                ? 'analyzing'
                : record?.status === 'interrupted' || record?.status === 'unavailable'
                  ? 'unavailable'
                  : v.advice?.cause === 'unclear'
                    ? 'unclear'
                    : record?.status === 'completed'
                      ? 'completed'
                      : 'ready';
    const causeAnswer = record?.result?.answers?.cause;
    const corrections =
      causeAnswer?.type === 'choice'
        ? Object.keys(causeAnswer.probabilities).filter((c) => c !== causeAnswer.choice)
        : [];
    const input = v?.input;
    const excerpts =
      input && typeof input === 'object' && !Array.isArray(input) && Array.isArray(input.evidence)
        ? input.evidence.flatMap((e) =>
            e && typeof e === 'object' && !Array.isArray(e) && typeof e.text === 'string'
              ? [{ id: typeof e.id === 'string' ? e.id : 'Evidence', text: e.text }]
              : [],
          )
        : [];
    return html`<details>
      <summary id="failure-triage-summary">Experimental failure advice</summary>
      ${this.error ? html`<p role="alert" class="warning">${this.error}</p>` : nothing}
      <p data-triage-state>${displayState}</p>
      <p>${v?.reason ?? ''}</p>
      <p>Recorded step: ${v?.step ?? record?.subject.run?.step ?? 'unavailable'}</p>
      <p>${v?.provider ?? 'No provider selected'} / ${v?.model ?? 'No model selected'}</p>
      ${v?.stale && record
        ? html`<p class="warning">Saved advice belongs to an older or unavailable snapshot.</p>`
        : nothing}
      ${record
        ? html`<p>Response: ${record.status} · ${record.startedAt}</p>
            <small>Returned model: ${record.result?.returnedModel ?? 'not reported'}</small>`
        : nothing}
      ${v?.advice
        ? html`<p>Cause: ${v.advice.cause.replaceAll('_', ' ')}</p>
            <p>${checks[v.advice.nextCheck] ?? 'Inspect the recorded evidence'}</p>
            ${v.advice.evidence.map(
              (e) =>
                html`<small>${e.id}: ${e.sourceId} · source hash ${e.digest.slice(0, 12)}</small>`,
            )}`
        : nothing}
      ${record
        ? html`<p>
              ${usage?.inputTokens ?? 'Unknown'} input tokens · ${usage?.outputTokens ?? 'unknown'}
              output tokens · ${usage?.durationMs ?? 'unknown'} ms
            </p>
            <p>
              Estimated cost:
              ${usage?.costUsd === undefined ? 'unknown' : `$${usage.costUsd.toFixed(6)}`} ·
              reserved maximum: $${record.reservation?.maxUsd.toFixed(6) ?? 'unknown'}
            </p>`
        : nothing}
      <button ?disabled=${this.busy} @click=${() => this.load()}>Refresh</button>
      <button
        ?disabled=${this.busy || v?.availability !== 'ready'}
        data-triage-action="analyze"
        @click=${this.analyze}
      >
        ${!v?.stale && record?.status === 'completed'
          ? 'Use saved advice'
          : v?.retryAllowed
            ? 'Retry advice once'
            : 'Analyze once'}
      </button>
      ${record?.requestedIdentity?.inputDigest
        ? html`<button
            ?disabled=${this.busy}
            data-triage-action="evidence"
            @click=${() => this.load(true)}
          >
            Show assessed text
          </button>`
        : nothing}
      ${excerpts.map(
        (e) =>
          html`<small>Assessed text ${e.id}</small>
            <pre>${e.text}</pre>`,
      )}
      ${v?.advice && record?.status === 'completed'
        ? html`<p>Your feedback is observational.</p>
            <label
              ><input
                type="checkbox"
                .checked=${this.used}
                @change=${(e: Event) => (this.used = (e.target as HTMLInputElement).checked)}
              />
              I used this advice</label
            ><br />
            <label
              >Corrected cause
              <select
                id="failure-triage-correction"
                .value=${this.correction}
                @change=${(e: Event) => (this.correction = (e.target as HTMLSelectElement).value)}
              >
                <option value="">Choose a correction</option>
                ${corrections.map(
                  (c) => html`<option value=${c}>${c.replaceAll('_', ' ')}</option>`,
                )}
              </select> </label
            ><br />
            <button
              ?disabled=${this.busy}
              data-triage-feedback="correct"
              @click=${() => this.feedback('correct')}
            >
              Correct
            </button>
            <button
              ?disabled=${this.busy || !this.correction}
              data-triage-feedback="incorrect"
              @click=${() => this.feedback('incorrect')}
            >
              Incorrect
            </button>
            <button ?disabled=${this.busy} @click=${() => this.feedback('insufficient-context')}>
              Insufficient context
            </button>
            ${record.feedback.length
              ? html`<small
                  >Saved feedback: ${record.feedback.at(-1)?.verdict}
                  ${record.feedback.at(-1)?.correctedAnswer
                    ? `· corrected cause: ${record.feedback.at(-1)?.correctedAnswer}`
                    : ''}</small
                >`
              : nothing}`
        : nothing}
      <small
        >Text-only advice. Workflow efficiency is not established. Existing validation and human
        gates still apply.</small
      >
    </details>`;
  }
}
