import { html, LitElement, nothing, svg, type SVGTemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { BacklogItem, WorkEdge, WorkGraphProjection, WorkNode } from '@farmslot/protocol';

import { type AppState, getState, subscribe } from '../../state.js';
import { colors } from '../../styles/theme-tokens.js';

import { computeWorkGraphLayout, type WorkGraphLayoutNode } from './work-graph-layout.js';
import { workGraphPanelStyles } from './work-graph-panel-styles.js';

@customElement('work-graph-panel')
export class WorkGraphPanel extends LitElement {
  @property({ attribute: false }) demoGraphs: WorkGraphProjection[] | null = null;
  @property({ attribute: false }) demoBacklogItems: BacklogItem[] | null = null;

  @state() private graphs: WorkGraphProjection[] = [];
  @state() private backlogItems: BacklogItem[] = [];
  @state() private selectedProject = '';
  @state() private selectedNodeId = '';
  private unsub?: () => void;

  static styles = workGraphPanelStyles;

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
    this.backlogItems = state.backlogItems;
    const graphs = this.activeGraphs();
    const projects = new Set(graphs.map((graph) => graph.graph.project));
    if (this.selectedProject && !projects.has(this.selectedProject)) this.selectedProject = '';
    const nodeIds = new Set(graphs.flatMap((graph) => graph.nodes.map((node) => node.id)));
    if (this.selectedNodeId && !nodeIds.has(this.selectedNodeId)) this.selectedNodeId = '';
  }

  private activeGraphs(): WorkGraphProjection[] {
    return this.demoGraphs ?? this.graphs;
  }

  private activeBacklogItems(): BacklogItem[] {
    return this.demoBacklogItems ?? this.backlogItems;
  }

  private backlogById(): Map<string, BacklogItem> {
    return new Map(this.activeBacklogItems().map((item) => [item.id, item]));
  }

  private graphTitleForNode(backlogById: Map<string, BacklogItem>, node: WorkNode): string {
    if (node.kind === 'reference') return node.reference?.title ?? node.id;
    return node.backlogItemId
      ? (backlogById.get(node.backlogItemId)?.title ?? node.backlogItemId)
      : node.id;
  }

  private projectForNode(backlogById: Map<string, BacklogItem>, node: WorkNode): string {
    if (node.kind === 'reference') return node.reference?.project ?? 'external';
    return node.backlogItemId
      ? (backlogById.get(node.backlogItemId)?.project ?? 'unknown project')
      : 'unknown project';
  }

  private nodeKindLabel(node: WorkNode): string {
    return node.kind === 'reference'
      ? `reference:${node.reference?.kind ?? 'external'}`
      : 'backlog';
  }

  private specStatusLabel(item: BacklogItem | undefined, node: WorkNode): string {
    if (node.kind === 'reference') return node.reference?.status ?? 'unknown';
    return item?.status ?? 'missing-spec';
  }

  private graphStats(graph: WorkGraphProjection): { good: number; warn: number; bad: number } {
    return graph.nodes.reduce(
      (acc, node) => {
        if (['succeeded', 'ready'].includes(node.status)) acc.good += 1;
        else if (['failed', 'needs-attention'].includes(node.status)) acc.bad += 1;
        else acc.warn += 1;
        return acc;
      },
      { good: 0, warn: 0, bad: 0 },
    );
  }

  private colorForStatus(status: string): string {
    if (['done', 'succeeded', 'ready', 'satisfied', 'waived'].includes(status)) {
      return colors.statusOk;
    }
    if (['waiting', 'gated', 'pending', 'running', 'queued', 'active'].includes(status)) {
      return colors.statusWarn;
    }
    if (['failed', 'needs-attention'].includes(status)) return colors.statusFail;
    if (status === 'skipped') return colors.textMuted;
    return colors.textSecondary;
  }

  private edgeConditionLabel(edge: WorkEdge): string {
    if (edge.condition.kind === 'manual') return `manual gate:${edge.condition.gateId}`;
    if (edge.condition.kind === 'reference-status') {
      return `reference ${edge.condition.status ?? 'satisfied'}`;
    }
    if (edge.condition.kind === 'family-done') {
      return edge.condition.outcome ? `upstream ${edge.condition.outcome}` : 'upstream done';
    }
    return edge.condition.targetRef ? `merged ${edge.condition.targetRef}` : 'merged';
  }

  private edgeLabel(edge: WorkEdge): string {
    const condition = this.edgeConditionLabel(edge);
    const prefix = edge.blocks === 'completion' ? 'complete after ' : 'start after ';
    if (edge.unlock.kind === 'rebase-onto') return `${prefix}${condition} → rebase`;
    if (edge.unlock.kind === 'enqueue') return `${prefix}${condition} → enqueue`;
    return `${prefix}${condition}`;
  }

  private diagramEdgeLabel(edge: WorkEdge): string {
    if (edge.blocks !== 'completion') return '';
    return edge.unlock.kind === 'rebase-onto' ? 'complete after rebase' : 'complete after gate';
  }

  private unlockLabel(edge: WorkEdge): string {
    if (edge.unlock.kind === 'rebase-onto') return `unlock: rebase ${edge.unlock.flow}`;
    return `unlock: ${edge.unlock.kind}`;
  }

  private markerId(graph: WorkGraphProjection): string {
    return `wg-arrow-${graph.graph.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  }

  private selectNode(nodeId: string) {
    this.selectedNodeId = this.selectedNodeId === nodeId ? '' : nodeId;
  }

  private selectedNode(graph: WorkGraphProjection): WorkNode | null {
    return graph.nodes.find((node) => node.id === this.selectedNodeId) ?? graph.nodes[0] ?? null;
  }

  private renderLegend() {
    return html`
      <div class="legend" aria-label="Work graph status legend">
        <span class="legend-chip" style=${`color:${colors.statusOk}`}
          ><span class="dot"></span>unlocked</span
        >
        <span class="legend-chip" style=${`color:${colors.statusWarn}`}
          ><span class="dot"></span>waiting</span
        >
        <span class="legend-chip" style=${`color:${colors.statusFail}`}
          ><span class="dot"></span>attention</span
        >
      </div>
    `;
  }

  private renderDiagramNode(
    layoutNode: WorkGraphLayoutNode,
    backlogById: Map<string, BacklogItem>,
  ): SVGTemplateResult {
    const { node, x, y, w, h } = layoutNode;
    const color = this.colorForStatus(node.status);
    const isSelected = this.selectedNodeId === node.id;
    const item = node.backlogItemId ? backlogById.get(node.backlogItemId) : undefined;
    const title = this.graphTitleForNode(backlogById, node);
    const tags = [
      ...(node.tags ?? []),
      ...(item?.tags ?? []),
      ...(node.reference?.labels ?? []),
    ].slice(0, 2);
    const waitSuffix = node.waitingOn.length ? ` · ${node.waitingOn.length} wait` : '';
    const specStatus = this.specStatusLabel(item, node);
    const project = this.projectForNode(backlogById, node);
    return svg`
      <g
        class=${`diagram-node ${node.kind === 'reference' ? 'reference-node' : ''} ${isSelected ? 'selected' : ''}`}
        transform=${`translate(${x}, ${y})`}
        role="button"
        tabindex="0"
        aria-label=${`${title}, ${node.status}`}
        @click=${() => this.selectNode(node.id)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            this.selectNode(node.id);
          }
        }}
      >
        <rect width=${w} height=${h} rx="12" stroke=${color}></rect>
        <foreignObject x="12" y="12" width=${w - 24} height=${h - 24}>
          <div class="diagram-node-content" xmlns="http://www.w3.org/1999/xhtml">
            <div class="diagram-node-title">${title}</div>
            <div class="diagram-node-meta node-project">
              ${project} · ${this.nodeKindLabel(node)}
            </div>
            <div class="diagram-node-footer">
              <span class="diagram-node-status" style=${`color:${color}`}>${node.status}${waitSuffix}</span>
              <span class="diagram-node-spec">spec:${specStatus}</span>
              ${
                tags.length
                  ? html`<span class="diagram-node-tags"
                      >${tags.map((tag) => `#${tag}`).join(' ')}</span
                    >`
                  : nothing
              }
            </div>
          </div>
        </foreignObject>
      </g>
    `;
  }

  private renderDiagram(graph: WorkGraphProjection, backlogById: Map<string, BacklogItem>) {
    const layout = computeWorkGraphLayout(graph);
    const markerId = this.markerId(graph);
    const selectedNode = this.selectedNodeId;
    return html`
      <div class="diagram-card">
        <div class="diagram-toolbar">
          <div>
            <div class="diagram-title">Dependency map</div>
            <div class="small">
              Left-to-right columns show start dependencies; dashed edges are pending or
              completion/rebase blockers.
            </div>
          </div>
          ${this.renderLegend()}
        </div>
        <div class="diagram-scroll" aria-label=${`Dependency diagram for ${graph.graph.title}`}>
          <svg
            width=${layout.width}
            height=${layout.height}
            viewBox=${`0 0 ${layout.width} ${layout.height}`}
            role="img"
          >
            <defs>
              <marker
                id=${markerId}
                markerWidth="8"
                markerHeight="6"
                refX="8"
                refY="3"
                orient="auto"
              >
                <polygon points="0 0, 8 3, 0 6" fill=${colors.textMuted}></polygon>
              </marker>
            </defs>
            ${layout.stages.map(
              (stage) => svg`
                <rect class="stage-band" x=${stage.x - 12} y="36" width=${stage.width + 24} height=${Math.max(80, layout.height - 54)} rx="14"></rect>
                <text class="stage-label" x=${stage.x} y="24">${stage.label}</text>
              `,
            )}
            ${layout.edges.map(({ edge, d, labelX, labelY }) => {
              const color = this.colorForStatus(edge.status);
              const selected = selectedNode === edge.fromNodeId || selectedNode === edge.toNodeId;
              const label = this.diagramEdgeLabel(edge);
              return svg`
                <path
                  class="edge"
                  d=${d}
                  stroke=${color}
                  stroke-opacity=${selectedNode && !selected ? '0.16' : '0.76'}
                  stroke-width=${selected ? '3' : '2'}
                  stroke-dasharray=${edge.blocks === 'completion' ? '8 4' : edge.status === 'pending' ? '6 4' : 'none'}
                  marker-end=${`url(#${markerId})`}
                ></path>
                ${label ? svg`<text class="edge-label" x=${labelX} y=${labelY} text-anchor="middle" fill=${color}>${label}</text>` : nothing}
              `;
            })}
            ${layout.nodes.map((node) => this.renderDiagramNode(node, backlogById))}
          </svg>
        </div>
      </div>
    `;
  }

  private renderNodeCard(backlogById: Map<string, BacklogItem>, node: WorkNode) {
    const item = node.backlogItemId ? backlogById.get(node.backlogItemId) : undefined;
    const title = this.graphTitleForNode(backlogById, node);
    const specStatus = this.specStatusLabel(item, node);
    const refs = [
      node.currentFamilyId ? `family ${node.currentFamilyId}` : '',
      node.latestRunId ? `run ${node.latestRunId}` : '',
      item?.specPath ? item.specPath : '',
      node.reference?.url ? node.reference.url : '',
      node.reference?.evidence ? node.reference.evidence : '',
    ].filter(Boolean);
    return html`
      <button
        class=${`node-card ${this.selectedNodeId === node.id ? 'selected' : ''}`}
        @click=${() => this.selectNode(node.id)}
      >
        <div class="node-card-head">
          <div>
            <div class="node-title">${title}</div>
            <div class="small">
              ${node.id} · ${this.projectForNode(backlogById, node)} · ${this.nodeKindLabel(node)}
            </div>
          </div>
          <div class="node-card-badges">
            <span class=${`badge ${node.status}`}>${node.status}</span>
            <span class=${`badge ${specStatus}`}>spec:${specStatus}</span>
          </div>
        </div>
        ${refs.length
          ? html`<div class="refs">
              ${refs.map((ref) => html`<span class="ref">${ref}</span>`)}
            </div>`
          : nothing}
        ${node.waitingOn.length
          ? html`<ul class="waiting-list">
              ${node.waitingOn.map((reason) => html`<li>${reason.detail}</li>`)}
            </ul>`
          : nothing}
      </button>
    `;
  }

  private renderDetailCell(label: string, value: unknown) {
    return html`
      <div class="detail-cell">
        <div class="detail-label">${label}</div>
        <div class="detail-value">${value || '—'}</div>
      </div>
    `;
  }

  private renderNodeDetail(
    graph: WorkGraphProjection,
    backlogById: Map<string, BacklogItem>,
    node: WorkNode | null,
  ) {
    if (!node) return html`<div class="detail-card">No nodes in this graph.</div>`;
    const item = node.backlogItemId ? backlogById.get(node.backlogItemId) : undefined;
    const incoming = graph.edges.filter((edge) => edge.toNodeId === node.id);
    const outgoing = graph.edges.filter((edge) => edge.fromNodeId === node.id);
    return html`
      <div class="detail-card">
        <div>
          <div class="detail-title">${this.graphTitleForNode(backlogById, node)}</div>
          <div class="detail-muted">
            ${node.id} · ${item?.project ?? 'unknown project'} · ${node.status}
          </div>
        </div>
        <div class="detail-grid">
          ${this.renderDetailCell('Type', this.nodeKindLabel(node))}
          ${this.renderDetailCell('Spec status', this.specStatusLabel(item, node))}
          ${this.renderDetailCell('Backlog', node.backlogItemId)}
          ${this.renderDetailCell('Reference', node.reference?.ref)}
          ${this.renderDetailCell('Project', this.projectForNode(backlogById, node))}
          ${this.renderDetailCell('Flow', item?.flowType)}
          ${this.renderDetailCell('External status', node.reference?.status)}
          ${this.renderDetailCell('Family', node.currentFamilyId)}
          ${this.renderDetailCell('Latest run', node.latestRunId)}
          ${this.renderDetailCell('Base ref', node.baseRef)}
          ${this.renderDetailCell(
            'Failure policy',
            node.onFailure ?? graph.graph.defaultFailurePolicy,
          )}
        </div>
        ${item?.notes ? html`<div class="detail-muted">${item.notes}</div>` : nothing}
        ${node.reference?.evidence
          ? html`<div class="detail-muted">${node.reference.evidence}</div>`
          : nothing}
        ${incoming.length || outgoing.length
          ? html`
              <div class="detail-muted">
                ${incoming.length
                  ? html`<strong>Inputs:</strong> ${incoming
                        .map((edge) => this.edgeLabel(edge))
                        .join(', ')}<br />`
                  : nothing}
                ${outgoing.length
                  ? html`<strong>Unlocks:</strong> ${outgoing
                        .map((edge) => this.unlockLabel(edge))
                        .join(', ')}`
                  : nothing}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private renderSidePanel(graph: WorkGraphProjection, backlogById: Map<string, BacklogItem>) {
    return html`
      <aside class="side-panel">
        <div class="side-head">
          <div>
            <div class="side-title">Graph nodes</div>
            <div class="small">Select backlog work or external blockers to inspect refs.</div>
          </div>
        </div>
        <div class="side-content">
          ${this.renderNodeDetail(graph, backlogById, this.selectedNode(graph))}
          ${graph.nodes.map((node) => this.renderNodeCard(backlogById, node))}
        </div>
      </aside>
    `;
  }

  private renderGraph(graph: WorkGraphProjection) {
    const backlogById = this.backlogById();
    const stats = this.graphStats(graph);
    return html`
      <section class="graph">
        <div class="graph-head">
          <div>
            <div class="title">${graph.graph.title}</div>
            <div class="meta">
              ${graph.graph.id} · ${graph.graph.project} · updated ${graph.graph.updatedAt}
            </div>
            <div class="stat-row" aria-label="Graph node status summary">
              <span class="stat good">${stats.good} unlocked</span>
              <span class="stat warn">${stats.warn} waiting/running</span>
              <span class="stat bad">${stats.bad} attention</span>
            </div>
          </div>
          <div class="badges">
            <span class=${`badge ${graph.graph.status}`}>${graph.graph.status}</span>
            <span class="badge">${graph.nodes.length} nodes</span>
            <span class="badge">${graph.edges.length} edges</span>
            ${(graph.graph.tags ?? []).map((tag) => html`<span class="badge">#${tag}</span>`)}
          </div>
        </div>
        <div class="graph-body">
          ${this.renderDiagram(graph, backlogById)} ${this.renderSidePanel(graph, backlogById)}
        </div>
      </section>
    `;
  }

  render() {
    const allGraphs = this.activeGraphs();
    const projects = [...new Set(allGraphs.map((graph) => graph.graph.project))].sort();
    const graphs = this.selectedProject
      ? allGraphs.filter((graph) => graph.graph.project === this.selectedProject)
      : allGraphs;
    return html`
      <div class="header">
        <div>
          <h1>Work Graphs</h1>
          <div class="subtitle">
            ADR-040 dependency DAGs that make multi-backlog implementations readable before they
            dispatch.
          </div>
        </div>
        <select
          aria-label="Filter work graphs by project"
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
        : html`<div class="empty">
            No work graphs found. Create a graph from backlog work to see the dependency map here.
          </div>`}
    `;
  }
}
