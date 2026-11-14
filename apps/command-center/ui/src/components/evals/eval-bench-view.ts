import { css, html, LitElement, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';

import {
  evalBenchCostSaving,
  type EvalBenchResult,
  evalBenchRollups,
  type EvalBenchTrial,
  Methods,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { buildHash, parseHashRoute } from '../../utils/url-state.js';
import { ResourceQueryController } from '../shared/resource-query-controller.js';

import { evalCockpitStyles } from './eval-cockpit-styles.js';

function display(value: number | null | undefined): string {
  return value == null
    ? 'Not captured'
    : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}
function cost(value: number | null | undefined): string {
  return value == null ? 'Unmetered' : `$${value.toFixed(4)}`;
}

@customElement('eval-bench-view')
export class EvalBenchView extends LitElement {
  private readonly data = new ResourceQueryController<EvalBenchResult>(this);
  private readonly hashChanged = () => this.requestUpdate();

  connectedCallback(): void {
    super.connectedCallback();
    this.data.setQuery(resourceQuery<EvalBenchResult>(Methods.EVAL_BENCH_GET, {}));
    window.addEventListener('hashchange', this.hashChanged);
  }
  disconnectedCallback(): void {
    window.removeEventListener('hashchange', this.hashChanged);
    super.disconnectedCallback();
  }
  private setFilter(key: string, value: string): void {
    const { route, params } = parseHashRoute(location.hash);
    if (value) params.set(key, value);
    else params.delete(key);
    location.hash = buildHash(route, params);
  }
  private filter(key: string): string {
    return parseHashRoute(location.hash).params.get(key) ?? '';
  }
  private select(key: string, label: string, values: string[]) {
    return html`<label
      >${label}
      <select
        @change=${(event: Event) => this.setFilter(key, (event.target as HTMLSelectElement).value)}
      >
        <option value="" .selected=${!this.filter(key)}>All</option>
        ${[...new Set(values)]
          .sort()
          .map((v) => html`<option value=${v} .selected=${v === this.filter(key)}>${v}</option>`)}
      </select></label
    >`;
  }
  private original(trial: EvalBenchTrial) {
    const o = trial.original;
    const saving = evalBenchCostSaving(trial);
    return o
      ? html`<strong>${o.model}</strong><br />
          ${cost(o.usage.costUsd)} · ${display(o.usage.turns)} turns<br />
          <small
            >In ${display(o.usage.inputTokens)} / out ${display(o.usage.outputTokens)}<br />
            Cache read ${display(o.usage.cacheReadTokens)} / write
            ${display(o.usage.cacheWriteTokens)}</small
          ><br />
          ${saving === null
            ? nothing
            : html`<strong
                  >${Math.abs(saving * 100).toFixed(1)}%
                  ${saving >= 0 ? 'cheaper' : 'more expensive'}</strong
                ><br />`}
          <small
            >${o.scope}<br />${o.startedAt} to ${o.completedAt}<br />
            <a href=${`#run/${o.runId}`}>Original run ${o.runId.slice(0, 8)}</a></small
          >`
      : html`<span
          >${trial.reference.head ? 'Original usage not captured' : 'Original unavailable'}</span
        >`;
  }
  render() {
    const data = this.data.state.data;
    if (!data)
      return html`<div class="eval-cockpit">
        <p role="status">${this.data.state.error?.message ?? 'Reading benchmark records…'}</p>
        <button @click=${() => void this.data.retry()}>Refresh</button>
        <button @click=${() => this.setFilter('view', 'plan')}>Plan trials</button>
      </div>`;
    const trials = data.trials.filter(
      (t) =>
        (!this.filter('problem') || t.problemType === this.filter('problem')) &&
        (!this.filter('area') || t.area === this.filter('area')) &&
        (!this.filter('size') || t.sizeClass === this.filter('size')) &&
        (!this.filter('model') || t.modelId === this.filter('model')),
    );
    const rows = evalBenchRollups(trials);
    return html`<div class="eval-cockpit">
      <section class="eval-hero">
        <div>
          <div class="eyebrow">Eval cockpit</div>
          <h2>Results by problem type and model</h2>
          <p>Main score: original before review. Merged output is a separate comparison.</p>
          <small>${data.dataset ?? 'No benchmark dataset configured'}</small>
        </div>
        <div>
          <button @click=${() => void this.data.retry()}>Refresh</button>
          <button @click=${() => this.setFilter('view', 'plan')}>Plan trials</button>
        </div>
      </section>
      ${!data.configured
        ? html`<section class="eval-panel">
            No benchmark dataset is connected to this gateway.
          </section>`
        : html` <section class="eval-panel filters">
              ${this.select(
                'problem',
                'Problem type',
                data.trials.map((t) => t.problemType),
              )}
              ${this.select(
                'area',
                'Area',
                data.trials.map((t) => t.area),
              )}
              ${this.select(
                'size',
                'Size',
                data.trials.map((t) => t.sizeClass),
              )}
              ${this.select(
                'model',
                'Model ID',
                data.trials.map((t) => t.modelId),
              )}
            </section>
            <section class="eval-panel">
              <h3>Across cases</h3>
              <p>
                Solved = MATCHES-REF or ACCEPTABLE-ALT versus pre-review original. Mergeable is the
                judge's separate yes/no assessment.
              </p>
              <div class="table-scroll">
                <table data-testid="eval-bench-rollup">
                  <thead>
                    <tr>
                      <th>Problem / model</th>
                      <th>Cases / trials</th>
                      <th>Solved</th>
                      <th>Mergeable</th>
                      <th>Recorded cost</th>
                      <th>Turns</th>
                      <th>Unscored</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${rows.map(
                      (r) =>
                        html`<tr>
                          <td>
                            ${r.problemType} · <strong>${r.model}</strong><br /><small
                              >${r.route} · ${r.effort}</small
                            >
                          </td>
                          <td>${r.cases} / ${r.trials}</td>
                          <td>${r.solved} / ${r.scored}</td>
                          <td>${r.mergeable} / ${r.mergeabilityKnown}</td>
                          <td>
                            ${r.pricedTrials ? cost(r.costUsd) : 'Unmetered'}<br /><small
                              >${r.pricedTrials}/${r.trials} priced</small
                            >
                          </td>
                          <td>
                            ${display(r.turns)}<br /><small
                              >${r.measuredTurnTrials}/${r.trials} measured</small
                            >
                          </td>
                          <td>${r.unscored}</td>
                        </tr>`,
                    )}
                  </tbody>
                </table>
              </div>
              <p>
                Counts are trials; repeats stay visible. Cost and turns include unscored attempts.
                Unknown prices are excluded, never $0.
              </p>
            </section>
            <section class="eval-panel">
              <h3>Trials and pinned originals</h3>
              <div class="table-scroll">
                <table data-testid="eval-bench-trials">
                  <thead>
                    <tr>
                      <th>Case / trial</th>
                      <th>Vs pre-review original</th>
                      <th>Vs merged</th>
                      <th>Mergeability</th>
                      <th>Trial usage</th>
                      <th>Pinned original / measured saving</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${trials.map(
                      (t) =>
                        html`<tr>
                          <td>
                            <strong>${t.item} · ${t.model}</strong><br /><small
                              >${t.area} · ${t.sizeClass} · ${t.route} · ${t.effort}</small
                            ><br /><a href=${`#run/${t.runId}`}>${t.runId.slice(0, 8)}</a
                            ><br /><small
                              >${t.reference.base || 'Base unavailable'} →
                              ${t.reference.head || 'Original unavailable'}</small
                            >
                          </td>
                          <td>
                            ${t.unscored ? `Unscored: ${t.unscored}` : (t.verdict ?? 'Unjudged')}
                          </td>
                          <td>${t.verdictVsMerged ?? 'Unjudged'}</td>
                          <td>${t.unscored ? 'Unscored' : (t.mergeable ?? 'Not assessed')}</td>
                          <td>
                            ${cost(t.usage.costUsd)} · ${display(t.usage.turns)} turns<br />${display(
                              t.usage.wallMinutes,
                            )}
                            min<br />
                            <small
                              >In ${display(t.usage.inputTokens)} / out
                              ${display(t.usage.outputTokens)}<br />Cache read
                              ${display(t.usage.cacheReadTokens)} / write
                              ${display(t.usage.cacheWriteTokens)}</small
                            >
                          </td>
                          <td>${this.original(t)}</td>
                        </tr>`,
                    )}
                  </tbody>
                </table>
              </div>
              ${!trials.length ? html`<p>No trials match these filters.</p>` : nothing}
            </section>
            <section class="eval-panel">
              <details>
                <summary>
                  Infrastructure failures (${data.infraFailures.length}), excluded from scores
                </summary>
                ${data.infraFailures.map(
                  (f) =>
                    html`<p>
                      ${f.item} · ${f.runId.slice(0, 8)} · ${f.failedStep}<br /><small
                        >${f.error}</small
                      >
                    </p>`,
                )}
              </details>
            </section>`}
    </div>`;
  }
  static styles = [
    evalCockpitStyles,
    css`
      :host {
        display: block;
        height: 100%;
        min-height: 0;
      }
      .eval-cockpit {
        grid-template-columns: minmax(0, 1fr);
      }
      .eval-panel,
      .eval-hero {
        min-width: 0;
      }
      .eval-hero {
        flex-wrap: wrap;
      }
      h2,
      small,
      p {
        overflow-wrap: anywhere;
      }
      .filters label {
        max-width: 100%;
      }
      select {
        max-width: 100%;
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
      }
      label {
        display: grid;
        gap: 6px;
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
      a {
        color: #a5a8ff;
      }
      small,
      p {
        color: #a0a0b4;
      }
      .table-scroll {
        overflow-x: auto;
      }
      table {
        border-collapse: collapse;
        width: 100%;
        font-size: 12px;
      }
      th,
      td {
        padding: 12px;
        text-align: left;
        vertical-align: top;
        border-bottom: 1px solid #303046;
        min-width: 110px;
      }
      th {
        color: #a5a8ff;
      }
      td:first-child {
        min-width: 230px;
      }
      td:last-child {
        min-width: 270px;
      }
      h3 {
        margin-top: 0;
      }
      p {
        font-size: 12px;
        line-height: 1.6;
      }
    `,
  ];
}
