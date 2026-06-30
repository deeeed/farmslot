import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type {
  BacklogItem,
  EdgeCondition,
  RoadmapItem,
  UnlockAction,
  WorkEdgeBlocks,
  WorkGraphAddNodeResult,
  WorkGraphProjection,
  WorkReferenceKind,
  WorkReferenceStatus,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import {
  planningBadgeStyles,
  renderPlanningBadge,
  tagsFromInput,
} from '../shared/planning-badges.js';

const CONDITION_KINDS = ['family-done', 'merged', 'manual', 'reference-status'] as const;
const REFERENCE_KINDS: WorkReferenceKind[] = [
  'jira',
  'github-pr',
  'github-issue',
  'package-release',
  'artifact',
  'manual',
  'url',
  'other',
];
const REFERENCE_STATUSES: WorkReferenceStatus[] = [
  'unknown',
  'pending',
  'blocked',
  'satisfied',
  'failed',
  'waived',
];

type ComposerConditionKind = (typeof CONDITION_KINDS)[number];
type ComposerUnlockKind = UnlockAction['kind'];

@customElement('roadmap-graph-composer')
export class RoadmapGraphComposer extends LitElement {
  @property({ attribute: false }) item: RoadmapItem | null = null;
  @property({ attribute: false }) backlogItems: BacklogItem[] = [];
  @property({ attribute: false }) workGraphs: WorkGraphProjection[] = [];
  @property({ attribute: false }) tagsInput = '';

  @state() private selectedGraphId = '';
  @state() private graphTitle = '';
  @state() private composerBacklogId = '';
  @state() private referenceKind: WorkReferenceKind = 'manual';
  @state() private referenceTitle = '';
  @state() private referenceRef = '';
  @state() private referenceStatus: WorkReferenceStatus = 'pending';
  @state() private referenceUrl = '';
  @state() private referenceProject = '';
  @state() private edgeFromNodeId = '';
  @state() private edgeToNodeId = '';
  @state() private edgeBlocks: WorkEdgeBlocks = 'start';
  @state() private edgeConditionKind: ComposerConditionKind = 'family-done';
  @state() private edgeUnlockKind: ComposerUnlockKind = 'enqueue';
  @state() private edgeManualGateId = '';
  @state() private edgeReferenceStatus: WorkReferenceStatus = 'satisfied';
  @state() private edgeTargetRef = '';
  @state() private edgeRequired = true;
  @state() private busy = '';

  static styles = [
    planningBadgeStyles,
    css`
      :host {
        display: block;
      }
      .card {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.md)};
        background: ${unsafeCSS(colors.bgCard)};
        padding: ${unsafeCSS(spacing.md)};
      }
      .editor-head,
      .mini-row {
        display: flex;
        justify-content: space-between;
        gap: ${unsafeCSS(spacing.sm)};
        align-items: flex-start;
      }
      h3,
      p {
        margin: 0;
      }
      h3 {
        font-size: ${unsafeCSS(fonts.sizeMd)};
        margin-bottom: ${unsafeCSS(spacing.sm)};
      }
      .muted,
      label,
      .meta {
        color: ${unsafeCSS(colors.textMuted)};
        font-size: ${unsafeCSS(fonts.sizeXs)};
      }
      label {
        display: grid;
        gap: 4px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      input,
      select {
        border: 1px solid ${unsafeCSS(colors.textMuted)}33;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgSurface)};
        color: ${unsafeCSS(colors.textPrimary)};
        font: inherit;
        padding: 8px;
      }
      button {
        border: 1px solid ${unsafeCSS(colors.accent)}66;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.accent)}22;
        color: ${unsafeCSS(colors.textPrimary)};
        font: inherit;
        padding: 8px 10px;
        cursor: pointer;
      }
      button.danger {
        border-color: ${unsafeCSS(colors.statusFail)}66;
        background: ${unsafeCSS(colors.statusFail)}22;
      }
      button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .composer-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        gap: ${unsafeCSS(spacing.sm)};
        align-items: end;
      }
      .composer-section {
        border-top: 1px solid ${unsafeCSS(colors.textMuted)}22;
        margin-top: ${unsafeCSS(spacing.md)};
        padding-top: ${unsafeCSS(spacing.md)};
        display: grid;
        gap: ${unsafeCSS(spacing.sm)};
      }
      .mini-row {
        border: 1px solid ${unsafeCSS(colors.textMuted)}22;
        border-radius: ${unsafeCSS(radii.sm)};
        background: ${unsafeCSS(colors.bgSurface)};
        padding: 8px;
      }
      .title {
        color: ${unsafeCSS(colors.textPrimary)};
        font-weight: 700;
      }
      .empty {
        color: ${unsafeCSS(colors.textMuted)};
        padding: ${unsafeCSS(spacing.md)};
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
    `,
  ];

  private emitDetail(type: 'message' | 'error', text: string) {
    this.dispatchEvent(
      new CustomEvent(`roadmap-graph-${type}`, {
        detail: text,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private promotionBacklogIds(item: RoadmapItem): string[] {
    return [
      ...new Set(
        (item.promotion ?? []).map((entry) => entry.backlogItemId).filter(Boolean) as string[],
      ),
    ];
  }

  private graphsForItem(item: RoadmapItem): WorkGraphProjection[] {
    const backlogIds = new Set(this.promotionBacklogIds(item));
    return this.workGraphs
      .filter(
        (graph) =>
          graph.graph.source.ref === item.id ||
          graph.nodes.some((node) => node.backlogItemId && backlogIds.has(node.backlogItemId)),
      )
      .sort((a, b) => {
        if (a.graph.status === 'planning' && b.graph.status !== 'planning') return -1;
        if (a.graph.status !== 'planning' && b.graph.status === 'planning') return 1;
        return b.graph.updatedAt.localeCompare(a.graph.updatedAt);
      });
  }

  private selectedGraph(item: RoadmapItem): WorkGraphProjection | null {
    const graphs = this.graphsForItem(item);
    return graphs.find((graph) => graph.graph.id === this.selectedGraphId) ?? graphs[0] ?? null;
  }

  private backlogTitle(itemId: string): string {
    return this.backlogItems.find((item) => item.id === itemId)?.title ?? itemId;
  }

  private availableBacklogItems(graph: WorkGraphProjection | null): BacklogItem[] {
    const graphId = graph?.graph.id;
    return this.backlogItems
      .filter((item) => item.status !== 'archived')
      .filter((item) => !item.workGraphId || item.workGraphId === graphId)
      .filter((item) => !graph?.nodes.some((node) => node.backlogItemId === item.id))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  private edgeCondition(): EdgeCondition {
    if (this.edgeConditionKind === 'merged') {
      return this.edgeTargetRef.trim()
        ? { kind: 'merged', targetRef: this.edgeTargetRef.trim() }
        : { kind: 'merged' };
    }
    if (this.edgeConditionKind === 'manual') {
      return { kind: 'manual', gateId: this.edgeManualGateId.trim() || 'manual-approval' };
    }
    if (this.edgeConditionKind === 'reference-status') {
      return { kind: 'reference-status', status: this.edgeReferenceStatus };
    }
    return { kind: 'family-done' };
  }

  private unlockAction(): UnlockAction {
    if (this.edgeUnlockKind === 'mark-ready') return { kind: 'mark-ready' };
    if (this.edgeUnlockKind === 'rebase-onto') return { kind: 'rebase-onto', flow: 'pr-complete' };
    return { kind: 'enqueue' };
  }

  private async createGraphFromPromotions(item: RoadmapItem) {
    const backlogIds = this.promotionBacklogIds(item);
    if (backlogIds.length === 0) {
      this.emitDetail('error', 'Promote backlog specs before creating a WorkGraph');
      return;
    }
    const promotedItems = backlogIds.map((id) =>
      this.backlogItems.find((backlog) => backlog.id === id),
    );
    const missingId = backlogIds.find((id, index) => !promotedItems[index]);
    if (missingId) {
      this.emitDetail('error', `Promoted backlog item is not loaded: ${missingId}`);
      return;
    }
    const linkedItem = promotedItems.find((backlog) => backlog?.workGraphId);
    if (linkedItem?.workGraphId) {
      this.emitDetail('error', `${linkedItem.title} is already linked to a WorkGraph`);
      return;
    }
    this.busy = 'graph-create';
    try {
      const created = await gateway.request<WorkGraphAddNodeResult>(Methods.WORK_GRAPH_CREATE, {
        project: item.project,
        title: this.graphTitle.trim() || `${item.title} execution graph`,
        source: { kind: 'manual', ref: item.id },
        tags: tagsFromInput(this.tagsInput),
      });
      let graph = created.graph;
      for (const backlogItemId of backlogIds) {
        graph = (
          await gateway.request<WorkGraphAddNodeResult>(Methods.WORK_GRAPH_ADD_NODE, {
            graphId: graph.graph.id,
            backlogItemId,
          })
        ).graph;
      }
      this.selectedGraphId = graph.graph.id;
      this.graphTitle = '';
      this.emitDetail('message', `Planning WorkGraph created: ${graph.graph.title}`);
    } catch (err) {
      this.emitDetail('error', (err as Error).message);
    } finally {
      this.busy = '';
    }
  }

  private async addBacklogNode(graph: WorkGraphProjection) {
    if (!this.composerBacklogId) return;
    this.busy = 'graph-add-node';
    try {
      await gateway.request(Methods.WORK_GRAPH_ADD_NODE, {
        graphId: graph.graph.id,
        backlogItemId: this.composerBacklogId,
      });
      this.composerBacklogId = '';
      this.emitDetail('message', 'Backlog node added to planning graph');
    } catch (err) {
      this.emitDetail('error', (err as Error).message);
    } finally {
      this.busy = '';
    }
  }

  private async addReferenceNode(graph: WorkGraphProjection) {
    this.busy = 'graph-add-reference';
    try {
      await gateway.request(Methods.WORK_GRAPH_ADD_NODE, {
        graphId: graph.graph.id,
        kind: 'reference',
        reference: {
          kind: this.referenceKind,
          title: this.referenceTitle,
          ref: this.referenceRef,
          status: this.referenceStatus,
          ...(this.referenceUrl.trim() ? { url: this.referenceUrl.trim() } : {}),
          ...(this.referenceProject.trim() ? { project: this.referenceProject.trim() } : {}),
          labels: tagsFromInput(this.tagsInput),
        },
      });
      this.referenceTitle = '';
      this.referenceRef = '';
      this.referenceUrl = '';
      this.referenceProject = '';
      this.emitDetail('message', 'Reference blocker added to planning graph');
    } catch (err) {
      this.emitDetail('error', (err as Error).message);
    } finally {
      this.busy = '';
    }
  }

  private async addEdge(graph: WorkGraphProjection) {
    this.busy = 'graph-add-edge';
    try {
      await gateway.request(Methods.WORK_GRAPH_ADD_EDGE, {
        graphId: graph.graph.id,
        fromNodeId: this.edgeFromNodeId,
        toNodeId: this.edgeToNodeId,
        blocks: this.edgeBlocks,
        condition: this.edgeCondition(),
        unlock: this.unlockAction(),
        required: this.edgeRequired,
      });
      this.edgeFromNodeId = '';
      this.edgeToNodeId = '';
      this.emitDetail('message', 'Dependency edge added');
    } catch (err) {
      this.emitDetail('error', (err as Error).message);
    } finally {
      this.busy = '';
    }
  }

  private async removeNode(graph: WorkGraphProjection, nodeId: string) {
    this.busy = 'graph-remove-node';
    try {
      await gateway.request(Methods.WORK_GRAPH_REMOVE_NODE, { graphId: graph.graph.id, nodeId });
      this.emitDetail('message', 'Planning graph node removed');
    } catch (err) {
      this.emitDetail('error', (err as Error).message);
    } finally {
      this.busy = '';
    }
  }

  private async removeEdge(graph: WorkGraphProjection, edgeId: string) {
    this.busy = 'graph-remove-edge';
    try {
      await gateway.request(Methods.WORK_GRAPH_REMOVE_EDGE, { graphId: graph.graph.id, edgeId });
      this.emitDetail('message', 'Planning graph edge removed');
    } catch (err) {
      this.emitDetail('error', (err as Error).message);
    } finally {
      this.busy = '';
    }
  }

  private async activateGraph(graph: WorkGraphProjection) {
    const ok = window.confirm(
      `Activate WorkGraph "${graph.graph.title}"? Active graphs are read-only.`,
    );
    if (!ok) return;
    this.busy = 'graph-activate';
    try {
      await gateway.request(Methods.WORK_GRAPH_ACTIVATE, { graphId: graph.graph.id });
      this.emitDetail('message', 'WorkGraph activated');
    } catch (err) {
      this.emitDetail('error', (err as Error).message);
    } finally {
      this.busy = '';
    }
  }

  private renderNodeLabel(graph: WorkGraphProjection, nodeId: string): string {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return nodeId;
    if (node.kind === 'reference') return `${node.id}: ${node.reference?.title ?? nodeId}`;
    return `${node.id}: ${node.backlogItemId ? this.backlogTitle(node.backlogItemId) : nodeId}`;
  }

  render() {
    const item = this.item;
    if (!item) return nothing;
    const relatedGraphs = this.graphsForItem(item);
    const graph = this.selectedGraph(item);
    const planning = graph?.graph.status === 'planning';
    const graphBusy = Boolean(this.busy);
    const availableBacklog = this.availableBacklogItems(graph);
    const nodeOptions = graph?.nodes ?? [];

    return html`<div class="card" data-testid="roadmap-graph-composer">
      <div class="editor-head">
        <div>
          <h3>Planning WorkGraph composer</h3>
          <p class="muted">
            Compose dependencies over promoted backlog specs and reference blockers, then activate.
          </p>
        </div>
        ${graph
          ? renderPlanningBadge(graph.graph.status, planning ? 'default' : 'positive')
          : nothing}
      </div>

      <div class="composer-grid">
        <label>
          Graph
          <select
            data-testid="roadmap-graph-select"
            .value=${graph?.graph.id ?? ''}
            @change=${(e: Event) => (this.selectedGraphId = (e.target as HTMLSelectElement).value)}
          >
            ${relatedGraphs.length === 0 ? html`<option value="">No graph yet</option>` : nothing}
            ${relatedGraphs.map(
              (candidate) =>
                html`<option value=${candidate.graph.id}>
                  ${candidate.graph.title} (${candidate.graph.status})
                </option>`,
            )}
          </select>
        </label>
        <label>
          New graph title
          <input
            data-testid="roadmap-graph-title"
            placeholder=${`${item.title} execution graph`}
            .value=${this.graphTitle}
            @input=${(e: Event) => (this.graphTitle = (e.target as HTMLInputElement).value)}
          />
        </label>
        <button
          data-testid="roadmap-create-graph"
          ?disabled=${graphBusy || this.promotionBacklogIds(item).length === 0}
          @click=${() => this.createGraphFromPromotions(item)}
        >
          Create graph from promoted specs
        </button>
      </div>

      ${graph
        ? html`<div class="composer-section">
            <div class="meta">
              ${graph.graph.id} · ${graph.graph.project} · ${graph.nodes.length} nodes ·
              ${graph.edges.length} edges
            </div>
            ${planning
              ? html`<div class="composer-grid">
                    <label>
                      Add backlog node
                      <select
                        data-testid="roadmap-graph-backlog-node"
                        .value=${this.composerBacklogId}
                        @change=${(e: Event) =>
                          (this.composerBacklogId = (e.target as HTMLSelectElement).value)}
                      >
                        <option value="">Choose backlog item…</option>
                        ${availableBacklog.map(
                          (backlog) =>
                            html`<option value=${backlog.id}>
                              ${backlog.title} · ${backlog.project}
                            </option>`,
                        )}
                      </select>
                    </label>
                    <button
                      data-testid="roadmap-graph-add-backlog-node"
                      ?disabled=${!this.composerBacklogId || graphBusy}
                      @click=${() => this.addBacklogNode(graph)}
                    >
                      Add backlog node
                    </button>
                  </div>
                  <div class="composer-grid">
                    <label>
                      Reference kind
                      <select
                        data-testid="roadmap-reference-kind"
                        .value=${this.referenceKind}
                        @change=${(e: Event) =>
                          (this.referenceKind = (e.target as HTMLSelectElement)
                            .value as WorkReferenceKind)}
                      >
                        ${REFERENCE_KINDS.map(
                          (kind) => html`<option value=${kind}>${kind}</option>`,
                        )}
                      </select>
                    </label>
                    <label>
                      Reference title
                      <input
                        data-testid="roadmap-reference-title"
                        .value=${this.referenceTitle}
                        @input=${(e: Event) =>
                          (this.referenceTitle = (e.target as HTMLInputElement).value)}
                      />
                    </label>
                    <label>
                      Ref / URL key
                      <input
                        data-testid="roadmap-reference-ref"
                        .value=${this.referenceRef}
                        @input=${(e: Event) =>
                          (this.referenceRef = (e.target as HTMLInputElement).value)}
                      />
                    </label>
                    <label>
                      Status
                      <select
                        data-testid="roadmap-reference-status"
                        .value=${this.referenceStatus}
                        @change=${(e: Event) =>
                          (this.referenceStatus = (e.target as HTMLSelectElement)
                            .value as WorkReferenceStatus)}
                      >
                        ${REFERENCE_STATUSES.map(
                          (status) => html`<option value=${status}>${status}</option>`,
                        )}
                      </select>
                    </label>
                    <label>
                      URL
                      <input
                        data-testid="roadmap-reference-url"
                        .value=${this.referenceUrl}
                        @input=${(e: Event) =>
                          (this.referenceUrl = (e.target as HTMLInputElement).value)}
                      />
                    </label>
                    <label>
                      Project/owner label
                      <input
                        data-testid="roadmap-reference-project"
                        .value=${this.referenceProject}
                        @input=${(e: Event) =>
                          (this.referenceProject = (e.target as HTMLInputElement).value)}
                      />
                    </label>
                    <button
                      data-testid="roadmap-graph-add-reference-node"
                      ?disabled=${!this.referenceTitle.trim() ||
                      !this.referenceRef.trim() ||
                      graphBusy}
                      @click=${() => this.addReferenceNode(graph)}
                    >
                      Add reference blocker
                    </button>
                  </div>
                  <div class="composer-grid">
                    <label>
                      From
                      <select
                        data-testid="roadmap-edge-from"
                        .value=${this.edgeFromNodeId}
                        @change=${(e: Event) =>
                          (this.edgeFromNodeId = (e.target as HTMLSelectElement).value)}
                      >
                        <option value="">Choose source…</option>
                        ${nodeOptions.map(
                          (node) =>
                            html`<option value=${node.id}>
                              ${this.renderNodeLabel(graph, node.id)}
                            </option>`,
                        )}
                      </select>
                    </label>
                    <label>
                      To
                      <select
                        data-testid="roadmap-edge-to"
                        .value=${this.edgeToNodeId}
                        @change=${(e: Event) =>
                          (this.edgeToNodeId = (e.target as HTMLSelectElement).value)}
                      >
                        <option value="">Choose target…</option>
                        ${nodeOptions.map(
                          (node) =>
                            html`<option value=${node.id}>
                              ${this.renderNodeLabel(graph, node.id)}
                            </option>`,
                        )}
                      </select>
                    </label>
                    <label>
                      Blocks
                      <select
                        data-testid="roadmap-edge-blocks"
                        .value=${this.edgeBlocks}
                        @change=${(e: Event) =>
                          (this.edgeBlocks = (e.target as HTMLSelectElement)
                            .value as WorkEdgeBlocks)}
                      >
                        <option value="start">start</option>
                        <option value="completion">completion</option>
                      </select>
                    </label>
                    <label>
                      Condition
                      <select
                        data-testid="roadmap-edge-condition"
                        .value=${this.edgeConditionKind}
                        @change=${(e: Event) =>
                          (this.edgeConditionKind = (e.target as HTMLSelectElement)
                            .value as ComposerConditionKind)}
                      >
                        ${CONDITION_KINDS.map(
                          (kind) => html`<option value=${kind}>${kind}</option>`,
                        )}
                      </select>
                    </label>
                    ${this.edgeConditionKind === 'manual'
                      ? html`<label>
                          Gate id
                          <input
                            data-testid="roadmap-edge-gate-id"
                            .value=${this.edgeManualGateId}
                            @input=${(e: Event) =>
                              (this.edgeManualGateId = (e.target as HTMLInputElement).value)}
                          />
                        </label>`
                      : nothing}
                    ${this.edgeConditionKind === 'merged'
                      ? html`<label>
                          Target ref
                          <input
                            data-testid="roadmap-edge-target-ref"
                            .value=${this.edgeTargetRef}
                            @input=${(e: Event) =>
                              (this.edgeTargetRef = (e.target as HTMLInputElement).value)}
                          />
                        </label>`
                      : nothing}
                    ${this.edgeConditionKind === 'reference-status'
                      ? html`<label>
                          Required status
                          <select
                            data-testid="roadmap-edge-reference-status"
                            .value=${this.edgeReferenceStatus}
                            @change=${(e: Event) =>
                              (this.edgeReferenceStatus = (e.target as HTMLSelectElement)
                                .value as WorkReferenceStatus)}
                          >
                            ${REFERENCE_STATUSES.map(
                              (status) => html`<option value=${status}>${status}</option>`,
                            )}
                          </select>
                        </label>`
                      : nothing}
                    <label>
                      Unlock
                      <select
                        data-testid="roadmap-edge-unlock"
                        .value=${this.edgeUnlockKind}
                        @change=${(e: Event) =>
                          (this.edgeUnlockKind = (e.target as HTMLSelectElement)
                            .value as ComposerUnlockKind)}
                      >
                        <option value="enqueue">enqueue</option>
                        <option value="mark-ready">mark-ready</option>
                        <option value="rebase-onto">rebase-onto</option>
                      </select>
                    </label>
                    <label>
                      Required
                      <input
                        data-testid="roadmap-edge-required"
                        type="checkbox"
                        .checked=${this.edgeRequired}
                        @change=${(e: Event) =>
                          (this.edgeRequired = (e.target as HTMLInputElement).checked)}
                      />
                    </label>
                    <button
                      data-testid="roadmap-graph-add-edge"
                      ?disabled=${!this.edgeFromNodeId ||
                      !this.edgeToNodeId ||
                      this.edgeFromNodeId === this.edgeToNodeId ||
                      graphBusy}
                      @click=${() => this.addEdge(graph)}
                    >
                      Add edge
                    </button>
                  </div>`
              : html`<p class="muted">
                  Active and non-planning graphs are read-only in this editor.
                </p>`}

            <div class="composer-section">
              <h3>Nodes</h3>
              ${graph.nodes.length === 0
                ? html`<div class="empty">No nodes yet.</div>`
                : graph.nodes.map(
                    (node) =>
                      html`<div class="mini-row">
                        <div>
                          <div class="title">${this.renderNodeLabel(graph, node.id)}</div>
                          <div class="meta">${node.kind} · ${node.status}</div>
                        </div>
                        ${planning
                          ? html`<button
                              class="danger"
                              data-testid=${`roadmap-remove-node-${node.id}`}
                              ?disabled=${graphBusy}
                              @click=${() => this.removeNode(graph, node.id)}
                            >
                              Remove
                            </button>`
                          : nothing}
                      </div>`,
                  )}
            </div>
            <div class="composer-section">
              <h3>Edges</h3>
              ${graph.edges.length === 0
                ? html`<div class="empty">No edges yet.</div>`
                : graph.edges.map(
                    (edge) =>
                      html`<div class="mini-row">
                        <div>
                          <div class="title">
                            ${this.renderNodeLabel(graph, edge.fromNodeId)} →
                            ${this.renderNodeLabel(graph, edge.toNodeId)}
                          </div>
                          <div class="meta">
                            ${edge.condition.kind} · ${edge.blocks ?? 'start'} · ${edge.unlock.kind}
                          </div>
                        </div>
                        ${planning
                          ? html`<button
                              class="danger"
                              data-testid=${`roadmap-remove-edge-${edge.id}`}
                              ?disabled=${graphBusy}
                              @click=${() => this.removeEdge(graph, edge.id)}
                            >
                              Remove
                            </button>`
                          : nothing}
                      </div>`,
                  )}
            </div>
            ${planning
              ? html`<div class="actions">
                  <button
                    data-testid="roadmap-graph-activate"
                    ?disabled=${graph.nodes.length === 0 || graphBusy}
                    @click=${() => this.activateGraph(graph)}
                  >
                    Activate WorkGraph
                  </button>
                </div>`
              : nothing}
          </div>`
        : html`<div class="empty">No WorkGraph is linked to this roadmap item yet.</div>`}
    </div>`;
  }
}
