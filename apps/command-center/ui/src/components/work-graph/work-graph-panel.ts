import { html, LitElement, nothing, svg, type SVGTemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  BacklogItem,
  QueueItem,
  Run,
  SlotStatus,
  WorkEdge,
  WorkGraphProjection,
  WorkNode,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, subscribe } from '../../state.js';
import { colors } from '../../styles/theme-tokens.js';

import {
  buildWorkGraphExecutionOverlay,
  type WorkGraphExecutionOverlay,
  type WorkGraphNodeExecutionView,
} from './work-graph-execution-overlay.js';
import { computeWorkGraphLayout, type WorkGraphLayoutNode } from './work-graph-layout.js';
import { workGraphPanelStyles } from './work-graph-panel-styles.js';

@customElement('work-graph-panel')
export class WorkGraphPanel extends LitElement {
  @property({ attribute: false }) demoGraphs: WorkGraphProjection[] | null = null;
  @property({ attribute: false }) demoBacklogItems: BacklogItem[] | null = null;

  @state() private graphs: WorkGraphProjection[] = [];
  @state() private backlogItems: BacklogItem[] = [];
  @state() private queueItems: QueueItem[] = [];
  @state() private runs: Run[] = [];
  @state() private slots: SlotStatus[] = [];
  @state() private configBusyItemId = '';
  @state() private configError = '';
  @state() private selectedProject = '';
  @state() private selectedNodeKey = '';
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
    this.queueItems = state.queueItems;
    this.runs = state.runs;
    this.slots = state.fleet?.slots ?? [];
    const graphs = this.activeGraphs();
    const projects = new Set(graphs.map((graph) => graph.graph.project));
    if (this.selectedProject && !projects.has(this.selectedProject)) this.selectedProject = '';
    const nodeKeys = new Set(
      graphs.flatMap((graph) => graph.nodes.map((node) => this.nodeKey(graph, node.id))),
    );
    if (this.selectedNodeKey && !nodeKeys.has(this.selectedNodeKey)) this.selectedNodeKey = '';
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

  private graphStats(overlay: WorkGraphExecutionOverlay): {
    good: number;
    warn: number;
    bad: number;
  } {
    return overlay.nodes.reduce(
      (acc, node) => {
        if (['succeeded', 'ready'].includes(node.executionStatus)) acc.good += 1;
        else if (['failed', 'needs-attention', 'config-blocked'].includes(node.executionStatus))
          acc.bad += 1;
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
    if (
      [
        'waiting',
        'gated',
        'pending',
        'running',
        'queued',
        'active',
        'dependency-blocked',
        'waiting-for-slot',
        'dispatching',
      ].includes(status)
    ) {
      return colors.statusWarn;
    }
    if (['failed', 'needs-attention', 'config-blocked'].includes(status)) return colors.statusFail;
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

  private nodeKey(graph: WorkGraphProjection, nodeId: string): string {
    return `${graph.graph.id}:${nodeId}`;
  }

  private selectNode(graph: WorkGraphProjection, nodeId: string) {
    const key = this.nodeKey(graph, nodeId);
    this.selectedNodeKey = this.selectedNodeKey === key ? '' : key;
  }

  private isSelectedNode(graph: WorkGraphProjection, nodeId: string): boolean {
    return this.selectedNodeKey === this.nodeKey(graph, nodeId);
  }

  private selectedNode(graph: WorkGraphProjection): WorkNode | null {
    return (
      graph.nodes.find((node) => this.isSelectedNode(graph, node.id)) ?? graph.nodes[0] ?? null
    );
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
    graph: WorkGraphProjection,
    layoutNode: WorkGraphLayoutNode,
    backlogById: Map<string, BacklogItem>,
    overlay: WorkGraphExecutionOverlay,
  ): SVGTemplateResult {
    const { node, x, y, w, h } = layoutNode;
    const view = overlay.byNodeId.get(node.id);
    const status = view?.executionStatus ?? node.status;
    const color = this.colorForStatus(status);
    const isSelected = this.isSelectedNode(graph, node.id);
    const item =
      view?.backlogItem ?? (node.backlogItemId ? backlogById.get(node.backlogItemId) : undefined);
    const title = view?.title ?? this.graphTitleForNode(backlogById, node);
    const tags = [
      ...(node.tags ?? []),
      ...(item?.tags ?? []),
      ...(node.reference?.labels ?? []),
    ].slice(0, 2);
    const waitSuffix = view?.blockers.length ? ` · ${view.blockers.length} blocker` : '';
    const specStatus = this.specStatusLabel(item, node);
    const project = this.projectForNode(backlogById, node);
    return svg`
      <g
        class=${`diagram-node ${node.kind === 'reference' ? 'reference-node' : ''} ${isSelected ? 'selected' : ''}`}
        transform=${`translate(${x}, ${y})`}
        role="button"
        tabindex="0"
        aria-label=${`${title}, ${status}`}
        @click=${() => this.selectNode(graph, node.id)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            this.selectNode(graph, node.id);
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
              <span class="diagram-node-status" style=${`color:${color}`}>${status}${waitSuffix}</span>
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

  private renderDiagram(
    graph: WorkGraphProjection,
    backlogById: Map<string, BacklogItem>,
    overlay: WorkGraphExecutionOverlay,
  ) {
    const layout = computeWorkGraphLayout(graph);
    const markerId = this.markerId(graph);
    const selectedNode = this.selectedNodeKey.startsWith(`${graph.graph.id}:`)
      ? this.selectedNodeKey.slice(graph.graph.id.length + 1)
      : '';
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
            ${layout.nodes.map((node) => this.renderDiagramNode(graph, node, backlogById, overlay))}
          </svg>
        </div>
      </div>
    `;
  }

  private renderNodeCard(
    graph: WorkGraphProjection,
    backlogById: Map<string, BacklogItem>,
    node: WorkNode,
    overlay: WorkGraphExecutionOverlay,
  ) {
    const item = node.backlogItemId ? backlogById.get(node.backlogItemId) : undefined;
    const view = overlay.byNodeId.get(node.id);
    const title = view?.title ?? this.graphTitleForNode(backlogById, node);
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
        class=${`node-card ${this.isSelectedNode(graph, node.id) ? 'selected' : ''}`}
        @click=${() => this.selectNode(graph, node.id)}
      >
        <div class="node-card-head">
          <div>
            <div class="node-title">${title}</div>
            <div class="small">
              ${node.id} · ${this.projectForNode(backlogById, node)} · ${this.nodeKindLabel(node)}
            </div>
          </div>
          <div class="node-card-badges">
            <span class=${`badge ${view?.executionStatus ?? node.status}`}
              >${view?.executionStatus ?? node.status}</span
            >
            <span class=${`badge ${specStatus}`}>spec:${specStatus}</span>
          </div>
        </div>
        ${refs.length
          ? html`<div class="refs">
              ${refs.map((ref) => html`<span class="ref">${ref}</span>`)}
            </div>`
          : nothing}
        ${view?.blockers.length
          ? html`<ul class="waiting-list">
              ${view.blockers.slice(0, 3).map((reason) => html`<li>${reason.message}</li>`)}
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

  private slotOptionsForItem(item: BacklogItem): SlotStatus[] {
    return this.slots
      .filter((slot) => slot.project === item.project)
      .sort((a, b) => a.machine.localeCompare(b.machine) || a.slot.localeCompare(b.slot));
  }

  private async updateBacklogConfig(
    item: BacklogItem,
    patch: {
      priority?: number;
      allowedSlots?: string[] | null;
      autoDispatch?: boolean;
      runner?: string | null;
      model?: string | null;
      effort?: string | null;
    },
  ): Promise<void> {
    this.configBusyItemId = item.id;
    this.configError = '';
    try {
      await gateway.request(Methods.BACKLOG_UPDATE, { itemId: item.id, ...patch });
    } catch (error) {
      this.configError = error instanceof Error ? error.message : String(error);
    } finally {
      this.configBusyItemId = '';
    }
  }

  private async toggleAllowedSlot(
    item: BacklogItem,
    slotId: string,
    checked: boolean,
  ): Promise<void> {
    const current = item.allowedSlots ?? [];
    const next = checked
      ? [...new Set([...current, slotId])]
      : current.filter((candidate) => candidate !== slotId);
    await this.updateBacklogConfig(item, { allowedSlots: next.length ? next : null });
  }

  private renderDispatchConfig(view: WorkGraphNodeExecutionView) {
    const item = view.backlogItem;
    if (!item) return nothing;
    const disabled = !view.editableConfig || this.configBusyItemId === item.id;
    const slotOptions = this.slotOptionsForItem(item);
    const selectedSlots = new Set(item.allowedSlots ?? []);
    const runners = ['', 'claude', 'codex', 'cursor', 'grok', 'opencode'];
    return html`
      <div class="config-editor">
        <div class="config-head">
          <div>
            <div class="detail-title">Dispatch config</div>
            <div class="detail-muted">
              Edits the linked backlog item; queued/running nodes are read-only.
            </div>
          </div>
          ${!view.editableConfig ? html`<span class="badge queued">locked</span>` : nothing}
        </div>
        ${this.configError ? html`<div class="config-error">${this.configError}</div>` : nothing}
        <label class="config-field">
          <span>Priority</span>
          <input
            type="number"
            min="1"
            .value=${String(item.priority)}
            ?disabled=${disabled}
            @change=${(event: Event) =>
              this.updateBacklogConfig(item, {
                priority: Number((event.target as HTMLInputElement).value),
              })}
          />
        </label>
        <label class="config-check">
          <input
            type="checkbox"
            .checked=${item.autoDispatch === true}
            ?disabled=${disabled}
            @change=${(event: Event) =>
              this.updateBacklogConfig(item, {
                autoDispatch: (event.target as HTMLInputElement).checked,
              })}
          />
          Auto-dispatch when scheduler marks ready
        </label>
        <div class="config-grid">
          <label class="config-field">
            <span>Runner</span>
            <select
              .value=${item.runner ?? ''}
              ?disabled=${disabled}
              @change=${(event: Event) =>
                this.updateBacklogConfig(item, {
                  runner: (event.target as HTMLSelectElement).value || null,
                })}
            >
              ${runners.map(
                (runner) => html`<option value=${runner}>${runner || 'default'}</option>`,
              )}
            </select>
          </label>
          <label class="config-field">
            <span>Model</span>
            <input
              .value=${item.model ?? ''}
              placeholder="default"
              ?disabled=${disabled}
              @change=${(event: Event) =>
                this.updateBacklogConfig(item, {
                  model: (event.target as HTMLInputElement).value.trim() || null,
                })}
            />
          </label>
          <label class="config-field">
            <span>Effort</span>
            <input
              .value=${item.effort ?? ''}
              placeholder="default"
              ?disabled=${disabled}
              @change=${(event: Event) =>
                this.updateBacklogConfig(item, {
                  effort: (event.target as HTMLInputElement).value.trim() || null,
                })}
            />
          </label>
        </div>
        <div class="slot-picker">
          <div class="detail-label">Allowed slots</div>
          <button
            ?disabled=${disabled}
            @click=${() => this.updateBacklogConfig(item, { allowedSlots: null })}
          >
            Any eligible ${item.project} slot
          </button>
          <div class="slot-options">
            ${slotOptions.length
              ? slotOptions.map(
                  (slot) =>
                    html`<label class="slot-option">
                      <input
                        type="checkbox"
                        .checked=${selectedSlots.has(slot.slot)}
                        ?disabled=${disabled}
                        @change=${(event: Event) =>
                          this.toggleAllowedSlot(
                            item,
                            slot.slot,
                            (event.target as HTMLInputElement).checked,
                          )}
                      />
                      <span>${slot.slot}</span>
                      <small
                        >${slot.lifecycle}${slot.runner
                          ? ` · ${slot.runner}/${slot.model ?? 'default'}`
                          : ''}</small
                      >
                    </label>`,
                )
              : html`<div class="detail-muted">No visible slots for ${item.project}.</div>`}
          </div>
        </div>
      </div>
    `;
  }

  private renderNodeDetail(
    graph: WorkGraphProjection,
    backlogById: Map<string, BacklogItem>,
    node: WorkNode | null,
    overlay: WorkGraphExecutionOverlay,
  ) {
    if (!node) return html`<div class="detail-card">No nodes in this graph.</div>`;
    const view = overlay.byNodeId.get(node.id);
    const item =
      view?.backlogItem ?? (node.backlogItemId ? backlogById.get(node.backlogItemId) : undefined);
    const incoming = graph.edges.filter((edge) => edge.toNodeId === node.id);
    const outgoing = graph.edges.filter((edge) => edge.fromNodeId === node.id);
    return html`
      <div class="detail-card">
        <div>
          <div class="detail-title">
            ${view?.title ?? this.graphTitleForNode(backlogById, node)}
          </div>
          <div class="detail-muted">
            ${node.id} · ${this.projectForNode(backlogById, node)} · ${node.status}
          </div>
        </div>
        <div class="detail-grid">
          ${this.renderDetailCell('Execution', view?.executionStatus)}
          ${this.renderDetailCell('Type', this.nodeKindLabel(node))}
          ${this.renderDetailCell('Spec status', this.specStatusLabel(item, node))}
          ${this.renderDetailCell('Backlog', node.backlogItemId)}
          ${this.renderDetailCell('Reference', node.reference?.ref)}
          ${this.renderDetailCell('Project', this.projectForNode(backlogById, node))}
          ${this.renderDetailCell('Flow', item?.flowType)}
          ${this.renderDetailCell('Priority', item?.priority)}
          ${this.renderDetailCell('Slots', item?.allowedSlots?.join(', ') || 'Any eligible')}
          ${this.renderDetailCell(
            'Runner/model',
            [item?.runner, item?.model, item?.effort].filter(Boolean).join(' / '),
          )}
          ${this.renderDetailCell('Queue', view?.queueItem?.id)}
          ${this.renderDetailCell('Run', view?.run?.id)}
          ${this.renderDetailCell('External status', node.reference?.status)}
          ${this.renderDetailCell('Family', node.currentFamilyId)}
          ${this.renderDetailCell('Latest run', node.latestRunId)}
          ${this.renderDetailCell('Base ref', node.baseRef)}
          ${this.renderDetailCell(
            'Failure policy',
            node.onFailure ?? graph.graph.defaultFailurePolicy,
          )}
        </div>
        ${view?.summary ? html`<div class="detail-summary">${view.summary}</div>` : nothing}
        ${view?.blockers.length
          ? html`<ul class="waiting-list">
              ${view.blockers.map((blocker) => html`<li>${blocker.message}</li>`)}
            </ul>`
          : nothing}
        ${view?.visibleCandidateSlots.length
          ? html`<div class="candidate-slots">
              ${view.visibleCandidateSlots.map(
                (slot) =>
                  html`<span class=${`badge ${slot.ready ? 'ready' : 'waiting'}`}
                    >${slot.slotId}: ${slot.reason}</span
                  >`,
              )}
            </div>`
          : nothing}
        ${view ? this.renderDispatchConfig(view) : nothing}
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

  private renderSidePanel(
    graph: WorkGraphProjection,
    backlogById: Map<string, BacklogItem>,
    overlay: WorkGraphExecutionOverlay,
  ) {
    return html`
      <aside class="side-panel">
        <div class="side-head">
          <div>
            <div class="side-title">Graph nodes</div>
            <div class="small">Select backlog work or external blockers to inspect refs.</div>
          </div>
        </div>
        <div class="side-content">
          ${this.renderNodeDetail(graph, backlogById, this.selectedNode(graph), overlay)}
          ${graph.nodes.map((node) => this.renderNodeCard(graph, backlogById, node, overlay))}
        </div>
      </aside>
    `;
  }

  private renderGraph(graph: WorkGraphProjection) {
    const backlogById = this.backlogById();
    const overlay = buildWorkGraphExecutionOverlay({
      graph,
      backlogItems: this.activeBacklogItems(),
      queueItems: this.queueItems,
      runs: this.runs,
      slots: this.slots,
    });
    const stats = this.graphStats(overlay);
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
          ${this.renderDiagram(graph, backlogById, overlay)}
          ${this.renderSidePanel(graph, backlogById, overlay)}
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
