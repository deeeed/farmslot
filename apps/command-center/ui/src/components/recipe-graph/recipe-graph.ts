// recipe-graph.ts — SVG recipe workflow visualization component.
// Renders validate.workflow recipe DAGs with action labels, save_as badges,
// and pass/fail terminal coloring. Single-lane layout (all nodes: worker).

import {
  css,
  html,
  LitElement,
  nothing,
  type PropertyValues,
  svg,
  type SVGTemplateResult,
  unsafeCSS,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { colors, fonts, spacing } from '../../styles/theme-tokens.js';
import type { FlowGraph, FlowGraphEdge, FlowGraphNode } from '../flow-graph/flow-graph-data.js';

import { recipeToFlowGraph } from './recipe-graph-data.js';

// ─── Layout constants ───

const NODE_W = 124;
const NODE_H = 42;
const DECISION_SIZE = 18;
const COL_GAP = 56;
const ROW_GAP = 64;
const PAD_X = 20;
const PAD_Y = 20;
const MAX_COLS = 6;

// ─── Color palette ───

const C_STEP = '#3b82f6'; // blue — step nodes
const C_DECISION = colors.statusWarn; // yellow — switch diamond
const C_PASS = colors.statusOk; // green — end:pass
const C_FAIL = colors.statusFail; // red — end:fail
const C_ENTRY = colors.accent; // indigo — ENTRY marker

// ─── Layout types ───

interface LayoutNode {
  id: string;
  node: FlowGraphNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LayoutEdge {
  edge: FlowGraphEdge;
  d: string;
}

interface LaneRender {
  label: string;
  color: string;
  labelY: number;
  top: number;
  bottom: number;
}

interface GraphLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  lanes: LaneRender[];
  laneSepYs: number[];
}

// ─── Layout engine ───

function edgePath(src: LayoutNode, tgt: LayoutNode, edge: FlowGraphEdge): string {
  const sx = src.x + src.w / 2;
  const sy = src.y + src.h / 2;
  const tx = tgt.x + tgt.w / 2;
  const ty = tgt.y + tgt.h / 2;

  if (edge.style === 'loop') {
    const arcY = Math.min(src.y, tgt.y) - 36;
    return `M ${src.x + src.w} ${sy} C ${src.x + src.w + 36} ${arcY}, ${tgt.x - 36} ${arcY}, ${tgt.x} ${ty}`;
  }

  // Same row — horizontal line
  if (Math.abs(sy - ty) < 8) {
    return `M ${src.x + src.w} ${sy} L ${tgt.x} ${ty}`;
  }

  // Cross-row — bezier
  const midY = (src.y + src.h + tgt.y) / 2;
  return `M ${sx} ${src.y + src.h} C ${sx} ${midY}, ${tx} ${midY}, ${tx} ${tgt.y}`;
}

function computeLayout(graph: FlowGraph): GraphLayout {
  const laneOrder: Array<'orch' | 'worker' | 'post'> = ['orch', 'worker', 'post'];
  const laneColors = { orch: colors.accent, worker: C_STEP, post: C_PASS };
  const laneLabels = { orch: 'SETUP', worker: 'VALIDATE', post: 'TEARDOWN' };
  const laneNodes: Record<string, FlowGraphNode[]> = { orch: [], worker: [], post: [] };
  for (const node of graph.nodes) laneNodes[node.lane].push(node);
  const usedLanes = laneOrder.filter((lane) => laneNodes[lane].length > 0);

  const laneStartY: Record<string, number> = {
    orch: PAD_Y + 20,
    worker: PAD_Y + 20,
    post: PAD_Y + 20,
  };
  let currentY = PAD_Y + 20;
  for (const lane of usedLanes) {
    laneStartY[lane] = currentY;
    const rows = Math.max(1, Math.ceil(laneNodes[lane].length / MAX_COLS));
    currentY += rows * (NODE_H + ROW_GAP);
  }

  const layoutNodes: LayoutNode[] = [];
  const nodeMap = new Map<string, LayoutNode>();
  for (const lane of usedLanes) {
    let col = 0;
    let row = 0;
    for (const node of laneNodes[lane]) {
      const isDecision = node.kind === 'decision';
      const w = isDecision ? DECISION_SIZE * 2 + 12 : NODE_W;
      const h = isDecision ? DECISION_SIZE * 2 + 12 : NODE_H;
      const x = PAD_X + 56 + col * (NODE_W + COL_GAP) + (isDecision ? (NODE_W - w) / 2 : 0);
      const y = laneStartY[lane] + row * (NODE_H + ROW_GAP) + (isDecision ? (NODE_H - h) / 2 : 0);
      const ln: LayoutNode = { id: node.id, node, x, y, w, h };
      layoutNodes.push(ln);
      nodeMap.set(node.id, ln);
      col++;
      if (col >= MAX_COLS) {
        col = 0;
        row++;
      }
    }
  }

  const layoutEdges: LayoutEdge[] = graph.edges
    .map((edge) => {
      const src = nodeMap.get(edge.from);
      const tgt = nodeMap.get(edge.to);
      if (!src || !tgt) return null;
      return { edge, d: edgePath(src, tgt, edge) };
    })
    .filter((e): e is LayoutEdge => e !== null);

  let maxX = 0,
    maxY = 0;
  for (const ln of layoutNodes) {
    maxX = Math.max(maxX, ln.x + ln.w);
    maxY = Math.max(maxY, ln.y + ln.h);
  }

  const lanes: LaneRender[] = usedLanes.map((lane) => {
    const nodesInLane = layoutNodes.filter((ln) => ln.node.lane === lane);
    const firstNode = nodesInLane[0];
    const top = Math.min(...nodesInLane.map((ln) => ln.y)) - 14;
    const bottom = Math.max(...nodesInLane.map((ln) => ln.y + ln.h)) + 14;
    return {
      label: laneLabels[lane],
      color: laneColors[lane],
      labelY: firstNode ? firstNode.y + firstNode.h / 2 : 0,
      top,
      bottom,
    };
  });

  const laneSepYs: number[] = [];
  for (let i = 0; i < lanes.length - 1; i++) {
    laneSepYs.push((lanes[i].bottom + lanes[i + 1].top) / 2);
  }

  return {
    nodes: layoutNodes,
    edges: layoutEdges,
    width: maxX + PAD_X * 2 + 40,
    height: maxY + PAD_Y * 2 + 10,
    lanes,
    laneSepYs,
  };
}

function terminalColor(node: FlowGraphNode): string {
  if (node.annotation === 'PASS') return C_PASS;
  if (node.annotation === 'FAIL') return C_FAIL;
  if (node.annotation === 'ENTRY') return C_ENTRY;
  return C_PASS;
}

// ─── Component ───

@customElement('recipe-graph')
export class RecipeGraph extends LitElement {
  /** Raw recipe — JSON string or parsed object */
  @property({ attribute: false }) recipe: unknown = null;
  @property() selectedId: string | null = null;

  @state() private _selectedId: string | null = null;

  private _graph: FlowGraph | null = null;
  private _layout: GraphLayout | null = null;

  override willUpdate(changed: PropertyValues) {
    if (changed.has('recipe')) {
      this._graph = this.recipe ? recipeToFlowGraph(this.recipe) : null;
      this._layout = this._graph ? computeLayout(this._graph) : null;
    }
    if (changed.has('selectedId')) {
      this._selectedId = this.selectedId;
    }
  }

  static styles = css`
    :host {
      display: block;
      height: 100%;
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .rg-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .rg-svg-wrap {
      flex: 1 1 auto;
      overflow: auto;
      min-height: 120px;
    }
    .rg-svg {
      display: block;
    }
    .rg-node {
      cursor: pointer;
    }
    .rg-node:hover rect,
    .rg-node:hover polygon {
      filter: brightness(1.2);
    }
    .rg-label {
      font-size: 10px;
      font-weight: 600;
    }
    .rg-ann {
      font-size: 7.5px;
      font-weight: 500;
    }
    .rg-badge-txt {
      font-size: 7px;
      font-weight: 700;
    }
    .rg-edge {
      fill: none;
      stroke-width: 1.5;
    }
    .rg-edge-lbl {
      font-size: 8px;
    }
    .lane-label {
      font-size: 10px;
      font-weight: 700;
      opacity: 0.7;
    }
    .lane-sep {
      stroke-dasharray: 4 4;
    }
    .rg-detail {
      background: ${unsafeCSS(colors.bgCard)};
      border-radius: 6px;
      padding: ${unsafeCSS(spacing.md)};
      margin: 0 ${unsafeCSS(spacing.md)} ${unsafeCSS(spacing.md)};
      flex: 0 0 auto;
      overflow-y: auto;
      max-height: 100px;
    }
    .rg-detail-title {
      font-size: 11px;
      font-weight: 700;
      color: ${unsafeCSS(colors.textPrimary)};
      margin-bottom: 4px;
    }
    .rg-detail-desc {
      font-size: 10px;
      color: ${unsafeCSS(colors.textSecondary)};
      line-height: 1.5;
    }
    .rg-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: ${unsafeCSS(colors.textMuted)};
      font-size: 12px;
    }
  `;

  render() {
    if (!this._graph || !this._layout) return html`<div class="rg-empty">No recipe</div>`;
    const graph = this._graph;
    const layout = this._layout;
    const sel = this._selectedId ? graph.nodes.find((n) => n.id === this._selectedId) : null;

    return html`
      <div class="rg-container">
        <div class="rg-svg-wrap">
          <svg
            class="rg-svg"
            width="${layout.width}"
            height="${layout.height}"
            viewBox="0 0 ${layout.width} ${layout.height}"
          >
            ${this._defs()}
            ${layout.lanes.map(
              (lane) => svg`
              <rect
                x="42"
                y="${lane.top}"
                width="${layout.width - 54}"
                height="${Math.max(32, lane.bottom - lane.top)}"
                rx="10"
                fill="${lane.color}0d"
                stroke="${lane.color}1f"
              />
            `,
            )}
            ${layout.lanes.map(
              (lane) =>
                svg`<text x="8" y="${lane.labelY}" dominant-baseline="middle" fill="${lane.color}88" class="lane-label">${lane.label}</text>`,
            )}
            ${layout.laneSepYs.map(
              (y) =>
                svg`<line x1="0" y1="${y}" x2="${layout.width}" y2="${y}" stroke="${colors.bgCard}" class="lane-sep"/>`,
            )}
            ${layout.edges.map((e) => this._edge(e))} ${layout.nodes.map((n) => this._node(n))}
          </svg>
        </div>
        ${sel ? this._detail(sel) : nothing}
      </div>
    `;
  }

  private _defs() {
    return svg`
      <defs>
        <marker id="rg-n" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="${colors.textMuted}88"/>
        </marker>
        <marker id="rg-c" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="${colors.statusWarn}88"/>
        </marker>
        <marker id="rg-l" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#3b82f688"/>
        </marker>
      </defs>
    `;
  }

  private _edge(le: LayoutEdge) {
    const { edge, d } = le;
    const isCond = edge.style === 'conditional';
    const isLoop = edge.style === 'loop';
    const isConn =
      this._selectedId != null && (edge.from === this._selectedId || edge.to === this._selectedId);
    const isDim = this._selectedId != null && !isConn;

    const base = isCond ? colors.statusWarn : isLoop ? '#3b82f6' : colors.textMuted;
    const alpha = isCond || isLoop ? '66' : '55';
    const stroke = isConn ? `${base}ee` : isDim ? `${base}18` : `${base}${alpha}`;
    const sw = isConn ? 2.5 : 1.5;
    const dash = isCond ? '6 3' : isLoop ? '4 3' : 'none';
    const marker = isCond ? 'rg-c' : isLoop ? 'rg-l' : 'rg-n';

    let lbl: SVGTemplateResult | typeof nothing = nothing;
    if (edge.label) {
      const parts = d
        .split(/[MLCQ\s,]+/)
        .filter(Boolean)
        .map(Number);
      if (parts.length >= 4) {
        const mx = (parts[0] + parts[parts.length - 2]) / 2;
        const my = (parts[1] + parts[parts.length - 1]) / 2 - 6;
        const lc = isDim ? `${base}30` : `${base}cc`;
        lbl = svg`<text x="${mx}" y="${my}" text-anchor="middle"
                        fill="${lc}" class="rg-edge-lbl">${edge.label}</text>`;
      }
    }

    return svg`
      <path d="${d}" class="rg-edge"
            stroke="${stroke}" stroke-width="${sw}"
            stroke-dasharray="${dash}"
            marker-end="url(#${marker})"/>
      ${lbl}
    `;
  }

  private _node(ln: LayoutNode) {
    switch (ln.node.kind) {
      case 'decision':
        return this._decision(ln);
      case 'terminal':
        return this._terminal(ln);
      default:
        return this._step(ln);
    }
  }

  private _step(ln: LayoutNode) {
    const { node } = ln;
    const isSel = this._selectedId === node.id;
    const fill = isSel ? `${C_STEP}20` : `${C_STEP}0a`;
    const stroke = isSel ? C_STEP : `${C_STEP}44`;

    // Parse annotation: "action" or "action → save_as"
    const ann = node.annotation || '';
    const arrowIdx = ann.indexOf(' → ');
    const actionLbl = arrowIdx >= 0 ? ann.slice(0, arrowIdx) : ann;
    const saveAs = arrowIdx >= 0 ? ann.slice(arrowIdx + 3) : '';
    const mainY = actionLbl ? 13 : ln.h / 2;

    return svg`
      <g class="rg-node" transform="translate(${ln.x},${ln.y})"
         data-testid=${`recipe-graph-node-${node.id.replace(/[^a-zA-Z0-9_-]+/g, '-')}`}
         @click=${() => this._select(node.id)}>
        <rect width="${ln.w}" height="${ln.h}" rx="5"
              fill="${fill}" stroke="${stroke}" stroke-width="${isSel ? 2 : 1}"/>
        <text class="rg-label" x="${ln.w / 2}" y="${mainY}"
              text-anchor="middle" dominant-baseline="central"
              fill="${colors.textPrimary}">${node.label}</text>
        ${
          actionLbl
            ? svg`
          <text class="rg-ann" x="${ln.w / 2}" y="29"
                text-anchor="middle" dominant-baseline="central"
                fill="${C_STEP}cc">${actionLbl}</text>
        `
            : nothing
        }
        ${
          saveAs
            ? svg`
          <rect x="${ln.w - 32}" y="2" width="30" height="11" rx="3"
                fill="${colors.statusWarn}33"/>
          <text x="${ln.w - 17}" y="7.5" text-anchor="middle" dominant-baseline="central"
                class="rg-badge-txt" fill="${colors.statusWarn}">
            ${saveAs.length > 9 ? `${saveAs.slice(0, 8)}.` : saveAs}
          </text>
        `
            : nothing
        }
      </g>
    `;
  }

  private _decision(ln: LayoutNode) {
    const { node } = ln;
    const isSel = this._selectedId === node.id;
    const cx = ln.w / 2,
      cy = ln.h / 2,
      s = DECISION_SIZE;
    const fill = isSel ? `${C_DECISION}25` : `${C_DECISION}10`;
    const stroke = isSel ? C_DECISION : `${C_DECISION}66`;

    return svg`
      <g class="rg-node" transform="translate(${ln.x},${ln.y})"
         data-testid=${`recipe-graph-node-${node.id.replace(/[^a-zA-Z0-9_-]+/g, '-')}`}
         @click=${() => this._select(node.id)}>
        <polygon points="${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}"
                 fill="${fill}" stroke="${stroke}" stroke-width="${isSel ? 2 : 1.5}"/>
        <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
              fill="${C_DECISION}" font-size="9" font-weight="600">?</text>
        <text x="${cx}" y="${cy + s + 11}" text-anchor="middle" dominant-baseline="central"
              fill="${colors.textMuted}" font-size="7">${node.label}</text>
      </g>
    `;
  }

  private _terminal(ln: LayoutNode) {
    const { node } = ln;
    const isSel = this._selectedId === node.id;
    const col = terminalColor(node);
    const fill = isSel ? `${col}20` : `${col}08`;
    const stroke = isSel ? col : `${col}44`;
    const isEntry = node.annotation === 'ENTRY';
    const rx = isEntry ? 21 : 5;

    return svg`
      <g class="rg-node" transform="translate(${ln.x},${ln.y})"
         data-testid=${`recipe-graph-node-${node.id.replace(/[^a-zA-Z0-9_-]+/g, '-')}`}
         @click=${() => this._select(node.id)}>
        <rect width="${ln.w}" height="${ln.h}" rx="${rx}"
              fill="${fill}" stroke="${stroke}" stroke-width="${isSel ? 2 : 1}"/>
        ${
          !isEntry
            ? svg`
          <rect x="3" y="3" width="${ln.w - 6}" height="${ln.h - 6}" rx="3"
                fill="none" stroke="${stroke}" stroke-width="1"/>
        `
            : nothing
        }
        <text class="rg-label" x="${ln.w / 2}" y="${ln.h / 2}"
              text-anchor="middle" dominant-baseline="central"
              fill="${col}">${node.label}</text>
      </g>
    `;
  }

  private _detail(node: FlowGraphNode) {
    const ann = node.annotation;
    const annColor =
      ann === 'FAIL' ? colors.statusFail : ann === 'PASS' ? colors.statusOk : colors.accent;

    return html`
      <div class="rg-detail">
        <div class="rg-detail-title">
          ${node.label}
          ${ann
            ? html`<span
                style="margin-left:6px;font-size:9px;padding:1px 5px;border-radius:3px;
              background:${annColor}22;color:${annColor}"
                >${ann}</span
              >`
            : nothing}
        </div>
        ${node.description ? html`<div class="rg-detail-desc">${node.description}</div>` : nothing}
      </div>
    `;
  }

  private _select(id: string) {
    this._selectedId = this._selectedId === id ? null : id;
    this.dispatchEvent(
      new CustomEvent('recipe-node-select', {
        detail: { nodeId: this._selectedId },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'recipe-graph': RecipeGraph;
  }
}
