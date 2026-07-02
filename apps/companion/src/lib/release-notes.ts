import releaseNotesJson from '../generated/release-notes.json';

export interface ReleaseNotesPayload {
  version: string;
  date: string | null;
  items: string[];
}

const parsedNotes = releaseNotesJson as ReleaseNotesPayload;

export const COMPANION_RELEASE_NOTES: ReleaseNotesPayload = {
  version: parsedNotes.version ?? '0.0.0',
  date: parsedNotes.date ?? null,
  items: Array.isArray(parsedNotes.items)
    ? parsedNotes.items.filter((item) => typeof item === 'string' && item.length > 0)
    : [],
};

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
