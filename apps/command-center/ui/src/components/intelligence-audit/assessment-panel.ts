import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

import {
  assessmentChoiceOptions,
  type AssessmentFeedbackVerdict,
  type AssessmentHistoryResult,
  type AssessmentRecord,
  type AssessmentReport,
  type AssessmentSummary,
  failureTriageCause,
  Methods,
} from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors } from '../../styles/theme-tokens.js';
import { getHashParam } from '../../utils/url-state.js';

@customElement('assessment-panel')
export class AssessmentPanel extends LitElement {
  @property({ attribute: false }) injectedHistory: AssessmentHistoryResult | null = null;
  @property({ attribute: false }) injectedSummary: AssessmentSummary | null = null;
  @state() private records: AssessmentRecord[] = [];
  @state() private summary: AssessmentSummary | null = null;
  @state() private error = '';
  @state() private busy = false;
  @state() private auditError = '';
  private onHashChange = () => {
    this.selectedId = getHashParam('assessment');
    if (this.busy) this.reloadPending = true;
    else void this.load();
  };
  private reloadPending = false;
  private loadedPages = 1;
  @state() private selectedId = getHashParam('assessment');
  @state() private cursor?: string;
  private interval?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  static styles = css`
    :host {
      display: block;
      padding: 16px;
      color: ${unsafeCSS(colors.textPrimary)};
    }
    h2 {
      margin: 0 0 8px;
    }
    p {
      color: ${unsafeCSS(colors.textMuted)};
    }
    button,
    select,
    input {
      background: ${unsafeCSS(colors.bgSurface)};
      color: inherit;
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 4px;
      padding: 6px;
      cursor: pointer;
    }
    form {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 12px;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
    }
    input[name='evidence'] {
      min-width: 220px;
    }
    section {
      border-top: 1px solid ${unsafeCSS(colors.bgCard)};
      padding: 12px 0;
    }
    .stats {
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
      margin: 16px 0;
    }
    article {
      border: 1px solid ${unsafeCSS(colors.bgCard)};
      border-radius: 6px;
      padding: 12px;
      margin: 12px 0;
    }
    .error {
      color: ${unsafeCSS(colors.statusFail)};
    }
    .muted {
      color: ${unsafeCSS(colors.textMuted)};
    }
    a {
      color: ${unsafeCSS(colors.accent)};
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid ${unsafeCSS(colors.bgCard)};
    }
  `;
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('hashchange', this.onHashChange);
    if (this.injectedHistory) {
      this.records = this.injectedHistory.records;
      this.summary = this.injectedSummary;
      return;
    }
    this.unsubscribe = gateway.onConnectionChange((status) => {
      if (status === 'connected') void this.load();
    });
    if (gateway.connectionState === 'connected') void this.load();
    this.interval = setInterval(() => {
      if (!this.busy && gateway.connectionState === 'connected') void this.load();
    }, 15000);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('hashchange', this.onHashChange);
    this.unsubscribe?.();
    clearInterval(this.interval);
  }
  private async load(more = false) {
    if (this.busy || this.injectedHistory || !this.isConnected) return;
    this.busy = true;
    try {
      const [history, summary] = await Promise.all([
        gateway.request<AssessmentHistoryResult>(Methods.ASSESSMENT_LIST, {
          limit: 50,
          ...(more && this.cursor ? { before: this.cursor } : {}),
        }),
        gateway.request<AssessmentSummary>(Methods.ASSESSMENT_SUMMARY, {}),
      ]);
      if (!this.isConnected) return;
      const selectedId = this.selectedId;
      let page = history;
      let refreshed = history.records;
      if (!more && !selectedId) {
        for (let i = 1; i < this.loadedPages && page.nextCursor; i++) {
          page = await gateway.request<AssessmentHistoryResult>(Methods.ASSESSMENT_LIST, {
            limit: 50,
            before: page.nextCursor,
          });
          refreshed = [...refreshed, ...page.records];
        }
      }
      this.records = selectedId
        ? [await gateway.request<AssessmentRecord>(Methods.ASSESSMENT_GET, { id: selectedId })]
        : more
          ? [...this.records, ...history.records]
          : refreshed;
      this.auditError =
        history.auditHealth.status === 'degraded'
          ? `${history.auditHealth.failedWritesSinceStart} assessment writes failed since startup. History may be incomplete.`
          : '';
      if (more) this.loadedPages++;
      this.cursor = page.nextCursor;
      if (selectedId !== this.selectedId) {
        this.reloadPending = true;
        return;
      }
      this.summary = summary;
      this.error = '';
    } catch {
      this.error = 'Assessment history could not be loaded. Refresh to retry.';
    } finally {
      this.busy = false;
      if (this.reloadPending) {
        this.reloadPending = false;
        void this.load();
      }
    }
  }
  private async feedback(
    record: AssessmentRecord,
    questionId: string,
    verdict: AssessmentFeedbackVerdict,
    used: boolean,
    evidenceRef: string,
    correctedAnswer?: string | boolean,
  ) {
    if (verdict === 'incorrect' && correctedAnswer === undefined) {
      this.error = 'Choose the corrected answer before saving an incorrect judgment.';
      return;
    }
    this.busy = true;
    try {
      const updated = await gateway.request<AssessmentRecord>(Methods.ASSESSMENT_FEEDBACK, {
        id: record.id,
        expectedRevision: record.feedback.length,
        questionId,
        verdict,
        adviceUsed: used,
        adviceShown: true,
        evidenceRef,
        ...(correctedAnswer !== undefined ? { correctedAnswer } : {}),
      });
      this.records = this.records.map((r) => (r.id === updated.id ? updated : r));
      this.busy = false;
      await this.load();
    } catch {
      this.error = 'Feedback was not saved. Refresh the record before retrying.';
    } finally {
      this.busy = false;
    }
  }
  private get canExportSelected(): boolean {
    return (
      !this.selectedId ||
      this.records.some(
        (r) =>
          r.id === this.selectedId &&
          r.consumer !== 'smoke-test' &&
          r.status === 'completed' &&
          (r.subject.pr || r.subject.run),
      )
    );
  }
  private async exportReport() {
    if (!this.canExportSelected) {
      this.error = 'Select a completed workflow assessment to export its case.';
      return;
    }
    this.busy = true;
    try {
      const report = await gateway.request<AssessmentReport>(
        Methods.ASSESSMENT_REPORT,
        this.selectedId ? { assessmentId: this.selectedId } : {},
      );
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `assessment-${report.reportId}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      this.error = 'Report could not be saved. Try again after checking gateway storage.';
    } finally {
      this.busy = false;
    }
  }
  render() {
    const s = this.summary;
    return html`
      <h2>Assessments</h2>
      <p>
        Advisory only. No review, dispatch or publication action is applied. History covers the last
        30 days.
      </p>
      <button data-action="refresh" @click=${() => this.load()} ?disabled=${this.busy}>
        Refresh
      </button>
      <button
        data-action="export"
        title=${this.canExportSelected
          ? 'Export assessment report'
          : 'Select a completed PR assessment to export its case'}
        @click=${() => this.exportReport()}
        ?disabled=${this.busy || !this.canExportSelected}
      >
        ${this.selectedId ? 'Export selected case' : 'Export effectiveness snapshot'}
      </button>
      ${this.auditError ? html`<p role="alert" class="error">${this.auditError}</p>` : nothing}
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${s
        ? html`<div class="stats">
              <span>${s.calls} assessment records</span><span>${s.completed} completed</span
              ><span>${s.failed} unavailable</span><span>${s.skipped} skipped / disabled</span
              ><span>${s.interrupted} interrupted</span
              ><span
                >${s.tokens} reported tokens · ${s.callsWithUsage}/${s.calls} attempts have complete
                token usage</span
              ><span
                >${s.attemptedCalls ?? 0} confirmed provider attempts ·
                ${s.unknownAttemptCalls ?? 0} unknown</span
              ><span
                >Provider latency across ${s.callsWithLatency} calls: median
                ${s.medianLatencyMs ?? '—'} ms · p95 ${s.p95LatencyMs ?? '—'} ms</span
              >
            </div>
            <p>
              ${s.uniqueCases} unique cases · ${s.labeledQuestions} operator-labeled questions ·
              ${s.insufficientContextQuestions} insufficient context · ${s.unlabeledQuestions}
              unlabeled. Operator labels, not independent ground truth. Smoke tests excluded.
            </p>
            <p>
              Recorded assessment duration: median ${s.endToEndMedianMs ?? 'unknown'} ms · p95
              ${s.endToEndP95Ms ?? 'unknown'} ms
            </p>
            <p>
              Model cost estimates: $${(s.knownEstimatedUsd ?? 0).toFixed(6)} · reported costs:
              $${(s.knownReportedUsd ?? 0).toFixed(6)} · legacy amount with unspecified cost source:
              $${(s.knownUnclassifiedUsd ?? 0).toFixed(6)} · ${s.unknownCharges ?? 'unknown'}
              requests with unknown charges. Conservative reservations:
              $${(s.reservedUsd ?? 0).toFixed(6)}. Completed snapshot cohorts:
              ${s.completedCases ?? 'unknown'}/${s.selectedCases ?? 'unknown'}. Workflow savings:
              not measured. Paired workflows at equal independently checked quality are required.
            </p>`
        : nothing}
      ${s?.groups.map(
        (g) =>
          html`<p>
            ${g.consumer ?? 'review-intake'} · ${g.provider}/${g.model} · policy ${g.policyVersion}
            · questions ${g.questionSchemaHash.slice(0, 8)} · ${g.questionId}:
            ${g.correct}/${g.correct + g.incorrect} operator-judged correct,
            ${g.insufficientContext} insufficient context, ${g.unlabeled} unlabeled.
          </p>`,
      )}
      ${this.records.length === 0
        ? html`<p>
            No assessments recorded. Ordinary run monitoring does not invoke this feature.
          </p>`
        : nothing}
      ${repeat(
        this.records,
        (record) => record.id,
        (record) =>
          html`<article id=${record.id}>
            <strong>${record.consumer} · ${record.status}</strong>
            <p>
              ${record.subject.pr
                ? `${record.subject.pr.repo}#${record.subject.pr.number} @ ${record.subject.pr.headSha.slice(0, 8)}`
                : record.subject.run
                  ? `${record.subject.run.project} · run ${record.subject.run.id} · ${record.subject.run.step} @ ${record.subject.run.snapshotHash.slice(0, 8)}`
                  : 'Synthetic connection test'}
              · ${record.startedAt}
            </p>
            <p>
              Recommendation:
              ${record.consumer === 'failure-triage'
                ? (failureTriageCause(record) ?? 'Unavailable')
                : record.consumer === 'decision-advice'
                  ? record.result?.status === 'completed' &&
                    record.result.answers?.action?.type === 'choice'
                    ? record.result.answers.action.choice
                    : record.status === 'started'
                      ? 'Pending'
                      : 'Unavailable'
                  : (record.recommendation?.route ?? 'Not assessed')}
              ${record.consumer === 'decision-advice'
                ? '· Action: none'
                : `· ${record.recommendation?.reasons.join(', ') ?? ''} · Action: none`}
            </p>
            <p>
              ${record.result?.provider ?? 'No provider'} /
              ${record.result?.returnedModel ?? record.result?.requestedModel ?? 'No model'} ·
              ${record.result?.error ?? record.result?.monitoringError ?? ''}
            </p>
            <details ?open=${Boolean(this.selectedId)}>
              <summary>Answers, provenance and feedback</summary>
              ${repeat(
                Object.entries(record.result?.answers ?? {}),
                ([question]) => question,
                ([question, answer]) =>
                  html`<section>
                    <h4>${question}</h4>
                    <pre>${JSON.stringify(answer, null, 2)}</pre>
                    <form
                      data-question=${question}
                      @submit=${(event: SubmitEvent) => {
                        event.preventDefault();
                        const form = event.currentTarget as HTMLFormElement;
                        const data = new FormData(form);
                        void this.feedback(
                          record,
                          question,
                          data.get('verdict') as AssessmentFeedbackVerdict,
                          data.get('used') === 'on',
                          String(data.get('evidence') ?? ''),
                          data.get('correction')
                            ? answer.type === 'boolean'
                              ? data.get('correction') === 'true'
                              : String(data.get('correction'))
                            : undefined,
                        );
                      }}
                    >
                      <label
                        >Assessment accuracy
                        <select name="verdict">
                          <option value="correct">Correct</option>
                          <option value="incorrect">Incorrect</option>
                          <option value="insufficient-context">Insufficient context</option>
                        </select></label
                      >
                      <label
                        >Evidence reference
                        <input
                          name="evidence"
                          required
                          maxlength="500"
                          placeholder="Review or artifact reference"
                      /></label>
                      <label
                        >Corrected answer, required when incorrect
                        <select name="correction">
                          <option value="">No correction</option>
                          ${(answer.type === 'boolean'
                            ? ['true', 'false']
                            : answer.type === 'choice'
                              ? assessmentChoiceOptions(answer)
                              : []
                          ).map((c) => html`<option value=${c}>${c}</option>`)}
                        </select>
                      </label>
                      <label><input name="used" type="checkbox" />I used this advice</label>
                      <button type="submit" ?disabled=${this.busy}>Save feedback</button>
                    </form>
                  </section>`,
              )}
              <pre>
${JSON.stringify(
                  {
                    id: record.id,
                    policyVersion: record.policyVersion,
                    stateHash: record.result?.stateHash,
                    questionSchemaHash: record.result?.questionSchemaHash,
                    usage: record.result?.usage,
                    feedback: record.feedback,
                  },
                  null,
                  2,
                )}</pre
              >
            </details>
          </article>`,
      )}
      ${this.cursor && !this.selectedId
        ? html`<button data-action="older" @click=${() => this.load(true)} ?disabled=${this.busy}>
            Load older
          </button>`
        : nothing}
    `;
  }
}
