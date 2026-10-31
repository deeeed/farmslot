import path from 'node:path';

export { validateEvidenceManifest } from '@farmslot/agent-runtime/scripts/evidence-manifest.cjs';

import {
  type BeforeAttemptAttestation,
  type EvidenceManifest,
  type EvidenceManifestPair,
  type EvidenceManifestStandalone,
  type EvidenceManifestVideo,
  isRunArtifactImagePath,
  isRunArtifactMediaPath,
  RECIPE_CLAIM_VERDICTS,
} from '@farmslot/protocol';

import { evidenceKeyVariants } from './evidence-paths.js';
import { plain } from './inert-text.js';
import { publicationDetails } from './publication-details.js';

export type {
  EvidenceManifest,
  EvidenceManifestOmit,
  EvidenceManifestPair,
  EvidenceManifestVideo,
} from '@farmslot/protocol';

export const EVIDENCE_VIDEO_EXT = /\.(mp4|mov|webm)$/i;

/**
 * Task-dir relative `artifacts/...` path for a manifest file value, or null when it
 * is not a local artifact path. `mediaOnly: false` keeps non-media files (logs,
 * JSON traces) for readers that link evidence rather than embed it.
 */
export function normalizeEvidenceManifestArtifactPath(
  value: string,
  { mediaOnly = true }: { mediaOnly?: boolean } = {},
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(trimmed)) return null;
  const [pathPart] = trimmed.split(/[?#]/, 1);
  const normalized = pathPart.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.includes('\0')) return null;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  const withoutArtifacts =
    segments[0] === 'artifacts' ? segments.slice(1).join('/') : segments.join('/');
  if (!withoutArtifacts || (mediaOnly && !isRunArtifactMediaPath(withoutArtifacts))) return null;
  return `artifacts/${withoutArtifacts}`;
}

export function evidenceManifestArtifactPaths(
  manifest: EvidenceManifest | null | undefined,
  options: { mediaOnly?: boolean } = {},
): string[] {
  const paths = new Set<string>();
  const add = (value: string | undefined) => {
    if (typeof value !== 'string') return;
    const normalized = normalizeEvidenceManifestArtifactPath(value, options);
    if (normalized) paths.add(normalized);
  };

  for (const pair of manifest?.before_after_pairs ?? []) {
    add(pair.before);
    add(pair.after);
  }
  for (const entry of manifest?.standalone ?? []) {
    add(entry.file);
  }
  add(manifest?.videos?.before);
  add(manifest?.videos?.after);

  return [...paths].sort();
}

function titleCaseSlug(slug: string): string {
  return slug
    .replace(/\.[^.]+$/, '')
    .replace(/^before-/, '')
    .replace(/^after-/, '')
    .replace(/^evidence-/, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function autoDetectEvidenceManifest(
  artifactUrls?: Map<string, string>,
): EvidenceManifest | null {
  if (!artifactUrls || artifactUrls.size === 0) return null;
  const imageFiles = [...artifactUrls.keys()].filter((name) => isRunArtifactImagePath(name));
  const beforeMap = new Map<string, string>();
  const afterMap = new Map<string, string>();
  const standalone: EvidenceManifestStandalone[] = [];

  for (const name of imageFiles) {
    if (name.startsWith('before-')) {
      beforeMap.set(name.slice('before-'.length), name);
    } else if (name.startsWith('after-')) {
      afterMap.set(name.slice('after-'.length), name);
    }
  }

  const pairs: EvidenceManifestPair[] = [];
  const pairedKeys = new Set<string>();
  for (const [suffix, after] of afterMap.entries()) {
    const before = beforeMap.get(suffix);
    pairs.push({
      label: titleCaseSlug(suffix),
      before,
      after,
    });
    pairedKeys.add(suffix);
  }

  for (const [suffix, before] of beforeMap.entries()) {
    if (!pairedKeys.has(suffix)) {
      pairs.push({
        label: titleCaseSlug(suffix),
        before,
      });
    }
  }

  for (const name of imageFiles) {
    if (name.startsWith('before-') || name.startsWith('after-')) continue;
    standalone.push({ label: titleCaseSlug(name), file: name });
  }

  // Detect standalone videos (review.mp4, walkthrough.mp4, etc.) — not just before/after
  const videoFiles = [...artifactUrls.keys()].filter((name) => /\.(mp4|mov|webm)$/i.test(name));
  for (const name of videoFiles) {
    const basename = name.split('/').pop() ?? name;
    if (basename === 'before.mp4' || basename === 'after.mp4') continue;
    standalone.push({ label: titleCaseSlug(basename), file: name });
  }

  const videos: EvidenceManifestVideo = {};
  const findVideo = (target: string) =>
    videoFiles.find((f) => (f.split('/').pop() ?? f) === target);
  const beforeVideo = findVideo('before.mp4');
  const afterVideo = findVideo('after.mp4');
  if (beforeVideo) videos.before = beforeVideo;
  if (afterVideo) videos.after = afterVideo;
  if (!pairs.length && !standalone.length && !videos.before && !videos.after) return null;
  if (videos.before || videos.after) videos.preferred = !pairs.length && !standalone.length;

  return {
    version: 1,
    preferred_mode: pairs.length || standalone.length ? 'screenshots' : 'video',
    before_after_pairs: pairs,
    standalone,
    videos: videos.before || videos.after ? videos : undefined,
  };
}

export type CaptionConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export function captionConfidenceFor(
  item: { file?: string; before?: string; after?: string; note?: string },
  fileUsage: Map<string, number>,
): { level: CaptionConfidence; reason?: string } {
  if (item.note && item.note.trim().length > 0) return { level: 'HIGH' };
  const files = [item.file, item.before, item.after].filter((f): f is string => !!f);
  if (files.length === 0) return { level: 'LOW', reason: 'no file' };
  if (files.some((f) => (fileUsage.get(f) ?? 0) > 1)) {
    return { level: 'LOW', reason: 'same file referenced by multiple entries' };
  }
  const stateSuffix =
    /(?:^|[-_])(ac\d+|populated|empty(?:-state)?|skeleton|loading|cleared|loaded|pending|success|error|before|after|baseline|final)(?:[-_.]|$)/i;
  const hasStateSuffix = files.some((f) => stateSuffix.test(f.split('/').pop() ?? f));
  return hasStateSuffix
    ? { level: 'MEDIUM' }
    : { level: 'LOW', reason: 'generic filename — no state-specific suffix' };
}

function confidenceHint(conf: { level: CaptionConfidence; reason?: string }): string {
  if (conf.level !== 'LOW') return '';
  return `<sub>caption confidence: LOW${conf.reason ? ` — ${conf.reason}` : ''}</sub>`;
}

export interface LowCaption {
  label: string;
  file?: string;
  reason: string;
}

function manifestFileUsage(manifest: EvidenceManifest): Map<string, number> {
  const fileUsage = new Map<string, number>();
  const bump = (f?: string) => {
    if (f) fileUsage.set(f, (fileUsage.get(f) ?? 0) + 1);
  };
  for (const p of manifest.before_after_pairs ?? []) {
    bump(p.before);
    bump(p.after);
  }
  for (const s of manifest.standalone ?? []) {
    bump(s.file);
  }
  return fileUsage;
}

/**
 * Collect entries whose caption confidence is LOW.
 * Used by the evidence gate to block posting when captions cannot be trusted.
 */
export function collectLowCaptions(manifest: EvidenceManifest): LowCaption[] {
  const fileUsage = manifestFileUsage(manifest);
  const out: LowCaption[] = [];
  for (const pair of manifest.before_after_pairs ?? []) {
    if (![pair.before, pair.after].some((file) => file && isRunArtifactMediaPath(file))) continue;
    const c = captionConfidenceFor(pair, fileUsage);
    if (c.level === 'LOW') {
      out.push({
        label: pair.label,
        file: pair.before ?? pair.after,
        reason: c.reason ?? 'unknown',
      });
    }
  }
  for (const shot of manifest.standalone ?? []) {
    if (!isRunArtifactMediaPath(shot.file)) continue;
    const c = captionConfidenceFor(shot, fileUsage);
    if (c.level === 'LOW') {
      out.push({ label: shot.label, file: shot.file, reason: c.reason ?? 'unknown' });
    }
  }
  return out;
}

export class EvidenceCaptionError extends Error {
  constructor(public readonly lowCaptions: LowCaption[]) {
    super(
      `Evidence blocked: ${lowCaptions.length} low-confidence caption(s). ` +
        lowCaptions.map((lc) => `"${lc.label}" — ${lc.reason}`).join('; '),
    );
    this.name = 'EvidenceCaptionError';
  }
}

/**
 * Hard gate: throws `EvidenceCaptionError` if any evidence entry has LOW caption confidence.
 * Callers should invoke this before `buildEvidenceSection` in production paths that post
 * evidence to PRs (review flow).
 */
export function assertCaptionConfidence(manifest: EvidenceManifest): void {
  const lows = collectLowCaptions(manifest);
  if (lows.length > 0) throw new EvidenceCaptionError(lows);
}

export function manifestPrefersVideo(manifest: EvidenceManifest | null | undefined): boolean {
  return manifest?.preferred_mode === 'video' || manifest?.videos?.preferred === true;
}

export function buildEvidenceSection(
  manifest: EvidenceManifest,
  artifactUrls: Map<string, string>,
  /** Attestations admitted for these attempts (`admittedBeforeAttemptAttestations`). */
  beforeAttemptAttestations: readonly BeforeAttemptAttestation[] = [],
): string | null {
  const lines: string[] = [];
  // The engine's pre-review status list is superseded by the Visual judgments table.
  const summary = manifest.summary?.trim();
  const engineStatuses = summary?.split(';').every((entry) => {
    const match = /^\s*[^:\s]+:\s*(\S+)\s*$/.exec(entry);
    return match && RECIPE_CLAIM_VERDICTS.some((verdict) => verdict === match[1]);
  });

  const pairs = manifest.before_after_pairs ?? [];
  const standalone = manifest.standalone ?? [];

  const fileUsage = new Map<string, number>();
  const bumpUsage = (f?: string) => {
    if (f) fileUsage.set(f, (fileUsage.get(f) ?? 0) + 1);
  };
  for (const p of pairs) {
    bumpUsage(p.before);
    bumpUsage(p.after);
  }
  for (const s of standalone) {
    bumpUsage(s.file);
  }
  const urlFor = (file?: string): string | undefined => {
    if (!file || !isRunArtifactMediaPath(file)) return undefined;
    for (const variant of evidenceKeyVariants(file)) {
      const url = artifactUrls.get(variant);
      if (url) return url;
    }
    return undefined;
  };
  const representatives = new Map<string, { label: string; url: string }>();
  const representative = (
    entry: EvidenceManifestPair | EvidenceManifestStandalone,
    file?: string,
  ) => {
    if (!file || !isRunArtifactImagePath(file)) return;
    const url = urlFor(file);
    if (!url) return;
    for (const claim of entry.covers ?? []) {
      if (!representatives.has(claim)) representatives.set(claim, { label: entry.label, url });
    }
  };
  for (const pair of pairs) {
    representative(
      pair,
      pair.after && isRunArtifactImagePath(pair.after) && urlFor(pair.after)
        ? pair.after
        : pair.before,
    );
  }
  for (const shot of standalone) representative(shot, shot.file);
  const media = (file: string, url: string, label: string) =>
    isRunArtifactImagePath(file)
      ? `<img src="${url}" alt="${label}" width="320" />`
      : `<a href="${url}">${label}</a>`;
  // ADR-062 Amendment 21: disclose a before side admitted by operator attestation.
  const attestedBefore = (file?: string) => {
    const artifact = file && normalizeEvidenceManifestArtifactPath(file, { mediaOnly: false });
    const attested = beforeAttemptAttestations.find(({ attemptRoot }) =>
      artifact?.startsWith(`artifacts/${attemptRoot}/`),
    );
    return (
      attested &&
      plain(`${attested.reason} (${attested.approver.displayName}, ${attested.attestedAt})`)
    );
  };
  const beforeHeading = (file?: string) => {
    const attested = attestedBefore(file);
    return attested
      ? `<em>Before: operator-attested</em><br/><sub>${attested}</sub>`
      : '<em>Before</em>';
  };

  if (pairs.length || standalone.length) {
    // Before/after pairs: side-by-side HTML table for clean comparison
    if (pairs.length > 0) {
      const pairRows = pairs
        .map((pair) => {
          const beforeUrl = urlFor(pair.before);
          const afterUrl = urlFor(pair.after);
          if (!beforeUrl && !afterUrl) return '';
          const label = pair.label + (pair.note ? ` — ${pair.note}` : '');
          const hint = confidenceHint(captionConfidenceFor(pair, fileUsage));
          const labelCell = hint
            ? `<tr><td colspan="2"><strong>${label}</strong><br/>${hint}</td></tr>`
            : `<tr><td colspan="2"><strong>${label}</strong></td></tr>`;
          if (beforeUrl && afterUrl) {
            return [
              labelCell,
              `<tr>`,
              `<td align="center" valign="top" width="50%">${beforeHeading(pair.before!)}<br/>${media(pair.before!, beforeUrl, 'before')}</td>`,
              `<td align="center" valign="top" width="50%"><em>After</em><br/>${media(pair.after!, afterUrl, 'after')}</td>`,
              `</tr>`,
            ].join('\n');
          }
          const url = beforeUrl ?? afterUrl!;
          const which = beforeUrl ? 'Before' : 'After';
          const heading = beforeUrl ? beforeHeading(pair.before!) : '<em>After</em>';
          return [
            labelCell,
            `<tr><td colspan="2" align="center" valign="top">${heading}<br/>${media((beforeUrl ? pair.before : pair.after)!, url, which.toLowerCase())}</td></tr>`,
          ].join('\n');
        })
        .filter(Boolean);

      if (pairRows.length > 0) {
        lines.push('<table>', ...pairRows, '</table>', '');
      }
    }

    // Standalone screenshots: compact grid
    if (standalone.length > 0) {
      const imageShots = standalone.filter((shot) => isRunArtifactImagePath(shot.file));
      const videoShots = standalone.filter((shot) => EVIDENCE_VIDEO_EXT.test(shot.file));

      if (imageShots.length > 0) {
        // Two-column grid for standalone images
        const rows: string[] = [];
        for (let i = 0; i < imageShots.length; i += 2) {
          const left = imageShots[i];
          const right = imageShots[i + 1];
          const leftUrl = urlFor(left.file);
          if (!leftUrl) continue;
          const leftHint = confidenceHint(captionConfidenceFor(left, fileUsage));
          const leftCell = `<td align="center" valign="top" width="50%"><strong>${left.label}</strong><br/><img src="${leftUrl}" alt="${left.label}" width="320" />${left.note ? `<br/><sub>${left.note}</sub>` : ''}${leftHint ? `<br/>${leftHint}` : ''}</td>`;
          if (right) {
            const rightUrl = urlFor(right.file);
            if (rightUrl) {
              const rightHint = confidenceHint(captionConfidenceFor(right, fileUsage));
              rows.push(
                `<tr>${leftCell}<td align="center" valign="top" width="50%"><strong>${right.label}</strong><br/><img src="${rightUrl}" alt="${right.label}" width="320" />${right.note ? `<br/><sub>${right.note}</sub>` : ''}${rightHint ? `<br/>${rightHint}` : ''}</td></tr>`,
              );
            } else {
              rows.push(`<tr>${leftCell}<td></td></tr>`);
            }
          } else {
            rows.push(`<tr>${leftCell}<td></td></tr>`);
          }
        }
        if (rows.length > 0) {
          lines.push('<table>', ...rows, '</table>', '');
        }
      }

      if (videoShots.length > 0) {
        for (const shot of videoShots) {
          const url = urlFor(shot.file);
          if (!url) continue;
          lines.push(`- **${shot.label}**: [${shot.file.split('/').pop() ?? shot.file}](${url})`);
        }
        lines.push('');
      }
    }
  }

  const videos = manifest.videos;
  const videoBeforeUrl = urlFor(videos?.before);
  const videoAfterUrl = urlFor(videos?.after);
  if (videoBeforeUrl || videoAfterUrl) {
    if (lines.length) lines.push('');
    lines.push('**Video**');
    if (videos?.note) lines.push(videos.note);
    if (videoBeforeUrl && videoAfterUrl) {
      lines.push(
        '<table>',
        `<tr><td align="center" width="50%">${beforeHeading(videos?.before)}<br/><a href="${videoBeforeUrl}">${videos?.before}</a></td>`,
        `<td align="center" width="50%"><em>After</em><br/><a href="${videoAfterUrl}">${videos?.after}</a></td></tr>`,
        '</table>',
      );
    } else {
      const attested = attestedBefore(videos?.before);
      if (videoBeforeUrl)
        lines.push(
          `- Before${attested ? ` (operator-attested: ${attested})` : ''}: [${videos?.before}](${videoBeforeUrl})`,
        );
      if (videoAfterUrl) lines.push(`- After: [${videos?.after}](${videoAfterUrl})`);
    }
  }

  const gallery = lines.join('\n').trim();
  const rendered = [
    !engineStatuses ? summary : undefined,
    ...[...representatives].map(
      ([claim, shot]) =>
        `<p><strong>${claim}: ${shot.label}</strong><br/><img src="${shot.url}" alt="${shot.label}" width="320" /></p>`,
    ),
    gallery ? publicationDetails(gallery) : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');
  return rendered || null;
}
