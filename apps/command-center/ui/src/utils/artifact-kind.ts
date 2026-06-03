/**
 * Filename + purpose heuristic shared by family-observability,
 * slot-view recipe-evidence panel, and media-lightbox filter chips.
 */
export type ArtifactKind = 'before' | 'after' | 'setup';

export function artifactKind(path: string, purpose: string): ArtifactKind {
  const filename = (path.split('/').pop() ?? '').toLowerCase();
  if (/^before([-._]|$)/.test(filename)) return 'before';
  if (/^after([-._]|$)/.test(filename)) return 'after';
  if (/[-._]before$/.test(filename.replace(/\.[^.]+$/, ''))) return 'before';
  if (/[-._]after$/.test(filename.replace(/\.[^.]+$/, ''))) return 'after';
  if (purpose === 'debug-screenshot') return 'setup';
  if (filename.startsWith('evidence-')) return 'after';
  const p = purpose.toUpperCase();
  if (p.includes('BEFORE')) return 'before';
  if (p.includes('AFTER')) return 'after';
  return 'setup';
}
