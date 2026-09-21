import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateDevelopmentSource } from './ui-source.mjs';

export const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space';

export function validateShortcut(value) {
  if (typeof value !== 'string' || value.length > 120 || /[\r\n\0]/.test(value))
    throw new Error('Enter a keyboard shortcut, or leave it blank to disable.');
  return value.trim();
}

export function savedRoute(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^#[a-z][\w/=?&%.:+-]*$/i.test(value))
    return '#fleet';
  const query = value.split('?')[1];
  if (
    query &&
    [...new URLSearchParams(query).keys()].some((key) =>
      /token|password|secret|authorization/i.test(key),
    )
  )
    return '#fleet';
  return value;
}

export function restoreBounds(bounds, displays) {
  if (!bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key])))
    return { width: 1440, height: 960 };
  const area =
    displays.find(
      (d) =>
        bounds.x < d.x + d.width &&
        bounds.x + bounds.width > d.x &&
        bounds.y < d.y + d.height &&
        bounds.y + bounds.height > d.y,
    ) ?? displays[0];
  const width = Math.min(area.width, Math.max(900, Math.round(bounds.width)));
  const height = Math.min(area.height, Math.max(600, Math.round(bounds.height)));
  return {
    x: Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)),
    width,
    height,
  };
}

export function createPreferencesStore(directory, development = false) {
  const path = join(directory, 'preferences.json');
  return {
    load() {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        return {
          shortcut: validateShortcut(value.shortcut ?? DEFAULT_SHORTCUT),
          route: savedRoute(value.route),
          bounds: value.bounds,
          development: validateDevelopmentSource(value.development ?? { enabled: development }),
        };
      } catch (error) {
        if (error.code === 'ENOENT')
          return {
            shortcut: DEFAULT_SHORTCUT,
            route: '#fleet',
            development: validateDevelopmentSource({ enabled: development }),
          };
        throw error;
      }
    },
    save(value) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(
        `${path}.tmp`,
        JSON.stringify({
          shortcut: validateShortcut(value.shortcut),
          route: savedRoute(value.route),
          bounds: value.bounds,
          development: validateDevelopmentSource(value.development ?? { enabled: development }),
        }),
        { mode: 0o600 },
      );
      renameSync(`${path}.tmp`, path);
    },
  };
}

export function validateAttention(value) {
  if (
    !value ||
    typeof value.connected !== 'boolean' ||
    typeof value.ready !== 'boolean' ||
    !Number.isSafeInteger(value.decisions) ||
    value.decisions < 0
  )
    throw new Error('Invalid desktop attention state.');
  return { connected: value.connected, ready: value.ready, decisions: value.decisions };
}

export function attentionLabel(value) {
  if (!value.connected) return 'Gateway disconnected';
  if (!value.ready) return 'Loading pending decisions';
  return value.decisions === 0
    ? 'No pending decisions'
    : `${value.decisions} pending decision${value.decisions === 1 ? '' : 's'}`;
}

export function attentionBadge(value) {
  return value.connected && value.ready && value.decisions > 0 ? String(value.decisions) : '';
}
