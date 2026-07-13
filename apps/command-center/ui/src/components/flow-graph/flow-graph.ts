// flow-graph.ts — SVG flow graph visualization component.
// Renders a DAG of steps, decisions, terminals, and chains per flow type + mode.

import { html, LitElement, nothing, svg } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ConfigTemplatesResult, FlowType, TemplatePreview } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import '../config/template-schema.js';

import { gateway } from '../../gateway-client.js';
import { getState, subscribe } from '../../state.js';
import { colors, fonts } from '../../styles/theme-tokens.js';

import type { FlowGraph, FlowGraphNode, FlowMode, NodeKind } from './flow-graph-data.js';
import { ALL_FLOW_TYPES, ALL_MODES, buildFlowGraph } from './flow-graph-data.js';
import {
  computeGraphLayout,
  DECISION_SIZE,
  EXECUTOR_COLORS,
  getNeighborhood,
  type GraphLayout,
  LANE_COLORS,
  LANE_LABEL_W,
  type LaneMode,
  type LayoutEdge,
  type LayoutNode,
  PAD_X,
} from './flow-graph-layout.js';
import { flowGraphStyles } from './flow-graph-styles.js';

const FLOW_TYPE_LABELS: Record<string, string> = {
  'fix-bug': 'Fix Bug',
  dev: 'Dev',
  'review-pr': 'Review PR',
  'pr-complete': 'PR Complete',
  'update-branch': 'Update Branch',
};

// ─── Component ───

@customElement('flow-graph')
export class FlowGraphComponent extends LitElement {
  @property({ type: String }) flowType: FlowType = 'fix-bug';
  @property({ type: String }) mode: FlowMode = 'interactive';
  @property({ type: Boolean }) showSelector = false;
  @property({ type: String }) laneMode: LaneMode = 'phase';
  @property({ type: String }) project = '';

  @state() private _selectedNodeId: string | null = null;
  @state() private _project = '';
  @state() private _projects: string[] = [];
  @state() private _globalProjectFilter: string[] = [];
  @state() private _templateCache = new Map<string, TemplatePreview>();
  @state() private _templateLoading = false;

  private _unsubConnection?: () => void;
  private _unsubState?: () => void;

  connectedCallback() {
    super.connectedCallback();
    this._globalProjectFilter = getState().globalFilters.projects;
    this.discoverProjects();
    this._unsubConnection = gateway.onConnectionChange((state) => {
      if (state === 'connected' && this._projects.length === 0) {
        this.discoverProjects();
      }
    });
    // Sync project selection and visible list with global filter changes
    this._unsubState = subscribe((s) => {
      this._globalProjectFilter = s.globalFilters.projects;
      const gf = s.globalFilters.projects;
      if (gf.length === 1 && this._projects.includes(gf[0]) && this._project !== gf[0]) {
        this._project = gf[0];
        this.fetchTemplates();
      }
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubConnection?.();
    this._unsubState?.();
  }

  override updated(changed: Map<string, unknown>) {
    // Sync external project prop → internal _project
    if (changed.has('project') && this.project && this.project !== this._project) {
      this._project = this.project;
      this.fetchTemplates();
    }
    // Dispatch state-change for user interactions (skip initial render where old value = undefined)
    if (
      (changed.has('flowType') && changed.get('flowType') !== undefined) ||
      (changed.has('mode') && changed.get('mode') !== undefined) ||
      (changed.has('laneMode') && changed.get('laneMode') !== undefined)
    ) {
      this._dispatchStateChange();
    }
  }

  private _dispatchStateChange() {
    this.dispatchEvent(
      new CustomEvent('fg-state-change', {
        detail: {
          flowType: this.flowType,
          mode: this.mode,
          laneMode: this.laneMode,
          project: this._project,
        },
        bubbles: false,
      }),
    );
  }

  private async discoverProjects() {
    try {
      const result = (await gateway.request(Methods.CONFIG_PROJECTS, {})) as {
        projects: Array<{ name: string }>;
      };
      this._projects = result.projects.map((p) => p.name);
      if (this._projects.length > 0 && !this._project) {
        // Prefer global filter selection, fall back to first project
        const gf = getState().globalFilters.projects;
        this._project =
          gf.length === 1 && this._projects.includes(gf[0])
            ? gf[0]
            : this.project && this._projects.includes(this.project)
              ? this.project
              : this._projects[0];
        this.fetchTemplates();
      }
    } catch {
      /* gateway not available — template panel just won't show */
    }
  }

  private async fetchTemplates() {
    if (!this._project) return;
    const cacheKey = this._project;
    if (this._templateCache.has(`${cacheKey}:${this.flowType}`)) return;
    this._templateLoading = true;
    try {
      const result = (await gateway.request(Methods.CONFIG_TEMPLATES, {
        project: this._project,
      })) as ConfigTemplatesResult;
      for (const t of result.templates) {
        this._templateCache.set(`${cacheKey}:${t.flowType}`, t);
        // Also cache by fileName for self-review template lookups
        this._templateCache.set(`${cacheKey}:file:${t.fileName}`, t);
      }
      this._templateCache = new Map(this._templateCache); // trigger reactive update
    } catch {
      /* ignore */
    }
    this._templateLoading = false;
  }

  private templateForNode(node: FlowGraphNode): TemplatePreview | undefined {
    if (!this._project) return undefined;
    // If the node specifies a template file, look it up by fileName
    if (node.templateFile) {
      return this._templateCache.get(`${this._project}:file:${node.templateFile}`);
    }
    // Default: the flow's main worker template
    return this._templateCache.get(`${this._project}:${this.flowType}`);
  }

  static styles = flowGraphStyles;

  render() {
    const graph = buildFlowGraph(this.flowType, this.mode);
    const layout = computeGraphLayout(graph, this.laneMode);
    const selectedNode = this._selectedNodeId
      ? graph.nodes.find((n) => n.id === this._selectedNodeId)
      : null;

    return html`
      <div class="fg-container">
        ${this.showSelector ? this.renderSelector() : nothing}
        ${this.showSelector ? this.renderLegend() : nothing}
        <div class="fg-svg-wrap">
          <svg
            class="fg-svg"
            viewBox="0 0 ${layout.width} ${layout.height}"
            preserveAspectRatio="xMidYMid meet"
          >
            ${this.renderDefs()} ${this.renderLanes(layout)}
            ${layout.edges.map((e) => this.renderEdge(e, this._selectedNodeId))}
            ${layout.nodes.map((n) => this.renderLayoutNode(n))}
          </svg>
        </div>
        ${selectedNode ? this.renderDetailPanel(selectedNode, graph) : nothing}
      </div>
    `;
  }

  private renderSelector() {
    return html`
      <div class="fg-selector">
        <div class="fg-pill-group">
          <span class="fg-pill-label">Flow</span>
          ${ALL_FLOW_TYPES.map(
            (ft) => html`
              <button
                class="fg-pill ${this.flowType === ft ? 'active' : ''}"
                @click=${() => {
                  this.flowType = ft;
                  this._selectedNodeId = null;
                  this.fetchTemplates();
                }}
              >
                ${ft}
              </button>
            `,
          )}
        </div>
        <div class="fg-pill-group">
          <span class="fg-pill-label">Mode</span>
          ${ALL_MODES.map(
            (m) => html`
              <button
                class="fg-pill ${this.mode === m ? 'active' : ''}"
                @click=${() => {
                  this.mode = m;
                  this._selectedNodeId = null;
                }}
              >
                ${m}
              </button>
            `,
          )}
        </div>
        <div class="fg-pill-group">
          <span class="fg-pill-label">Lanes</span>
          ${(['phase', 'executor'] as LaneMode[]).map(
            (lm) => html`
              <button
                class="fg-pill ${this.laneMode === lm ? 'active' : ''}"
                @click=${() => {
                  this.laneMode = lm;
                  this._selectedNodeId = null;
                }}
              >
                ${lm}
              </button>
            `,
          )}
        </div>
        ${this._projects.length > 0
          ? html`
              <div class="fg-pill-group">
                <span class="fg-pill-label">Project</span>
                ${(this._globalProjectFilter.length > 0
                  ? this._projects.filter((p) => this._globalProjectFilter.includes(p))
                  : this._projects
                ).map(
                  (p) => html`
                    <button
                      class="fg-pill ${this._project === p ? 'active' : ''}"
                      @click=${() => {
                        this._project = p;
                        this.fetchTemplates();
                        this._dispatchStateChange();
                      }}
                    >
                      ${p}
                    </button>
                  `,
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private renderLegend() {
    return html`
      <div class="fg-legend">
        <span class="fg-legend-item"
          ><span class="fg-legend-dot" style="background: ${EXECUTOR_COLORS.gateway}"></span>
          Gateway</span
        >
        <span class="fg-legend-item"
          ><span class="fg-legend-dot" style="background: ${EXECUTOR_COLORS.worker}"></span>
          Worker</span
        >
        <span class="fg-legend-item"
          ><span class="fg-legend-dot" style="background: ${EXECUTOR_COLORS.reviewer}"></span>
          Reviewer</span
        >
        <span class="fg-legend-item"
          ><span class="fg-legend-dot" style="background: ${EXECUTOR_COLORS.human}"></span>
          Human</span
        >
      </div>
    `;
  }

  private renderDefs() {
    return svg`
      <defs>
        <marker id="fg-ah-normal" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="${colors.textMuted}88"/>
        </marker>
        <marker id="fg-ah-cond" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="${colors.statusWarn}88"/>
        </marker>
        <marker id="fg-ah-loop" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#3b82f688"/>
        </marker>
      </defs>
    `;
  }

  private renderLanes(layout: GraphLayout) {
    return svg`
      ${layout.lanes.map(
        (lane) => svg`
        <text x="8" y="${lane.labelY}"
              dominant-baseline="central"
              fill="${lane.color}66" class="lane-label">
          ${lane.label}
        </text>
      `,
      )}
      ${layout.laneSepYs.map(
        (y) => svg`
        <line x1="${LANE_LABEL_W}" x2="${layout.width - PAD_X}"
              y1="${y}" y2="${y}"
              stroke="${colors.bgCard}" class="lane-sep"/>
      `,
      )}
    `;
  }

  private renderEdge(le: LayoutEdge, selectedId: string | null) {
    const { edge, d } = le;
    const isConditional = edge.style === 'conditional';
    const isLoop = edge.style === 'loop';
    const isConnected = selectedId != null && (edge.from === selectedId || edge.to === selectedId);
    const isDimmed = selectedId != null && !isConnected;

    const baseColor = isConditional ? colors.statusWarn : isLoop ? '#3b82f6' : colors.textMuted;
    const strokeColor = isConnected
      ? `${baseColor}ee`
      : isDimmed
        ? `${baseColor}18`
        : `${baseColor}${isConditional || isLoop ? '66' : '55'}`;
    const strokeWidth = isConnected ? 2.5 : 1.5;
    const dashArray = isConditional ? '6 3' : isLoop ? '4 3' : 'none';
    const marker = isConditional ? 'fg-ah-cond' : isLoop ? 'fg-ah-loop' : 'fg-ah-normal';

    // Compute label position (midpoint of path, roughly)
    let labelSvg: typeof nothing | ReturnType<typeof svg> = nothing;
    if (edge.label) {
      // Parse start/end from path for rough midpoint
      const parts = d
        .split(/[MLCQ\s,]+/)
        .filter(Boolean)
        .map(Number);
      if (parts.length >= 4) {
        const mx = (parts[0] + parts[parts.length - 2]) / 2;
        const my = (parts[1] + parts[parts.length - 1]) / 2 - 6;
        const labelColor = isDimmed
          ? `${baseColor}30`
          : isConnected
            ? `${baseColor}ff`
            : `${baseColor}${isConditional || isLoop ? 'cc' : 'aa'}`;
        labelSvg = svg`
          <text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="auto"
                fill="${labelColor}" class="fg-edge-label"
                font-weight="${isConnected ? '700' : '400'}">
            ${edge.label}
          </text>
        `;
      }
    }

    return svg`
      <path d="${d}" class="fg-edge"
            stroke="${strokeColor}"
            stroke-width="${strokeWidth}"
            stroke-dasharray="${dashArray}"
            marker-end="url(#${marker})"/>
      ${labelSvg}
    `;
  }

  private renderLayoutNode(ln: LayoutNode) {
    const { node } = ln;
    const isSelected = this._selectedNodeId === node.id;

    switch (node.kind) {
      case 'decision':
        return this.renderDecisionNode(ln, isSelected);
      case 'terminal':
        return this.renderTerminalNode(ln, isSelected);
      case 'chain':
        return this.renderChainNode(ln, isSelected);
      default:
        return this.renderStepNode(ln, isSelected);
    }
  }

  private nodeLabel(node: FlowGraphNode): string {
    if (this.laneMode === 'executor' && node.id === 'monitor') {
      return FLOW_TYPE_LABELS[this.flowType] ?? this.flowType;
    }
    return node.label;
  }

  private renderStepNode(ln: LayoutNode, isSelected: boolean) {
    const { node } = ln;
    const laneColor = LANE_COLORS[node.lane];
    const opacity = node.skipped ? 0.25 : 1;
    const fillColor = isSelected ? `${laneColor}20` : `${laneColor}0a`;
    const strokeColor = isSelected
      ? laneColor
      : node.skipped
        ? `${colors.textMuted}33`
        : `${laneColor}44`;
    const label = this.nodeLabel(node);

    return svg`
      <g class="fg-node" transform="translate(${ln.x}, ${ln.y})"
         style="opacity: ${opacity}"
         @click=${() => this.selectNode(node.id)}>
        <rect width="${ln.w}" height="${ln.h}" rx="6"
              fill="${fillColor}" stroke="${strokeColor}" stroke-width="${isSelected ? 2 : 1}"/>
        <text class="fg-node-label" x="${ln.w / 2}" y="${node.annotation ? 12 : ln.h / 2}"
              text-anchor="middle" dominant-baseline="central"
              fill="${node.skipped ? colors.textMuted : colors.textPrimary}">
          ${label}
        </text>
        ${
          node.annotation
            ? svg`
          <text class="fg-node-annotation" x="${ln.w / 2}" y="26"
                text-anchor="middle" dominant-baseline="central"
                fill="${node.skipped ? `${colors.statusWarn}88` : colors.statusWarn}">
            ${node.annotation}
          </text>
        `
            : nothing
        }
        ${
          node.executor
            ? svg`
          <circle cx="${ln.w - 7}" cy="7" r="4"
                  fill="${EXECUTOR_COLORS[node.executor]}" opacity="${node.skipped ? 0.4 : 0.9}"/>
        `
            : nothing
        }
      </g>
    `;
  }

  private renderDecisionNode(ln: LayoutNode, isSelected: boolean) {
    const { node } = ln;
    const cx = ln.w / 2;
    const cy = ln.h / 2;
    const s = DECISION_SIZE;
    const fillColor = isSelected ? `${colors.statusWarn}25` : `${colors.statusWarn}10`;
    const strokeColor = isSelected ? colors.statusWarn : `${colors.statusWarn}66`;

    return svg`
      <g class="fg-node" transform="translate(${ln.x}, ${ln.y})"
         @click=${() => this.selectNode(node.id)}>
        <polygon points="${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}"
                 fill="${fillColor}" stroke="${strokeColor}" stroke-width="${isSelected ? 2 : 1.5}"/>
        <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
              fill="${colors.statusWarn}" font-size="8" font-weight="600">
          ?
        </text>
        <text x="${cx}" y="${cy + s + 10}" text-anchor="middle" dominant-baseline="central"
              fill="${colors.textMuted}" font-size="7">
          ${node.label}
        </text>
        ${
          node.annotation
            ? svg`
          <text x="${cx}" y="${cy + s + 20}" text-anchor="middle" dominant-baseline="central"
                fill="${colors.statusWarn}88" font-size="7">
            ${node.annotation}
          </text>
        `
            : nothing
        }
        ${
          node.executor
            ? svg`
          <circle cx="${cx + s + 2}" cy="${cy - s + 2}" r="3.5"
                  fill="${EXECUTOR_COLORS[node.executor]}" opacity="0.9"/>
        `
            : nothing
        }
      </g>
    `;
  }

  private renderTerminalNode(ln: LayoutNode, isSelected: boolean) {
    const { node } = ln;
    const fillColor = isSelected ? `${colors.statusOk}20` : `${colors.statusOk}08`;
    const strokeColor = isSelected ? colors.statusOk : `${colors.statusOk}44`;

    return svg`
      <g class="fg-node" transform="translate(${ln.x}, ${ln.y})"
         @click=${() => this.selectNode(node.id)}>
        <!-- Double border for terminal -->
        <rect width="${ln.w}" height="${ln.h}" rx="6"
              fill="${fillColor}" stroke="${strokeColor}" stroke-width="${isSelected ? 2 : 1}"/>
        <rect x="3" y="3" width="${ln.w - 6}" height="${ln.h - 6}" rx="4"
              fill="none" stroke="${strokeColor}" stroke-width="1"/>
        <text class="fg-node-label" x="${ln.w / 2}" y="${ln.h / 2}"
              text-anchor="middle" dominant-baseline="central"
              fill="${colors.statusOk}">
          ${node.label}
        </text>
      </g>
    `;
  }

  private renderChainNode(ln: LayoutNode, isSelected: boolean) {
    const { node } = ln;
    const fillColor = isSelected ? `${colors.accent}20` : `${colors.accent}08`;
    const strokeColor = isSelected ? colors.accent : `${colors.accent}44`;

    return svg`
      <g class="fg-node" transform="translate(${ln.x}, ${ln.y})"
         @click=${() => this.handleChainClick(node)}>
        <rect width="${ln.w}" height="${ln.h}" rx="6"
              fill="${fillColor}" stroke="${strokeColor}"
              stroke-width="${isSelected ? 2 : 1}" stroke-dasharray="6 3"/>
        <text class="fg-node-label" x="${ln.w / 2}" y="13"
              text-anchor="middle" dominant-baseline="central"
              fill="${colors.accent}">
          ${node.label}
        </text>
        <text x="${ln.w / 2}" y="26" text-anchor="middle" dominant-baseline="central"
              fill="${colors.textMuted}" font-size="8">
          chain ->
        </text>
        ${
          node.executor
            ? svg`
          <circle cx="${ln.w - 7}" cy="7" r="4"
                  fill="${EXECUTOR_COLORS[node.executor]}" opacity="0.9"/>
        `
            : nothing
        }
      </g>
    `;
  }

  private renderNeighborhoodGraph(node: FlowGraphNode, graph: FlowGraph) {
    const nb = getNeighborhood(graph, node.id);
    const hasPreds = nb.preds.length > 0;
    const hasSuccs = nb.succs.length > 0;
    if (!hasPreds && !hasSuccs) return nothing;

    // Layout constants for the mini-graph
    const NW = 90,
      NH = 28,
      COL_GAP_NB = 50,
      PAD_NB = 8;
    const numCols = (hasPreds ? 1 : 0) + 1 + (hasSuccs ? 1 : 0);
    const rows = Math.max(nb.preds.length, 1, nb.succs.length);
    const svgH = rows * 38 + 24;
    const svgW = numCols * NW + (numCols - 1) * COL_GAP_NB + PAD_NB * 2;

    // Column x positions
    const predColX = PAD_NB;
    const centerColX = hasPreds ? PAD_NB + NW + COL_GAP_NB : PAD_NB;
    const succColX = centerColX + NW + COL_GAP_NB;

    const centerY = svgH / 2 - NH / 2;

    const nodeBox = (n: FlowGraphNode, x: number, y: number, isCenter: boolean) => {
      const isDecision = n.kind === 'decision';
      const isTerminal = n.kind === 'terminal';
      const isChain = n.kind === 'chain';
      const col = isDecision
        ? colors.statusWarn
        : isTerminal
          ? colors.statusOk
          : isChain
            ? colors.accent
            : LANE_COLORS[n.lane];
      const fill = isCenter ? `${col}20` : `${col}0a`;
      const stroke = isCenter ? col : `${col}55`;
      const sw = isCenter ? 2 : 1;
      const dashArray = isDecision ? '4 2' : isChain ? '6 3' : 'none';
      const textColor = isDecision
        ? colors.statusWarn
        : isTerminal
          ? colors.statusOk
          : isChain
            ? colors.accent
            : colors.textPrimary;
      return svg`
        <g class="fg-node" transform="translate(${x}, ${y})"
           @click=${() => this.selectNode(n.id)}>
          <rect width="${NW}" height="${NH}" rx="4"
                fill="${fill}" stroke="${stroke}" stroke-width="${sw}"
                stroke-dasharray="${dashArray}"/>
          ${
            isTerminal
              ? svg`
            <rect x="2" y="2" width="${NW - 4}" height="${NH - 4}" rx="3"
                  fill="none" stroke="${col}55" stroke-width="1"/>
          `
              : nothing
          }
          ${
            isDecision
              ? svg`
            <text x="8" y="${NH / 2}" text-anchor="middle" dominant-baseline="central"
                  fill="${col}" font-size="10" font-weight="700" font-family="${fonts.mono}">?</text>
          `
              : nothing
          }
          ${
            n.executor
              ? svg`
            <circle cx="${NW - 6}" cy="6" r="3.5"
                    fill="${EXECUTOR_COLORS[n.executor]}" opacity="0.9"/>
          `
              : nothing
          }
          <text x="${isDecision ? NW / 2 + 6 : NW / 2}" y="${NH / 2}"
                text-anchor="middle" dominant-baseline="central"
                fill="${textColor}" font-size="9" font-weight="${isCenter ? '700' : '500'}"
                font-family="${fonts.mono}">
            ${this.nodeLabel(n)}
          </text>
        </g>
      `;
    };

    const arrow = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      label: string | undefined,
    ) => svg`
      <line x1="${x1}" y1="${y1}" x2="${x2 - 6}" y2="${y2}"
            stroke="${colors.textMuted}66" stroke-width="1.5"
            marker-end="url(#fg-ah-normal)"/>
      ${
        label
          ? svg`
        <text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}"
              text-anchor="middle" fill="${colors.textMuted}aa"
              font-size="7" font-family="${fonts.mono}">${label}</text>
      `
          : nothing
      }
    `;

    return html`
      <div class="fg-neighborhood">
        <svg width="${svgW}" height="${svgH}" style="display:block">
          <!-- Center node -->
          ${nodeBox(node, centerColX, centerY, true)}
          <!-- Predecessor nodes + arrows -->
          ${nb.preds.map((pred, i) => {
            const py = i * 38 + (svgH - nb.preds.length * 38) / 2;
            const edgeLabel = nb.edges.find((e) => e.from === pred.id && e.to === node.id)?.label;
            return svg`
              ${nodeBox(pred, predColX, py, false)}
              ${arrow(predColX + NW, py + NH / 2, centerColX, centerY + NH / 2, edgeLabel)}
            `;
          })}
          <!-- Successor nodes + arrows -->
          ${nb.succs.map((succ, i) => {
            const sy = i * 38 + (svgH - nb.succs.length * 38) / 2;
            const edgeLabel = nb.edges.find((e) => e.from === node.id && e.to === succ.id)?.label;
            return svg`
              ${nodeBox(succ, succColX, sy, false)}
              ${arrow(centerColX + NW, centerY + NH / 2, succColX, sy + NH / 2, edgeLabel)}
            `;
          })}
        </svg>
      </div>
    `;
  }

  private renderDetailPanel(node: FlowGraphNode, graph: FlowGraph) {
    const kindColors: Record<NodeKind, string> = {
      step: colors.accent,
      decision: colors.statusWarn,
      terminal: colors.statusOk,
      chain: colors.accent,
    };
    const kindColor = kindColors[node.kind];

    // Show worker template steps when a worker-lane step is selected and template is available
    const tmpl =
      node.lane === 'worker' && node.kind === 'step' ? this.templateForNode(node) : undefined;
    const showTemplate = !!tmpl;

    return html`
      <div class="fg-detail">
        ${this.renderNeighborhoodGraph(node, graph)}
        <div class="fg-detail-title">
          ${this.nodeLabel(node)}
          <span class="fg-detail-kind" style="background: ${kindColor}22; color: ${kindColor}">
            ${node.kind}
          </span>
          <span
            class="fg-detail-kind"
            style="background: ${LANE_COLORS[node.lane]}22; color: ${LANE_COLORS[node.lane]}"
          >
            ${node.lane}
          </span>
          ${node.executor
            ? html`
                <span
                  class="fg-detail-kind"
                  style="background: ${EXECUTOR_COLORS[node.executor]}22; color: ${EXECUTOR_COLORS[
                    node.executor
                  ]}"
                >
                  ${node.executor}
                </span>
              `
            : nothing}
          ${node.skipped
            ? html`
                <span
                  class="fg-detail-kind"
                  style="background: ${colors.textMuted}22; color: ${colors.textMuted}"
                >
                  skipped
                </span>
              `
            : nothing}
          ${showTemplate
            ? html`
                <span
                  class="fg-detail-kind"
                  style="background: ${colors.accent}22; color: ${colors.accent}"
                >
                  ${tmpl.fileName}
                </span>
              `
            : nothing}
        </div>
        ${node.description
          ? html` <div class="fg-detail-desc">${node.description}</div> `
          : nothing}
        ${node.annotation
          ? html` <div class="fg-detail-annotation">${node.annotation}</div> `
          : nothing}
        ${showTemplate
          ? html`
              <div
                style="margin-top: 8px; padding-top: 8px; border-top: 1px solid ${colors.bgSurface}"
              >
                <template-schema
                  .schema=${tmpl.schema}
                  .placeholders=${tmpl.placeholders}
                ></template-schema>
              </div>
            `
          : nothing}
        ${this._templateLoading && node.lane === 'worker'
          ? html` <div class="fg-detail-desc" style="margin-top: 4px">Loading template...</div> `
          : nothing}
      </div>
    `;
  }

  private selectNode(id: string) {
    this._selectedNodeId = this._selectedNodeId === id ? null : id;
  }

  private handleChainClick(node: FlowGraphNode) {
    // Switch view to the chained flow type
    const chainFlows: Record<string, FlowType> = {
      'update-branch': 'update-branch',
      'pr-complete': 'pr-complete',
    };
    const target = chainFlows[node.label];
    if (target) {
      this.flowType = target;
      this._selectedNodeId = null;
    } else {
      this.selectNode(node.id);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'flow-graph': FlowGraphComponent;
  }
}
