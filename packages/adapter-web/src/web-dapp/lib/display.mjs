// How the slot browser is shown: headful (default) or headless, where its
// window sits on screen, the page zoom that keeps the app's desktop layout
// inside that window, and the optional slow-mo between UI actions.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', '']);

function envFlag(raw, label) {
  if (raw == null) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new Error(`${label} must be 1/0 or true/false, got ${JSON.stringify(raw)}.`);
}

// Headless precedence: an explicit flag (--headless, or --headful as its
// opposite) → the launch node (headless, or headful as its opposite) → env
// TERMINAL_HEADLESS → headful.
export function resolveHeadless({
  headless,
  headful,
  nodeHeadless,
  nodeHeadful,
  env = process.env,
} = {}) {
  if (headless === true && headful === true)
    throw new Error('--headless and --headful are mutually exclusive.');
  if (headless === true) return true;
  if (headful === true) return false;
  if (typeof nodeHeadless === 'boolean') return nodeHeadless;
  if (nodeHeadful === true) return false;
  return envFlag(env.TERMINAL_HEADLESS, 'TERMINAL_HEADLESS') ?? false;
}

function slowMoValue(raw, label) {
  if (raw == null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 60000) {
    throw new Error(
      `${label} must be whole milliseconds between 0 and 60000, got ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}

// Slow-mo precedence: --slow-mo → launch node slow_mo_ms → env TERMINAL_SLOW_MO → 0.
export function resolveSlowMo({ flag, node, env = process.env } = {}) {
  return (
    slowMoValue(flag, '--slow-mo') ??
    slowMoValue(node, 'slow_mo_ms') ??
    slowMoValue(env.TERMINAL_SLOW_MO, 'TERMINAL_SLOW_MO') ??
    0
  );
}

// The order page switches layout at 800 and 1440 CSS px. Recipes were proven on
// a 1600 CSS-px wide viewport, so a smaller window zooms out until the page
// still lays out at least this wide.
export const MIN_LAYOUT_WIDTH = 1460;
export const MIN_ZOOM = 0.5;
const FALLBACK_SCREEN = Object.freeze({ left: 0, top: 25, width: 1512, height: 920 });

// The main screen's usable area in points (menu bar and Dock excluded).
export function detectScreen(env = process.env) {
  const explicit = /^(\d+)x(\d+)(?:\+(\d+)\+(\d+))?$/u.exec(
    String(env.TERMINAL_SCREEN ?? '').trim(),
  );
  if (explicit) {
    return {
      left: Number(explicit[3] ?? 0),
      top: Number(explicit[4] ?? 0),
      width: Number(explicit[1]),
      height: Number(explicit[2]),
      source: 'TERMINAL_SCREEN',
    };
  }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync(
        'osascript',
        [
          '-l',
          'JavaScript',
          '-e',
          [
            'ObjC.import("AppKit");',
            'const s = $.NSScreen.mainScreen; const f = s.frame; const v = s.visibleFrame;',
            'JSON.stringify({ left: v.origin.x, top: f.size.height - v.origin.y - v.size.height, width: v.size.width, height: v.size.height })',
          ].join(' '),
        ],
        { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const screen = JSON.parse(out.trim());
      if (screen.width > 0 && screen.height > 0) return { ...screen, source: 'main-screen' };
    } catch {
      // Fall through to a size that fits any current MacBook.
    }
  }
  return { ...FALLBACK_SCREEN, source: 'fallback' };
}

// One window per slot, side by side: odd CDP ports (mmt-1: 9541) take the left
// half of the main screen, even ports (mmt-2: 9542) the right half.
// TERMINAL_WINDOW=x,y,width,height places the window explicitly.
export function windowPlacement({ cdpPort, env = process.env, screen = null } = {}) {
  const explicit = /^(-?\d+),(-?\d+),(\d+),(\d+)$/u.exec(
    String(env.TERMINAL_WINDOW ?? '').replace(/\s/gu, ''),
  );
  let bounds;
  if (explicit) {
    bounds = {
      x: Number(explicit[1]),
      y: Number(explicit[2]),
      width: Number(explicit[3]),
      height: Number(explicit[4]),
      source: 'TERMINAL_WINDOW',
    };
  } else {
    const area = screen ?? detectScreen(env);
    const width = Math.floor(area.width / 2);
    const column = Number(cdpPort) % 2 === 1 ? 0 : 1;
    bounds = {
      x: Math.round(area.left) + column * width,
      y: Math.round(area.top),
      width,
      height: Math.floor(area.height),
      source: area.source ?? 'screen',
    };
  }
  const zoom = Math.max(
    MIN_ZOOM,
    Math.min(1, Math.floor((bounds.width / MIN_LAYOUT_WIDTH) * 100) / 100),
  );
  return { ...bounds, zoom };
}

// Chromium stores page zoom as a level: zoom = 1.2 ^ level. The profile's
// default zoom applies to every page the slot browser opens.
export function zoomLevel(zoom) {
  return zoom === 1 ? 0 : Math.log(zoom) / Math.log(1.2);
}

export function writeProfileZoom(profile, zoom) {
  const file = path.join(profile, 'Default', 'Preferences');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const prefs = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  prefs.partition ??= {};
  prefs.partition.default_zoom_level = {
    ...(prefs.partition.default_zoom_level ?? {}),
    x: zoomLevel(zoom),
  };
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(prefs), { mode: 0o600 });
  renameSync(temporary, file);
}

// Headless keeps the tall viewport the recipes were first proven on; headful
// opens a placed window instead.
export function browserDisplayArgs({ headless, placement }) {
  if (headless) return ['--headless=new', '--window-size=1600,2400'];
  return [
    `--window-position=${placement.x},${placement.y}`,
    `--window-size=${placement.width},${placement.height}`,
  ];
}
