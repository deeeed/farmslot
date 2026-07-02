declare const __FARMSLOT_APP_VERSION__: string;
declare const __FARMSLOT_RELEASE_NOTES__: string;

export interface ReleaseNotesPayload {
  version: string;
  date: string | null;
  items: string[];
}

/** Semver from `@farmslot/command-center-ui` package.json (injected at build time). */
export const COMMAND_CENTER_APP_VERSION =
  typeof __FARMSLOT_APP_VERSION__ !== 'undefined' ? __FARMSLOT_APP_VERSION__ : 'dev';

function parseReleaseNotes(): ReleaseNotesPayload {
  if (typeof __FARMSLOT_RELEASE_NOTES__ === 'undefined') {
    return { version: COMMAND_CENTER_APP_VERSION, date: null, items: [] };
  }
  try {
    const parsed = JSON.parse(__FARMSLOT_RELEASE_NOTES__) as ReleaseNotesPayload;
    return {
      version: parsed.version ?? COMMAND_CENTER_APP_VERSION,
      date: parsed.date ?? null,
      items: Array.isArray(parsed.items) ? parsed.items.filter(Boolean) : [],
    };
  } catch {
    return { version: COMMAND_CENTER_APP_VERSION, date: null, items: [] };
  }
}

export const COMMAND_CENTER_RELEASE_NOTES = parseReleaseNotes();

export function compareSemver(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function isVersionNewer(candidate: string, baseline: string | null | undefined): boolean {
  if (!baseline) return true;
  return compareSemver(candidate, baseline) > 0;
}
