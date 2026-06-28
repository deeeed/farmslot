import { css, html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import type { WorkGraphProjection, WorkNode } from '@farmslot/protocol';

import { type AppState, getState, subscribe } from '../../state.js';

@customElement('work-graph-panel')
export class WorkGraphPanel extends LitElement {
  @state() private graphs: WorkGraphProjection[] = [];
  @state() private selectedProject = '';
  private unsub?: () => void;

  static styles = css`
    :host {
      display: block;
      padding: 20px;
      color: #e5e7eb;
      font-family: 'SF Mono', 'Cascadia Code', monospace;
    }

    .header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }

    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
    }

    .subtitle {
      margin-top: 6px;
      color: #9ca3af;
      font-size: 12px;
    }

    select {
      background: #111827;
      color: #e5e7eb;
      border: 1px solid #374151;
      border-radius: 8px;
      padding: 8px 10px;
      font: inherit;
    }

    .empty,
    .graph {
      border: 1px solid #263244;
      border-radius: 12px;
      background: #0f172a;
    }

    .empty {
      padding: 24px;
      color: #94a3b8;
    }

    .graph {
      margin-bottom: 16px;
      overflow: hidden;
    }

    .graph-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid #263244;
      background: #111827;
    }

    .title {
      font-size: 15px;
      font-weight: 700;
    }

    .meta,
    .small {
      color: #94a3b8;
      font-size: 11px;
    }

    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
    }

    .badge {
      border: 1px solid #334155;
      border-radius: 999px;
      padding: 3px 8px;
      color: #cbd5e1;
      background: #0b1220;
      font-size: 11px;
    }

    .badge.active,
    .badge.done,
    .badge.succeeded {
      color: #86efac;
      border-color: #14532d;
    }

    .badge.waiting,
    .badge.gated {
      color: #fde68a;
      border-color: #854d0e;
    }

    .badge.failed,
    .badge.needs-attention {
      color: #fca5a5;
      border-color: #7f1d1d;
    }

    .nodes {
      display: grid;
      gap: 10px;
      padding: 14px;
    }

    .node {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) auto;
      gap: 10px;
      padding: 12px;
      border: 1px solid #1f2937;
      border-radius: 10px;
      background: #0b1120;
    }

    .node-title {
      font-weight: 700;
      margin-bottom: 6px;
    }

    .refs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }

    .ref {
      color: #93c5fd;
      font-size: 11px;
    }

    .waiting-list {
      grid-column: 1 / -1;
      margin: 4px 0 0;
      padding-left: 18px;
      color: #fbbf24;
      font-size: 12px;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.sync(getState());
    this.unsub = subscribe((state) => this.sync(state));
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
  }

  private sync(state: AppState) {
    this.graphs = state.workGraphs;
    const projects = new Set(this.graphs.map((graph) => graph.graph.project));
    if (this.selectedProject && !projects.has(this.selectedProject)) this.selectedProject = '';
  }

  private graphTitleForNode(graph: WorkGraphProjection, node: WorkNode): string {
    const backlogItem = getState().backlogItems.find((item) => item.id === node.backlogItemId);
    return backlogItem?.title ?? node.backlogItemId;
  }

  private renderNode(graph: WorkGraphProjection, node: WorkNode) {
    const waiting = node.waitingOn ?? [];
    return html`
      <div class="node">
        <div>
          <div class="node-title">${this.graphTitleForNode(graph, node)}</div>
          <div class="small">${node.id} · backlog ${node.backlogItemId}</div>
          <div class="refs">
            ${node.currentFamilyId
              ? html`<span class="ref">family ${node.currentFamilyId}</span>`
              : nothing}
            ${node.latestRunId ? html`<span class="ref">run ${node.latestRunId}</span>` : nothing}
          </div>
        </div>
        <div><span class=${`badge ${node.status}`}>${node.status}</span></div>
        ${waiting.length
          ? html`<ul class="waiting-list">
              ${waiting.map((reason) => html`<li>${reason.detail}</li>`)}
            </ul>`
          : nothing}
      </div>
    `;
  }

  private renderGraph(graph: WorkGraphProjection) {
    return html`
      <section class="graph">
        <div class="graph-head">
          <div>
            <div class="title">${graph.graph.title}</div>
            <div class="meta">
              ${graph.graph.id} · ${graph.graph.project} · updated ${graph.graph.updatedAt}
            </div>
          </div>
          <div class="badges">
            <span class=${`badge ${graph.graph.status}`}>${graph.graph.status}</span>
            <span class="badge">${graph.nodes.length} nodes</span>
            <span class="badge">${graph.edges.length} edges</span>
            ${(graph.graph.tags ?? []).map((tag) => html`<span class="badge">#${tag}</span>`)}
          </div>
        </div>
        <div class="nodes">${graph.nodes.map((node) => this.renderNode(graph, node))}</div>
      </section>
    `;
  }

  render() {
    const projects = [...new Set(this.graphs.map((graph) => graph.graph.project))].sort();
    const graphs = this.selectedProject
      ? this.graphs.filter((graph) => graph.graph.project === this.selectedProject)
      : this.graphs;
    return html`
      <div class="header">
        <div>
          <h1>Work Graphs</h1>
          <div class="subtitle">
            Read-only ADR-040 dependency DAGs over dispatchable backlog items.
          </div>
        </div>
        <select
          .value=${this.selectedProject}
          @change=${(event: Event) => {
            this.selectedProject = (event.target as HTMLSelectElement).value;
          }}
        >
          <option value="">All projects</option>
          ${projects.map((project) => html`<option value=${project}>${project}</option>`)}
        </select>
      </div>
      ${graphs.length
        ? graphs.map((graph) => this.renderGraph(graph))
        : html`<div class="empty">No work graphs found.</div>`}
    `;
  }
}
