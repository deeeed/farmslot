import { html, LitElement, nothing, svg, type SVGTemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  BacklogItem,
  BacklogUpdateInput,
  ConfigProjectsResult,
  ConfigTemplateOptionsResult,
  ProjectConfig,
  QueueItem,
  Run,
  SlotStatus,
  WorkEdge,
  WorkerTemplateOption,
  WorkGraphActivateResult,
  WorkGraphProjection,
  WorkGraphSchedulerTickResult,
  WorkNode,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import '../shared/dispatch-config-editor.js';
import '../shared/linked-run-summary.js';
import '../shared/slot-choice-row.js';
import '../shared/slot-choice-list.js';

import { gateway } from '../../gateway-client.js';
import { type AppState, getState, type GlobalFilters, subscribe } from '../../state.js';
import { colors } from '../../styles/theme-tokens.js';
import { buildHash, parseHashRoute } from '../../utils/url-state.js';
import { projectPrepareProfiles } from '../dispatch/dispatch-wizard-draft.js';
import { templateOptionsRequestKey } from '../dispatch/dispatch-wizard-template-options.js';
import type {
  DispatchConfigChangeDetail,
  DispatchConfigEditorControls,
} from '../shared/dispatch-config-editor.js';
import { summarizeBacklogDispatchConfig } from '../shared/dispatch-config-summary.js';
import type { SlotChoiceChangeDetail } from '../shared/slot-choice-list.js';
import { filterSlotsByGlobalFilters } from '../terminal/split-view-model.js';

import {
  buildWorkGraphExecutionOverlay,
  type SlotExecutionView,
  type WorkGraphExecutionOverlay,
  type WorkGraphNodeExecutionView,
} from './work-graph-execution-overlay.js';
import { computeWorkGraphLayout, type WorkGraphLayoutNode } from './work-graph-layout.js';
import { workGraphPanelStyles } from './work-graph-panel-styles.js';

const WORK_GRAPH_PROJECT_PARAM = 'workGraphProject';
const WORK_GRAPH_GRAPH_PARAM = 'graph';
const WORK_GRAPH_NODE_PARAM = 'node';
const WORK_GRAPH_DISPATCH_CONFIG_CONTROLS: DispatchConfigEditorControls = {
  template: true,
  runnerModelEffort: true,
  prepareProfile: true,
  interactiveProfile: true,
  publicationReviews: true,
  explicitModeFallback: true,
};

@customElement('work-graph-panel')
export class WorkGraphPanel extends LitElement {
  @property({ attribute: false }) demoGraphs: WorkGraphProjection[] | null = null;
  @property({ attribute: false }) demoBacklogItems: BacklogItem[] | null = null;
  @property({ attribute: false }) demoRuns: Run[] | null = null;

  @state() private graphs: WorkGraphProjection[] = [];
  @state() private backlogItems: BacklogItem[] = [];
  @state() private queueItems: QueueItem[] = [];
  @state() private runs: Run[] = [];
  @state() private slots: SlotStatus[] = [];
  @state() private globalFilters: GlobalFilters = { projects: [], machines: [] };
  @state() private configBusyItemId = '';
  @state() private configError = '';
  @state() private configModalItemId = '';
  @state() private configProjectConfigs: ProjectConfig[] = [];
  @state() private configTemplateOptions: Record<string, WorkerTemplateOption[]> = {};
  @state() private configTemplateOptionsError: Record<string, string> = {};
  @state() private configTemplateOptionsLoading: Record<string, boolean> = {};
  @state() private selectedProject = '';
  @state() private selectedNodeKey = '';
  @state() private schedulerBusyKey = '';
  @state() private schedulerMessage = '';
  @state() private schedulerError = '';
  private unsub?: () => void;
  private readonly onHashChange = () => this.applyUrlStateFromHash();
  private readonly onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.configModalItemId) {
      event.preventDefault();
      this.configModalItemId = '';
    }
  };

  static styles = workGraphPanelStyles;

  connectedCallback() {
    super.connectedCallback();
    this.applyUrlStateFromHash();
    this.sync(getState());
    this.unsub = subscribe((state) => this.sync(state));
    window.addEventListener('hashchange', this.onHashChange);
    window.addEventListener('keydown', this.onKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
    window.removeEventListener('hashchange', this.onHashChange);
    window.removeEventListener('keydown', this.onKeydown);
  }

  private sync(state: AppState) {
    this.graphs = state.workGraphs;
    this.backlogItems = state.backlogItems;
    this.queueItems = state.queueItems;
    this.runs = state.runs;
    this.slots = state.fleet?.slots ?? [];
    this.globalFilters = state.globalFilters;
    const graphs = this.activeGraphs();
    const projects = new Set(graphs.map((graph) => graph.graph.project));
    if (this.selectedProject && !projects.has(this.selectedProject)) this.selectedProject = '';
    const nodeKeys = new Set(
      graphs.flatMap((graph) => graph.nodes.map((node) => this.nodeKey(graph, node.id))),
    );
    if (!this.selectedNodeKey) this.hydrateSelectedNodeFromUrl(nodeKeys);
    if (this.selectedNodeKey && !nodeKeys.has(this.selectedNodeKey)) this.selectedNodeKey = '';
  }

  private hydrateSelectedNodeFromUrl(nodeKeys: Set<string>): void {
    if (typeof location === 'undefined') return;
    const { route, params } = parseHashRoute();
    if (route !== 'work-graphs') return;
    const graphId = params.get(WORK_GRAPH_GRAPH_PARAM)?.trim() ?? '';
    const nodeId = params.get(WORK_GRAPH_NODE_PARAM)?.trim() ?? '';
    const key = graphId && nodeId ? `${graphId}:${nodeId}` : '';
    if (key && nodeKeys.has(key)) this.selectedNodeKey = key;
  }

  private applyUrlStateFromHash() {
    if (typeof location === 'undefined') return;
    const { route, params } = parseHashRoute();
    if (route !== 'work-graphs') return;
    this.selectedProject = params.get(WORK_GRAPH_PROJECT_PARAM)?.trim() ?? '';
    const graphId = params.get(WORK_GRAPH_GRAPH_PARAM)?.trim() ?? '';
    const nodeId = params.get(WORK_GRAPH_NODE_PARAM)?.trim() ?? '';
    this.selectedNodeKey = graphId && nodeId ? `${graphId}:${nodeId}` : '';
  }

  private writeUrlState() {
    if (typeof location === 'undefined') return;
    const { route, params } = parseHashRoute();
    if (route !== 'work-graphs') return;
    if (this.selectedProject) params.set(WORK_GRAPH_PROJECT_PARAM, this.selectedProject);
    else params.delete(WORK_GRAPH_PROJECT_PARAM);
    const [graphId, nodeId] = this.selectedNodeKey.split(':');
    if (graphId && nodeId) {
      params.set(WORK_GRAPH_GRAPH_PARAM, graphId);
      params.set(WORK_GRAPH_NODE_PARAM, nodeId);
    } else {
      params.delete(WORK_GRAPH_GRAPH_PARAM);
      params.delete(WORK_GRAPH_NODE_PARAM);
    }
    const next = buildHash(route, params);
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  private activeGraphs(): WorkGraphProjection[] {
    return this.demoGraphs ?? this.graphs;
  }

  private activeBacklogItems(): BacklogItem[] {
    return this.demoBacklogItems ?? this.backlogItems;
  }

  private activeRuns(): Run[] {
    return this.demoRuns ?? this.runs;
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
    this.writeUrlState();
  }

  private isSelectedNode(graph: WorkGraphProjection, nodeId: string): boolean {
    return this.selectedNodeKey === this.nodeKey(graph, nodeId);
  }

  private selectedNodeIdForGraph(graph: WorkGraphProjection): string {
    return this.selectedNodeKey.startsWith(`${graph.graph.id}:`)
      ? this.selectedNodeKey.slice(graph.graph.id.length + 1)
      : '';
  }

  private isNodeInSelectedNeighborhood(graph: WorkGraphProjection, nodeId: string): boolean {
    const selectedNodeId = this.selectedNodeIdForGraph(graph);
    if (!selectedNodeId || selectedNodeId === nodeId) return true;
    return graph.edges.some(
      (edge) =>
        (edge.fromNodeId === selectedNodeId && edge.toNodeId === nodeId) ||
        (edge.toNodeId === selectedNodeId && edge.fromNodeId === nodeId),
    );
  }

  private selectedNode(graph: WorkGraphProjection): WorkNode | null {
    return graph.nodes.find((node) => this.isSelectedNode(graph, node.id)) ?? null;
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
    const isDimmed = !this.isNodeInSelectedNeighborhood(graph, node.id);
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
        class=${`diagram-node ${node.kind === 'reference' ? 'reference-node' : ''} ${isSelected ? 'selected' : ''} ${isDimmed ? 'dimmed' : ''}`}
        transform=${`translate(${x}, ${y})`}
        role="button"
        tabindex="0"
        aria-label=${`${title}, ${status}`}
        data-testid=${`work-graph-diagram-node-${node.id.replace(/[^a-zA-Z0-9_-]+/g, '-')}`}
        @click=${() => this.selectNode(graph, node.id)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            this.selectNode(graph, node.id);
          }
        }}
      >
        ${
          isSelected
            ? svg`<rect class="selection-halo" x="-7" y="-7" width=${w + 14} height=${h + 14} rx="18"></rect>`
            : nothing
        }
        <rect class="node-shell" width=${w} height=${h} rx="12" stroke=${color}></rect>
        ${
          isSelected
            ? svg`<text class="selected-label" x=${w - 10} y="-13" text-anchor="end">selected</text>`
            : nothing
        }
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
    const selectedNode = this.selectedNodeIdForGraph(graph);
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
    return filterSlotsByGlobalFilters(this.slots, this.globalFilters)
      .filter((slot) => slot.project === item.project)
      .sort((a, b) => a.machine.localeCompare(b.machine) || a.slot.localeCompare(b.slot));
  }

  private async updateBacklogConfig(item: BacklogItem, patch: BacklogUpdateInput): Promise<void> {
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

  private updateBacklogFromDispatchConfig(
    item: BacklogItem,
    detail: DispatchConfigChangeDetail,
  ): Promise<void> {
    const {
      taskTemplateFileName: _taskTemplateFileName,
      skipPrepare: _skipPrepare,
      ...backlogPatch
    } = detail;
    return this.updateBacklogConfig(item, backlogPatch);
  }

  private backlogHash(item: BacklogItem): string {
    const { params: current } = parseHashRoute();
    const params = new URLSearchParams();
    for (const key of ['projects', 'machines']) {
      const value = current.get(key);
      if (value) params.set(key, value);
    }
    params.set('item', item.id);
    return buildHash('backlog', params);
  }

  private dispatchHash(item?: BacklogItem): string {
    const { params: current } = parseHashRoute();
    const params = new URLSearchParams();
    for (const key of ['projects', 'machines']) {
      const value = current.get(key);
      if (value) params.set(key, value);
    }
    if (item?.project && !params.get('projects')) params.set('projects', item.project);
    return buildHash('dispatch', params);
  }

  private async scheduleGraphNode(graph: WorkGraphProjection, node: WorkNode): Promise<void> {
    const busyKey = this.nodeKey(graph, node.id);
    this.schedulerBusyKey = busyKey;
    this.schedulerMessage = '';
    this.schedulerError = '';
    try {
      if (graph.graph.status === 'paused') {
        this.schedulerMessage = 'Graph is paused. Resume it before dispatching this node.';
        return;
      }
      if (graph.graph.status === 'planning') {
        const result = await gateway.request<WorkGraphActivateResult>(Methods.WORK_GRAPH_ACTIVATE, {
          graphId: graph.graph.id,
        });
        this.schedulerMessage = this.schedulerTickMessage(
          graph,
          node,
          { ok: true, graphs: [result.graph] },
          'Graph activated. ',
        );
        return;
      }
      const result = await gateway.request<WorkGraphSchedulerTickResult>(
        Methods.WORK_GRAPH_SCHEDULER_TICK,
        { graphId: graph.graph.id },
      );
      this.schedulerMessage = this.schedulerTickMessage(graph, node, result);
    } catch (error) {
      this.schedulerError = error instanceof Error ? error.message : String(error);
    } finally {
      this.schedulerBusyKey = '';
    }
  }

  private schedulerTickMessage(
    graph: WorkGraphProjection,
    node: WorkNode,
    result: WorkGraphSchedulerTickResult,
    prefix = '',
  ): string {
    const nextGraph =
      result.graphs.find((candidate) => candidate.graph.id === graph.graph.id) ?? graph;
    const nextNode = nextGraph?.nodes.find((candidate) => candidate.id === node.id);
    if (result.graphs.every((candidate) => candidate.graph.id !== graph.graph.id)) {
      if (nextGraph.graph.status === 'planning') {
        return 'Graph is still planning. Activate it before dispatching this node.';
      }
      if (nextGraph.graph.status === 'paused') {
        return 'Graph is paused. Resume it before dispatching this node.';
      }
      return 'Scheduler did not run this graph. Activate it if it is planning or paused.';
    }
    if (!nextNode) return 'Scheduler ran, but the selected node was not found afterward.';
    if (nextNode.status === 'planned') {
      return `${prefix}Graph is still planning. Activate it before dispatching this node.`;
    }
    if (nextNode.status === 'queued') {
      return `${prefix}Queued for launch. The dispatch queue will start it on an eligible slot.`;
    }
    if (nextNode.status === 'running')
      return `${prefix}Dispatch active: this node has an active run.`;
    if (nextNode.status === 'waiting') {
      const reason = nextNode.waitingOn[0]?.detail;
      return reason
        ? `${prefix}Not queued yet: waiting on ${reason}.`
        : `${prefix}Not queued yet: this node is still waiting on upstream work.`;
    }
    if (nextNode.status === 'needs-attention') {
      const reason = nextNode.waitingOn[0]?.detail;
      return reason
        ? `${prefix}Needs attention: ${reason}.`
        : `${prefix}Needs attention before it can be queued.`;
    }
    if (nextNode.status === 'ready') {
      return `${prefix}Ready, but not queued. Review auto start, slots, and dispatch config.`;
    }
    return `${prefix}Checked: ${nextNode.status}.`;
  }

  private async ensureDispatchConfigData(item: BacklogItem): Promise<void> {
    if (this.configProjectConfigs.length === 0) {
      const result = await gateway.request<ConfigProjectsResult>(Methods.CONFIG_PROJECTS, {});
      this.configProjectConfigs = result.projects;
    }

    const key = templateOptionsRequestKey(item.project, item.flowType);
    if (this.configTemplateOptions[key] || this.configTemplateOptionsLoading[key]) return;
    this.configTemplateOptionsLoading = { ...this.configTemplateOptionsLoading, [key]: true };
    this.configTemplateOptionsError = { ...this.configTemplateOptionsError, [key]: '' };
    try {
      const result = await gateway.request<ConfigTemplateOptionsResult>(
        Methods.CONFIG_TEMPLATE_OPTIONS,
        {
          project: item.project,
          flowType: item.flowType,
        },
      );
      this.configTemplateOptions = { ...this.configTemplateOptions, [key]: result.options };
    } catch (error) {
      this.configTemplateOptionsError = {
        ...this.configTemplateOptionsError,
        [key]: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.configTemplateOptionsLoading = { ...this.configTemplateOptionsLoading, [key]: false };
    }
  }

  private openDispatchConfigModal(item: BacklogItem) {
    this.configModalItemId = item.id;
    void this.ensureDispatchConfigData(item).catch((error) => {
      this.configError = error instanceof Error ? error.message : String(error);
    });
  }

  private templateOptionsForItem(item: BacklogItem): WorkerTemplateOption[] {
    return this.configTemplateOptions[templateOptionsRequestKey(item.project, item.flowType)] ?? [];
  }

  private templateOptionsStateForItem(item: BacklogItem): { loading: boolean; error: string } {
    const key = templateOptionsRequestKey(item.project, item.flowType);
    return {
      loading: this.configTemplateOptionsLoading[key] ?? false,
      error: this.configTemplateOptionsError[key] ?? '',
    };
  }

  private dispatchConfigSummary(item: BacklogItem): string {
    const summary = summarizeBacklogDispatchConfig(item);
    return `${summary.execution} · ${summary.slots}`;
  }

  private renderDispatchConfig(view: WorkGraphNodeExecutionView) {
    const item = view.backlogItem;
    if (!item) return nothing;
    const disabled = !view.editableConfig || this.configBusyItemId === item.id;
    return html`
      <div class="config-editor">
        <div class="config-head">
          <div>
            <div class="detail-title">Dispatch config</div>
            <div class="detail-muted">${this.dispatchConfigSummary(item)}</div>
          </div>
          ${!view.editableConfig ? html`<span class="badge queued">locked</span>` : nothing}
        </div>
        ${this.configError ? html`<div class="config-error">${this.configError}</div>` : nothing}
        <button
          class="config-edit-button"
          type="button"
          ?disabled=${disabled}
          @click=${() => this.openDispatchConfigModal(item)}
        >
          Edit dispatch config
        </button>
        ${this.configModalItemId === item.id
          ? this.renderDispatchConfigModal(item, disabled)
          : nothing}
      </div>
    `;
  }

  private renderDispatchConfigModal(item: BacklogItem, disabled: boolean) {
    const slotOptions = this.slotOptionsForItem(item);
    const templateState = this.templateOptionsStateForItem(item);
    return html`
      <div
        class="modal-backdrop"
        @click=${(event: MouseEvent) => {
          if (event.target === event.currentTarget) this.configModalItemId = '';
        }}
      >
        <section
          class="dispatch-config-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Edit dispatch config"
        >
          <header>
            <div>
              <h3>Dispatch config</h3>
              <p class="detail-muted">Changes save immediately to the linked backlog item.</p>
            </div>
            <button class="secondary" type="button" @click=${() => (this.configModalItemId = '')}>
              Close
            </button>
          </header>
          ${this.configError ? html`<div class="config-error">${this.configError}</div>` : nothing}
          <dispatch-config-editor
            .project=${item.project}
            .flowType=${item.flowType}
            .runner=${item.runner ?? ''}
            .model=${item.model ?? ''}
            .effort=${item.effort ?? ''}
            .mode=${item.mode ?? ''}
            .devInteractiveProfile=${item.devInteractiveProfile ?? ''}
            .taskTemplate=${item.taskTemplate ?? null}
            .templateOptions=${this.templateOptionsForItem(item)}
            .prepareProfile=${item.prepareProfile ?? ''}
            .prepareProfiles=${projectPrepareProfiles(this.configProjectConfigs, item.project)}
            .pendingReviewPlan=${item.pendingReviewPlan ?? []}
            .controls=${WORK_GRAPH_DISPATCH_CONFIG_CONTROLS}
            .disabled=${disabled}
            @dispatch-config-change=${(event: CustomEvent<DispatchConfigChangeDetail>) =>
              this.updateBacklogFromDispatchConfig(item, event.detail)}
          ></dispatch-config-editor>
          ${templateState.loading
            ? html`<div class="detail-muted">Loading task templates...</div>`
            : nothing}
          ${templateState.error
            ? html`<div class="config-error">${templateState.error}</div>`
            : nothing}
          <div class="config-grid">
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
                .checked=${item.autoDispatch !== false}
                ?disabled=${disabled}
                @change=${(event: Event) =>
                  this.updateBacklogConfig(item, {
                    autoDispatch: (event.target as HTMLInputElement).checked,
                  })}
              />
              <span>
                Auto-enqueue when ready
                <small>
                  When dependencies are satisfied, the graph scheduler may add this backlog item to
                  the dispatch queue. Turn off to require manual scheduling.
                </small>
              </span>
            </label>
          </div>
          <div class="slot-picker">
            <div>
              <div class="detail-label">Allowed slots</div>
              <div class="detail-muted">Filtered by the global project and machine selectors.</div>
            </div>
            <slot-choice-list
              .project=${item.project}
              .slots=${slotOptions}
              .selectedSlots=${item.allowedSlots ?? []}
              .disabled=${disabled}
              @slot-choice-change=${(event: CustomEvent<SlotChoiceChangeDetail>) =>
                this.updateBacklogConfig(item, { allowedSlots: event.detail.allowedSlots })}
            ></slot-choice-list>
          </div>
        </section>
      </div>
    `;
  }

  private slotStatusById(): Map<string, SlotStatus> {
    return new Map(this.slots.map((slot) => [slot.slot, slot]));
  }

  private renderGraphSlotRows(visibleSlots: readonly SlotExecutionView[]) {
    const byId = this.slotStatusById();
    const readyCount = visibleSlots.filter((slot) => slot.ready).length;
    return html`<details class="candidate-slots-panel">
      <summary>
        Candidate slots
        <span>${readyCount}/${visibleSlots.length} ready</span>
      </summary>
      <div class="candidate-slots">
        ${visibleSlots.map((slot, index) => {
          const status = byId.get(slot.slotId);
          const runner = status?.runner
            ? `${status.runner}/${status.model ?? 'default'}`
            : 'default runner';
          const branch = status?.branch || slot.reason;
          const task = [
            status?.machine,
            runner,
            slot.reason,
            slot.queueItemIds.length ? `queue ${slot.queueItemIds.join(', ')}` : '',
            slot.runIds.length ? `run ${slot.runIds.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join(' · ');
          return html`<slot-choice-row
            .rank=${slot.ready ? `#${index + 1}` : '--'}
            .slotId=${slot.slotId}
            .branch=${branch}
            .task=${task}
            .lifecycle=${slot.lifecycle}
            .score=${slot.ready ? 'ready' : 'wait'}
            ?selected=${slot.ready}
            ?warning=${!slot.ready}
          ></slot-choice-row>`;
        })}
      </div>
    </details>`;
  }

  private renderNodeDetail(
    graph: WorkGraphProjection,
    backlogById: Map<string, BacklogItem>,
    node: WorkNode | null,
    overlay: WorkGraphExecutionOverlay,
  ) {
    if (!node) {
      return html`<div class="detail-card empty-detail">
        <div class="detail-title">No node selected</div>
        <div class="detail-muted">
          Select a graph node to inspect dependencies, slots, and dispatch config.
        </div>
      </div>`;
    }
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
        ${item
          ? html`<div class="dispatch-actions">
              <button
                class="primary-action"
                type="button"
                ?disabled=${this.schedulerBusyKey === this.nodeKey(graph, node.id)}
                title="Dispatches this graph node when dependencies are satisfied. Internally this runs the WorkGraph scheduler so graph metadata stays intact."
                @click=${() => this.scheduleGraphNode(graph, node)}
              >
                ${this.schedulerBusyKey === this.nodeKey(graph, node.id)
                  ? 'Dispatching...'
                  : 'Dispatch'}
              </button>
              <a class="secondary-link" href=${this.backlogHash(item)}>Open backlog item</a>
              <a class="secondary-link" href=${this.dispatchHash(item)}>Open dispatch queue</a>
              <div class="detail-muted">
                Graph-linked backlog items dispatch through the graph so dependencies and run
                metadata stay intact.
              </div>
            </div>`
          : nothing}
        ${this.schedulerMessage
          ? html`<div class="config-message">${this.schedulerMessage}</div>`
          : nothing}
        ${this.schedulerError
          ? html`<div class="config-error">${this.schedulerError}</div>`
          : nothing}
        <linked-run-summary .run=${view?.run} label="Node run" compact></linked-run-summary>
        <div class="detail-grid">
          ${this.renderDetailCell('Execution', view?.executionStatus)}
          ${this.renderDetailCell('Type', this.nodeKindLabel(node))}
          ${this.renderDetailCell('Spec status', this.specStatusLabel(item, node))}
          ${this.renderDetailCell('Backlog', node.backlogItemId)}
          ${this.renderDetailCell('Reference', node.reference?.ref)}
          ${this.renderDetailCell('Project', this.projectForNode(backlogById, node))}
          ${this.renderDetailCell('Flow', item?.flowType)}
          ${this.renderDetailCell('Mode', item?.mode)}
          ${this.renderDetailCell('Prepare', item?.prepareProfile)}
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
          ? this.renderGraphSlotRows(view.visibleCandidateSlots)
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
      runs: this.activeRuns(),
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
            this.writeUrlState();
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
