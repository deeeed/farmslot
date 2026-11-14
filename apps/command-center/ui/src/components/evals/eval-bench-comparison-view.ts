import DOMPurify from 'dompurify';
import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import {
  EVAL_BENCH_COMPARE,
  EVAL_BENCH_FILE,
  EVAL_BENCH_TAB,
  type EvalBenchComparison,
  type EvalBenchResult,
  Methods,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { ViewStateController } from '../../utils/view-state.js';
import { ResourceQueryController } from '../shared/resource-query-controller.js';

import {
  EVAL_COMPARISON_CSS,
  EVAL_COMPARISON_TABS,
  type EvalComparisonTab,
  exportEvalComparisonHtml,
  renderEvalComparisonBody,
} from './eval-comparison-html.js';

@customElement('eval-bench-comparison-view')
export class EvalBenchComparisonView extends LitElement {
  @property({ attribute: false }) bench: EvalBenchResult | null = null;
  private readonly data = new ResourceQueryController<EvalBenchComparison>(this);
  private readonly view = new ViewStateController(this);

  connectedCallback(): void {
    super.connectedCallback();
    this.syncQuery();
  }
  protected override willUpdate(): void {
    this.syncQuery();
  }
  private ids(): string[] {
    return [...this.view.state.get(EVAL_BENCH_COMPARE)];
  }
  private syncQuery(): void {
    const runIds = this.ids();
    this.data.setQuery(
      runIds.length > 0 && runIds.length <= 2
        ? resourceQuery<EvalBenchComparison>(Methods.EVAL_BENCH_COMPARISON_GET, { runIds })
        : undefined,
    );
  }
  private showResults(): void {
    this.view.state.update((values) => {
      values.set(EVAL_BENCH_COMPARE, []);
      values.set(EVAL_BENCH_TAB, 'patches');
      values.set(EVAL_BENCH_FILE, '');
    });
  }
  private setTrials(first: string, second = ''): void {
    this.view.state.update((values) => {
      values.set(EVAL_BENCH_COMPARE, [first, second].filter(Boolean));
      values.set(EVAL_BENCH_FILE, '');
    });
  }
  private export(data: EvalBenchComparison): void {
    const blob = new Blob([exportEvalComparisonHtml(data)], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `eval-${data.item.replace(/[^a-z0-9._-]/gi, '-')}-comparison.html`;
    anchor.click();
    // The browser must consume the URL before it is released.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  render() {
    const ids = this.ids();
    const bench = this.bench;
    const first = bench?.trials.find((t) => t.runId === ids[0]);
    const choices =
      first && bench
        ? bench.trials.filter(
            (t) =>
              t.item === first.item &&
              t.dataset === first.dataset &&
              t.problemType === first.problemType &&
              JSON.stringify(t.reference) === JSON.stringify(first.reference),
          )
        : [];
    const cases = [
      ...new Map(
        (this.bench?.trials ?? []).map((t) => [
          JSON.stringify([t.dataset, t.item, t.problemType, t.reference]),
          t,
        ]),
      ).values(),
    ];
    const tab: EvalComparisonTab = this.view.state.get(EVAL_BENCH_TAB);
    const selectedFile = this.view.state.get(EVAL_BENCH_FILE);
    const data = this.data.state.data;
    const files = data
      ? [
          ...new Set(
            [...data.originalPatch.files, ...data.trials.flatMap((t) => t.patch.files)].map(
              (f) => f.path,
            ),
          ),
        ].sort()
      : [];
    return html`<div class="comparison-shell">
      <nav>
        <button @click=${() => this.showResults()}>Results</button>
        <button @click=${() => void this.data.retry()}>Refresh</button>
        <button
          ?disabled=${!data}
          @click=${() => {
            if (data) this.export(data);
          }}
        >
          Export HTML
        </button>
      </nav>
      <div class="choices">
        <label
          >Case<select
            @change=${(e: Event) => this.setTrials((e.target as HTMLSelectElement).value)}
          >
            <option value="" disabled .selected=${!first}>Select a case</option>
            ${cases.map(
              (t) =>
                html`<option
                  value=${t.runId}
                  .selected=${first?.item === t.item &&
                  first.dataset === t.dataset &&
                  first.problemType === t.problemType &&
                  JSON.stringify(first.reference) === JSON.stringify(t.reference)}
                >
                  ${t.item} · ${t.problemType}
                </option>`,
            )}
          </select></label
        >
        <label
          >First trial<select
            @change=${(e: Event) => {
              const next = (e.target as HTMLSelectElement).value;
              this.setTrials(next, ids[1] === next ? '' : ids[1]);
            }}
          >
            ${choices.map(
              (t) =>
                html`<option value=${t.runId} .selected=${ids[0] === t.runId}>
                  ${t.model} · ${t.route} · ${t.effort} · ${t.runId.slice(0, 8)}
                </option>`,
            )}
          </select></label
        >
        <label
          >Second trial<select
            @change=${(e: Event) => this.setTrials(ids[0], (e.target as HTMLSelectElement).value)}
          >
            <option value="" .selected=${!ids[1]}>None</option>
            ${choices
              .filter((t) => t.runId !== ids[0])
              .map(
                (t) =>
                  html`<option value=${t.runId} .selected=${ids[1] === t.runId}>
                    ${t.model} · ${t.route} · ${t.effort} · ${t.runId.slice(0, 8)}
                  </option>`,
              )}
          </select></label
        >
      </div>
      <nav>
        ${EVAL_COMPARISON_TABS.map(
          (t) =>
            html`<button
              aria-pressed=${tab === t ? 'true' : 'false'}
              @click=${() => this.view.state.set(EVAL_BENCH_TAB, t)}
            >
              ${t}
            </button>`,
        )}
      </nav>
      ${tab === 'patches' && data
        ? html`<label
            >File<select
              @change=${(e: Event) =>
                this.view.state.set(EVAL_BENCH_FILE, (e.target as HTMLSelectElement).value)}
            >
              <option value="" .selected=${!selectedFile}>All files</option>
              ${files.map(
                (f) => html`<option value=${f} .selected=${selectedFile === f}>${f}</option>`,
              )}
            </select></label
          >`
        : nothing}
      ${data
        ? unsafeHTML(DOMPurify.sanitize(renderEvalComparisonBody(data, tab, selectedFile)))
        : html`<p role="status">
            ${ids.length > 2
              ? 'Choose at most two trials.'
              : (this.data.state.error?.message ?? 'Reading comparison…')}
          </p>`}
    </div>`;
  }
  static styles = [
    css`
      ${unsafeCSS(EVAL_COMPARISON_CSS)}
    `,
    css`
      :host {
        display: block;
        height: 100%;
        min-height: 0;
        min-width: 0;
      }
      .comparison-shell {
        height: 100%;
        overflow: auto;
        box-sizing: border-box;
        padding: 12px;
        color: #e0e0e8;
        background: #0a0a0f;
      }
      nav,
      .choices {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin: 10px 0;
      }
      label {
        display: grid;
        gap: 5px;
        min-width: 0;
        max-width: 100%;
        font:
          12px ui-monospace,
          monospace;
      }
      select {
        max-width: 100%;
        width: 100%;
        box-sizing: border-box;
        min-width: 0;
      }
      .choices label {
        flex: 1 1 240px;
      }
      button,
      select {
        background: #16162a;
        color: #e0e0e8;
        border: 1px solid #555570;
        border-radius: 4px;
        padding: 8px;
      }
      button {
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      button[aria-pressed='true'] {
        border-color: #a5a8ff;
      }
    `,
  ];
}
