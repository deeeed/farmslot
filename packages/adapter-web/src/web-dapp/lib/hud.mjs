// Recipe HUD for the web-dapp app tab: state handling and the page expression
// that draws it.
//
// The overlay is an <mm-harness-hud> element under <html> (outside <body>) with
// a closed shadow root, aria-hidden and pointer-events:none: page text, test-id
// selectors, elementFromPoint clicks and the accessibility tree never see it.
// It sits over the chart's top-left corner, below the chart toolbar, away from
// the nav bar, the order form, the order rows and the bottom-left dev badge.
// State lives in <runtime>/hud.json so the wallet host can redraw it after
// every navigation; the expression draws only on the selected origin.
// A bottom dock reserves page space for wallet screenshots.

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  HUD_COLORS,
  HUD_FINISHED_FONT_SIZE,
  HUD_FINISHED_LINE_HEIGHT,
  HUD_PANEL_BOUNDS,
  hudFinishedLine,
  hudIntentDisplay,
  hudPlacement,
  hudSecondaryText,
  waitForHudPaint,
} from '@farmslot/protocol/recipe';

export const HUD_ELEMENT = 'mm-harness-hud';
export const HUD_FILE = 'hud.json';

function progressOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const current = Number(raw.current);
  const total = Number(raw.total);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  return { current, total, complete: raw.complete === true };
}

// Fold one app.hud node into the previous state. A running node becomes the
// current step; a pass/fail node also becomes the "just finished" line, and the
// recipe-complete node closes the run.
export function nextHudState(prior, node = {}, nodeId = '') {
  // A finished run's HUD stays up until the next run's first update replaces it.
  const previous = prior?.finished ? { seq: prior.seq } : prior;
  const status = ['running', 'pass', 'fail'].includes(node.status) ? node.status : 'running';
  const progress = progressOf(node.progress);
  const intent =
    hudIntentDisplay(node.intent ?? node.text ?? node.detail).text || hudIntentDisplay(nodeId).text;
  const id = hudSecondaryText(node.node_id ?? node.nodeId ?? nodeId, 80);
  const position = hudPlacement(node.display) ?? previous?.position;
  const state = {
    seq: (previous?.seq ?? 0) + 1,
    title: hudSecondaryText(node.title, 80) || previous?.title || 'Recipe run',
    current: previous?.current ?? null,
    last: previous?.last ?? null,
    finished: null,
    ...(position ? { position } : {}),
  };
  if (status === 'running') {
    state.current = {
      nodeId: id,
      intent,
      progress: progress ?? previous?.current?.progress ?? null,
    };
    return state;
  }
  const error = status === 'fail' ? hudSecondaryText(node.error) : '';
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

// The card grows with the intent: nothing clips, clamps or ellipsizes it.
const STYLE = `
:host { all: initial; }
.hud { position: fixed; top: 220px; left: 12px; z-index: 2147483647; width: ${HUD_PANEL_BOUNDS.card.maxWidth}px; max-width: calc(100vw - 24px);
  box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,.18);
  background: rgba(16,18,24,.82); color: #f2f4f7; font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  pointer-events: none; user-select: none; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
.row { display: flex; gap: 6px; align-items: baseline; font-size: 11px; color: ${HUD_COLORS.muted}; }
.title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.step { font-variant-numeric: tabular-nums; }
.intent { margin-top: 4px; color: #fff; }
.intent.pass { color: ${HUD_COLORS.pass}; }
.intent.fail { color: ${HUD_COLORS.fail}; }
.last { margin-top: 4px; font-size: ${HUD_FINISHED_FONT_SIZE}px; line-height: ${HUD_FINISHED_LINE_HEIGHT}px; color: ${HUD_COLORS.muted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.last.fail { color: ${HUD_COLORS.fail}; }
.error { margin-top: 2px; font-size: ${HUD_FINISHED_FONT_SIZE}px; line-height: ${HUD_FINISHED_LINE_HEIGHT}px; color: #ffb4b4;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
`;

// A self-contained page expression: draws (or clears, for null) the HUD when
// the document is on the selected origin, and skips an unchanged state/layout.
// The wallet screenshot consumer uses bottom-dock to keep footer controls clear.
export function hudRenderExpression(state, appOrigin, { layout = 'card' } = {}) {
  const finished =
    state && !state.finished ? hudFinishedLine(state.last, state.current?.nodeId) : null;
  return `(() => {
    const state = ${JSON.stringify(state ?? null)};
    const finished = ${JSON.stringify(finished)};
    const layout = ${JSON.stringify(layout)};
    const docked = layout === 'bottom-dock';
    if (location.origin !== ${JSON.stringify(String(appOrigin).replace(/\/$/u, ''))}) return { hud: false, reason: 'not-app-origin' };
    const existing = document.documentElement.querySelector(':scope > ${HUD_ELEMENT}');
    const remove = () => {
      if (existing?.dataset.layout === 'bottom-dock') {
        document.body.style.paddingBottom = existing.dataset.previousPadding;
        document.getElementById('${HUD_ELEMENT}-space')?.remove();
      }
      existing?.remove();
    };
    if (!state) { remove(); return { hud: false, cleared: true }; }
    if (existing && existing.dataset.seq === String(state.seq) && existing.dataset.layout === layout) return (${waitForHudPaint.toString()})(requestAnimationFrame).then(() => ({ hud: true, seq: state.seq, unchanged: true }));
    remove();
    const host = document.createElement('${HUD_ELEMENT}');
    host.dataset.seq = String(state.seq);
    host.dataset.layout = layout;
    host.setAttribute('data-farmslot-hud-node', state.current?.nodeId || '');
    host.setAttribute('aria-hidden', 'true');
    host.inert = true;
    host.style.cssText = 'all: initial; position: fixed; inset: 0 auto auto 0; width: 0; height: 0; pointer-events: none; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const el = (tag, cls, value) => { const node = document.createElement(tag); if (cls) node.className = cls; if (value != null) node.textContent = value; return node; };
    const style = el('style', null, ${JSON.stringify(STYLE)});
    const box = el('div', 'hud');
    if (docked) {
      Object.assign(box.style, { top: 'auto', bottom: '0', left: '0', right: '0', width: '100vw', maxWidth: 'none', borderRadius: '0', padding: '5px 8px' });
    } else if (state.position) {
      box.style.top = state.position === 'top' ? '12px' : 'auto';
      box.style.bottom = state.position === 'bottom' ? '12px' : 'auto';
    }
    const intentStyle = ${JSON.stringify(hudIntentDisplay('').webStyle)};
    const head = el('div', 'row');
    head.append(el('span', 'title', state.title));
    const progress = state.current && state.current.progress;
    if (progress) head.append(el('span', 'step', 'step ' + progress.current + '/' + progress.total));
    box.append(head);
    if (state.current) {
      const intent = el('div', state.finished ? 'intent ' + state.finished : 'intent', state.current.intent);
      Object.assign(intent.style, intentStyle);
      intent.setAttribute('data-farmslot-hud-intent', '');
      box.append(intent);
    }
    if (finished) box.append(el('div', 'last ' + finished.tone, finished.text));
    if (state.last && state.last.error) box.append(el('div', 'error', state.last.error));
    root.append(style, box);
    document.documentElement.append(host);
    let height;
    if (docked) {
      height = Math.ceil(box.getBoundingClientRect().height);
      host.dataset.previousPadding = document.body.style.paddingBottom;
      const space = el('div');
      space.id = '${HUD_ELEMENT}-space';
      space.setAttribute('aria-hidden', 'true');
      space.inert = true;
      Object.assign(space.style, { display: 'block', height: height + 'px', pointerEvents: 'none' });
      document.body.append(space);
      document.body.style.paddingBottom = height + 'px';
    }
    return (${waitForHudPaint.toString()})(requestAnimationFrame).then(() => ({ hud: true, seq: state.seq, ...(docked ? { docked: true, height } : {}) }));
  })()`;
}
