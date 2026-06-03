import path from 'node:path';

import type { EvidenceManifestStandalone } from '@farmslot/protocol';

import { evidenceKeyVariants } from './evidence-paths.js';

export interface EvidenceManifestPair {
  label: string;
  covers?: string[];
  before?: string;
  after?: string;
  note?: string;
}

export interface EvidenceManifestVideo {
  before?: string;
  after?: string;
  preferred?: boolean;
  note?: string;
}

export interface EvidenceManifestOmit {
  file: string;
  reason?: string;
}

export interface EvidenceManifest {
  version?: number;
  preferred_mode?: 'screenshots' | 'video';
  summary?: string;
  before_after_pairs?: EvidenceManifestPair[];
  standalone?: EvidenceManifestStandalone[];
  omit?: Array<string | EvidenceManifestOmit>;
  videos?: EvidenceManifestVideo;
  before_state_capture?: JsonRecord;
}

type JsonRecord = Record<string, unknown>;

const EVIDENCE_MEDIA_EXT = /\.(png|jpe?g|gif|mp4|mov|webm)$/i;

const MANIFEST_KEYS = new Set([
  'version',
  'preferred_mode',
  'summary',
  'before_after_pairs',
  'standalone',
  'omit',
  'videos',
  'before_state_capture',
]);
const PAIR_KEYS = new Set(['label', 'covers', 'before', 'after', 'note']);
const STANDALONE_KEYS = new Set(['label', 'covers', 'file', 'note']);
const VIDEO_KEYS = new Set(['before', 'after', 'preferred', 'note']);
const OMIT_KEYS = new Set(['file', 'reason']);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushUnknownKeyIssues(
  issues: string[],
  path: string,
  record: JsonRecord,
  allowed: Set<string>,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) issues.push(`${path}.${key}: unknown key`);
  }
}

function optionalString(issues: string[], record: JsonRecord, path: string, key: string): void {
  if (record[key] !== undefined && typeof record[key] !== 'string') {
    issues.push(`${path}.${key}: expected string`);
  }
}

function optionalStringArray(
  issues: string[],
  record: JsonRecord,
  path: string,
  key: string,
): void {
  const value = record[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    issues.push(`${path}.${key}: expected string[]`);
  }
}

export function validateEvidenceManifest(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ['manifest: expected object'];
  pushUnknownKeyIssues(issues, 'manifest', value, MANIFEST_KEYS);

  if (value.version !== undefined && typeof value.version !== 'number') {
    issues.push('manifest.version: expected number');
  }
  if (
    value.preferred_mode !== undefined &&
    value.preferred_mode !== 'screenshots' &&
    value.preferred_mode !== 'video'
  ) {
    issues.push('manifest.preferred_mode: expected "screenshots" or "video"');
  }
  optionalString(issues, value, 'manifest', 'summary');
  if (value.omit !== undefined) {
    if (!Array.isArray(value.omit)) {
      issues.push('manifest.omit: expected array');
    } else {
      value.omit.forEach((entry, index) => {
        const path = `manifest.omit[${index}]`;
        if (typeof entry === 'string') return;
        if (!isRecord(entry)) {
          issues.push(`${path}: expected string or object`);
          return;
        }
        pushUnknownKeyIssues(issues, path, entry, OMIT_KEYS);
        if (typeof entry.file !== 'string' || !entry.file.trim()) {
          issues.push(`${path}.file: expected non-empty string`);
        }
        optionalString(issues, entry, path, 'reason');
      });
    }
  }
  if (value.before_state_capture !== undefined && !isRecord(value.before_state_capture)) {
    issues.push('manifest.before_state_capture: expected object');
  }

  if (value.before_after_pairs !== undefined) {
    if (!Array.isArray(value.before_after_pairs)) {
      issues.push('manifest.before_after_pairs: expected array');
    } else {
      value.before_after_pairs.forEach((entry, index) => {
        const path = `manifest.before_after_pairs[${index}]`;
        if (!isRecord(entry)) {
          issues.push(`${path}: expected object`);
          return;
        }
        pushUnknownKeyIssues(issues, path, entry, PAIR_KEYS);
        if (typeof entry.label !== 'string' || !entry.label.trim()) {
          issues.push(`${path}.label: expected non-empty string`);
        }
        optionalStringArray(issues, entry, path, 'covers');
        optionalString(issues, entry, path, 'before');
        optionalString(issues, entry, path, 'after');
        optionalString(issues, entry, path, 'note');
        if (entry.before === undefined && entry.after === undefined) {
          issues.push(`${path}: expected before or after`);
        }
      });
    }
  }

  if (value.standalone !== undefined) {
    if (!Array.isArray(value.standalone)) {
      issues.push('manifest.standalone: expected array');
    } else {
      value.standalone.forEach((entry, index) => {
        const path = `manifest.standalone[${index}]`;
        if (!isRecord(entry)) {
          issues.push(`${path}: expected object`);
          return;
        }
        pushUnknownKeyIssues(issues, path, entry, STANDALONE_KEYS);
        if (typeof entry.label !== 'string' || !entry.label.trim()) {
          issues.push(`${path}.label: expected non-empty string`);
        }
        optionalStringArray(issues, entry, path, 'covers');
        if (typeof entry.file !== 'string' || !entry.file.trim()) {
          issues.push(`${path}.file: expected non-empty string`);
        }
        optionalString(issues, entry, path, 'note');
      });
    }
  }

  if (value.videos !== undefined) {
    if (!isRecord(value.videos)) {
      issues.push('manifest.videos: expected object');
    } else {
      pushUnknownKeyIssues(issues, 'manifest.videos', value.videos, VIDEO_KEYS);
      optionalString(issues, value.videos, 'manifest.videos', 'before');
      optionalString(issues, value.videos, 'manifest.videos', 'after');
      optionalString(issues, value.videos, 'manifest.videos', 'note');
      if (value.videos.preferred !== undefined && typeof value.videos.preferred !== 'boolean') {
        issues.push('manifest.videos.preferred: expected boolean');
      }
    }
  }

  return issues;
}

export function normalizeEvidenceManifestArtifactPath(value: string): string | null {
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
  if (!withoutArtifacts || !EVIDENCE_MEDIA_EXT.test(withoutArtifacts)) return null;
  return `artifacts/${withoutArtifacts}`;
}

export function evidenceManifestArtifactPaths(
  manifest: EvidenceManifest | null | undefined,
): string[] {
  const paths = new Set<string>();
  const add = (value: string | undefined) => {
    if (typeof value !== 'string') return;
    const normalized = normalizeEvidenceManifestArtifactPath(value);
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
  const imageFiles = [...artifactUrls.keys()].filter((name) => /\.(png|jpg|jpeg|gif)$/i.test(name));
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

export function buildEvidenceSection(
  manifest: EvidenceManifest,
  artifactUrls: Map<string, string>,
): string | null {
  const lines: string[] = [];
  if (manifest.summary) lines.push(manifest.summary.trim(), '');

  const pairs = manifest.before_after_pairs ?? [];
  const standalone = manifest.standalone ?? [];
  const screenshotsPreferred = manifest.preferred_mode !== 'video';

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
    if (!file) return undefined;
    for (const variant of evidenceKeyVariants(file)) {
      const url = artifactUrls.get(variant);
      if (url) return url;
    }
    return undefined;
  };

  if (screenshotsPreferred && (pairs.length || standalone.length)) {
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
              `<td align="center" width="50%"><em>Before</em><br/><img src="${beforeUrl}" alt="before" width="400" /></td>`,
              `<td align="center" width="50%"><em>After</em><br/><img src="${afterUrl}" alt="after" width="400" /></td>`,
              `</tr>`,
            ].join('\n');
          }
          const url = beforeUrl ?? afterUrl!;
          const which = beforeUrl ? 'Before' : 'After';
          return [
            labelCell,
            `<tr><td colspan="2" align="center"><em>${which}</em><br/><img src="${url}" alt="${which.toLowerCase()}" width="400" /></td></tr>`,
          ].join('\n');
        })
        .filter(Boolean);

      if (pairRows.length > 0) {
        lines.push('<table>', ...pairRows, '</table>', '');
      }
    }

    // Standalone screenshots: compact grid
    if (standalone.length > 0) {
      const imageShots = standalone.filter((s) => !/\.(mp4|mov|webm)$/i.test(s.file));
      const videoShots = standalone.filter((s) => /\.(mp4|mov|webm)$/i.test(s.file));

      if (imageShots.length > 0) {
        // Two-column grid for standalone images
        const rows: string[] = [];
        for (let i = 0; i < imageShots.length; i += 2) {
          const left = imageShots[i];
          const right = imageShots[i + 1];
          const leftUrl = urlFor(left.file);
          if (!leftUrl) continue;
          const leftHint = confidenceHint(captionConfidenceFor(left, fileUsage));
          const leftCell = `<td align="center" width="50%"><strong>${left.label}</strong>${left.note ? `<br/><em>${left.note}</em>` : ''}<br/><img src="${leftUrl}" alt="${left.label}" width="400" />${leftHint ? `<br/>${leftHint}` : ''}</td>`;
          if (right) {
            const rightUrl = urlFor(right.file);
            if (rightUrl) {
              const rightHint = confidenceHint(captionConfidenceFor(right, fileUsage));
              rows.push(
                `<tr>${leftCell}<td align="center" width="50%"><strong>${right.label}</strong>${right.note ? `<br/><em>${right.note}</em>` : ''}<br/><img src="${rightUrl}" alt="${right.label}" width="400" />${rightHint ? `<br/>${rightHint}` : ''}</td></tr>`,
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
        `<tr><td align="center" width="50%"><em>Before</em><br/><a href="${videoBeforeUrl}">${videos?.before}</a></td>`,
        `<td align="center" width="50%"><em>After</em><br/><a href="${videoAfterUrl}">${videos?.after}</a></td></tr>`,
        '</table>',
      );
    } else {
      if (videoBeforeUrl) lines.push(`- Before: [${videos?.before}](${videoBeforeUrl})`);
      if (videoAfterUrl) lines.push(`- After: [${videos?.after}](${videoAfterUrl})`);
    }
  }

  const rendered = lines.join('\n').trim();
  return rendered || null;
}
