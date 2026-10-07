// Recipe HUD for the web-dapp app tab: state handling and the page expression
// that draws it.
//
// The overlay is an <mm-harness-hud> element under <html> (outside <body>) with
// a closed shadow root, aria-hidden and pointer-events:none: page text, test-id
// selectors, elementFromPoint clicks and the accessibility tree never see it.
// It sits over the chart's top-left corner, below the chart toolbar, away from
// the nav bar, the order form, the order rows and the bottom-left dev badge.
// State lives in <runtime>/hud.json so the wallet host can redraw it after
// every navigation; the expression only draws on the app origin, never inside
// MetaMask's extension pages.

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const HUD_ELEMENT = 'mm-harness-hud';
export const HUD_FILE = 'hud.json';
const MAX_TEXT = 180;

function text(value, max = MAX_TEXT) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const flat = String(value).replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function progressOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const current = Number(raw.current);
  const total = Number(raw.total);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  return { current, total, complete: raw.complete === true };
}

// Fold one app.hud node into the previous state. A running node becomes the
// current step; a pass/fail node also becomes the "last result" line, and the
// recipe-complete node closes the run.
export function nextHudState(prior, node = {}, nodeId = '') {
  // A finished run's HUD stays up until the next run's first update replaces it.
  const previous = prior?.finished ? { seq: prior.seq } : prior;
  const status = ['running', 'pass', 'fail'].includes(node.status) ? node.status : 'running';
  const progress = progressOf(node.progress);
  const intent = text(node.intent ?? node.text ?? node.detail) || text(nodeId);
  const id = text(node.node_id ?? node.nodeId ?? nodeId, 80);
  const state = {
    seq: (previous?.seq ?? 0) + 1,
    title: text(node.title, 80) || previous?.title || 'Recipe run',
    current: previous?.current ?? null,
    last: previous?.last ?? null,
    finished: null,
  };
  if (status === 'running') {
    state.current = {
      nodeId: id,
      intent,
      progress: progress ?? previous?.current?.progress ?? null,
    };
    return state;
  }
  const error = status === 'fail' ? text(node.error) : '';
  state.last = { nodeId: id, intent, status, ...(error ? { error } : {}) };
  if (progress?.complete || id === 'recipe-complete') {
    state.finished = status;
    state.current = {
      nodeId: id,
      intent: status === 'pass' ? 'Recipe passed' : 'Recipe failed',
      progress,
    };
  } else if (progress) {
    state.current = { ...(state.current ?? { nodeId: id, intent }), progress };
  }
  return state;
}

export function hudFile(runtimeDir) {
  return path.join(runtimeDir, HUD_FILE);
}

export function readHudState(runtimeDir) {
  try {
    return JSON.parse(readFileSync(hudFile(runtimeDir), 'utf8'));
  } catch {
    return null;
  }
}

export function writeHudState(runtimeDir, state) {
  const file = hudFile(runtimeDir);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function clearHudState(runtimeDir) {
  rmSync(hudFile(runtimeDir), { force: true });
}

const STYLE = `
:host { all: initial; }
.hud { position: fixed; top: 220px; left: 12px; z-index: 2147483647; width: 360px; max-width: calc(50vw - 24px);
  box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,.18);
  background: rgba(16,18,24,.82); color: #f2f4f7; font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  pointer-events: none; user-select: none; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
.row { display: flex; gap: 6px; align-items: baseline; }
.title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.step { color: #a9b1bd; font-variant-numeric: tabular-nums; }
.intent { margin-top: 4px; }
.badge { display: inline-block; padding: 0 5px; border-radius: 4px; font-size: 10px; font-weight: 700; letter-spacing: .03em; }
.running { background: #2f6fed; color: #fff; }
.pass { background: #1f9d55; color: #fff; }
.fail { background: #d64545; color: #fff; }
.last { margin-top: 4px; color: #c7cdd6; }
.error { color: #ffb4b4; }
`;

// A self-contained page expression: draws (or clears, for null) the HUD when
// the document is on the app origin, and skips the work when the same state
// is already drawn.
export function hudRenderExpression(state, appOrigin) {
  return `(() => {
    const state = ${JSON.stringify(state ?? null)};
    if (location.origin !== ${JSON.stringify(String(appOrigin).replace(/\/$/u, ''))}) return { hud: false, reason: 'not-app-origin' };
    const existing = document.documentElement.querySelector(':scope > ${HUD_ELEMENT}');
    if (!state) { existing?.remove(); return { hud: false, cleared: true }; }
    if (existing && existing.dataset.seq === String(state.seq)) return { hud: true, seq: state.seq, unchanged: true };
    existing?.remove();
    const host = document.createElement('${HUD_ELEMENT}');
    host.dataset.seq = String(state.seq);
    host.setAttribute('aria-hidden', 'true');
    host.inert = true;
    host.style.cssText = 'all: initial; position: fixed; inset: 0 auto auto 0; width: 0; height: 0; pointer-events: none; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const el = (tag, cls, value) => { const node = document.createElement(tag); if (cls) node.className = cls; if (value != null) node.textContent = value; return node; };
    const style = el('style', null, ${JSON.stringify(STYLE)});
    const box = el('div', 'hud');
    const head = el('div', 'row');
    head.append(el('span', 'title', state.title));
    const progress = state.current && state.current.progress;
    if (progress) head.append(el('span', 'step', 'step ' + progress.current + '/' + progress.total));
    box.append(head);
    if (state.current) {
      const line = el('div', 'intent');
      const status = state.finished || 'running';
      line.append(el('span', 'badge ' + status, status === 'running' ? 'RUN' : status.toUpperCase()), ' ', state.current.intent);
      box.append(line);
    }
    if (state.last && !state.finished) {
      const line = el('div', 'last');
      line.append(el('span', 'badge ' + state.last.status, state.last.status.toUpperCase()), ' ', state.last.intent);
      box.append(line);
    }
    if (state.last && state.last.error) box.append(el('div', 'last error', state.last.error));
    root.append(style, box);
    document.documentElement.append(host);
    return { hud: true, seq: state.seq };
  })()`;
}
