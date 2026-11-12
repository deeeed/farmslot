import type { DiffStat, EvidenceManifestEntry, Run, RunStep } from '../contracts/runs.js';
import { isRelativeArtifactPath } from '../recipe/common.js';
import { isInternalRunArtifactPath } from '../recipes/step-io.js';

import {
  isRunArtifactImagePath,
  isRunArtifactMediaPath,
  isRunEvidenceVideoArtifact,
} from './artifact-media.js';
import type { RunListRow } from './list-row.js';

export { isRunArtifactImagePath, isRunArtifactMediaPath, isRunEvidenceVideoArtifact };

/** A run artifact with the metadata its source recorded. */
export interface RunArtifactManifestEntry extends EvidenceManifestEntry {
  type?: string;
  label?: string;
  nodeId?: string;
  mimeType?: string;
  timelinePath?: string;
  timelineUnavailableReason?: string;
  bundleDigest?: string;
}

/**
 * The eval catalog's counts of a run's step-output artifacts. They follow the catalog's own
 * rules and are not the list chips' counts (`artifactCount`, `videoCount`, `visualPairCount`).
 */
export interface RunCatalogCounts {
  artifactCount: number;
  /** Total recorded bytes. */
  artifactBytes: number;
  /** Screenshot, video and visual purposes, and media paths. */
  visualEvidenceCount: number;
  /** Recipe, validation, report, summary, trace, coverage and manifest artifacts. */
  validationEvidenceCount: number;
  /** Review and comment artifacts. */
  reviewEvidenceCount: number;
}

export interface RunEvidenceSummary {
  artifactCount: number;
  videoCount: number;
  visualPairCount: number;
  /** Diff stat from the run's latest step that reported one. */
  diffStat?: DiffStat;
  /** The eval catalog's counts (`runCatalogCounts`); the catalog reads these, the chips do not. */
  catalogCounts: RunCatalogCounts;
  /** The diff file a run's Diff button opens (`diffArtifactCandidate` over its artifacts). */
  diffArtifactPath?: string;
}

/** A step-output artifact as a run.list row carries it. */
export type RunListStepArtifact = Pick<RunArtifactManifestEntry, 'path' | 'purpose' | 'sizeBytes'>;

/**
 * The most step-output artifacts one run.list row keeps, across its steps. The stored run with
 * the most keeps 60 (95 in 100 keep 35 or fewer), so the cap changes no known run; it bounds
 * what one unusual run can add to a row at about 11 KB.
 */
export const RUN_LIST_STEP_ARTIFACT_LIMIT = 100;

/**
 * Every artifact a run reports: gate and review payloads, the captured run
 * output and step outputs, without gateway-internal launch diagnostics. Command
 * Center and Companion both read a run's artifacts through this.
 */
export function extractRunArtifactManifest(
  run:
    | Pick<Run, 'decisions' | 'steps' | 'output'>
    | Pick<RunListRow, 'decisions' | 'steps' | 'output'>,
): RunArtifactManifestEntry[] {
  const entries: RunArtifactManifestEntry[] = [];
  for (const decision of run.decisions ?? []) {
    const payload = decision.payload;
    if (payload?.kind === 'ready') {
      entries.push(...(payload.artifactManifest ?? []));
      // A run.list row leaves the package out.
      if ('prPackage' in payload) {
        entries.push(...(payload.prPackage?.evidenceManifest ?? []));
        for (const check of payload.prPackage?.deterministicChecks ?? []) {
          if (check.logPath) {
            entries.push({
              path: check.logPath,
              purpose: 'ci-parity-log',
              type: 'log',
              label: `${check.reference} · ${check.status}`,
            });
          }
        }
      }
    } else if (payload?.kind === 'review') {
      entries.push(...(payload.artifactManifest ?? []));
      entries.push(...runArtifactPathsToManifest(payload.reviewInputArtifactPaths ?? []));
    } else if (payload?.kind === 'no-change') {
      entries.push(...(payload.artifactManifest ?? []));
    }
  }
  // A gate keeps the frozen metadata of a file the run output captured again
  // later; the output only fills in what the gate did not record.
  const declared = new Map(dedupeRunArtifacts(entries).map((entry) => [entry.path, entry]));
  for (const artifact of run.output?.artifactManifest ?? []) {
    if (isInternalRunArtifactPath(artifact.path)) continue;
    const frozen = declared.get(artifact.path);
    entries.push(frozen ? { ...artifact, ...frozen } : artifact);
  }
  for (const step of run.steps ?? []) {
    collectRunArtifactEntries(step.outputs, entries);
  }
  return dedupeRunArtifacts(entries);
}

/** What the evidence summary reads: a full run, or a run.list row (slim or cached full). */
export type RunEvidenceSource =
  | Pick<Run, 'decisions' | 'steps' | 'output' | 'liveRecipeContext'>
  | Pick<RunListRow, 'decisions' | 'steps' | 'output' | 'liveRecipeContext'>;

export function runEvidenceArtifacts(run: RunEvidenceSource): RunArtifactManifestEntry[] {
  return dedupeRunArtifacts([
    ...(run.liveRecipeContext?.artifactManifest ?? []),
    ...extractRunArtifactManifest(run),
  ]);
}

/** Extract the most recent diff stat from step outputs. */
function extractDiffStatFromSteps(
  steps: readonly { outputs?: Record<string, unknown> | undefined }[],
): DiffStat | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const raw = steps[i].outputs?.diffStat;
    if (!raw || typeof raw !== 'object') continue;
    if (!('files' in raw) || !('additions' in raw) || !('deletions' in raw)) continue;
    const { files, additions, deletions } = raw;
    if (typeof files === 'number' && typeof additions === 'number' && typeof deletions === 'number')
      return { files, additions, deletions };
  }
  return undefined;
}

/**
 * The eval catalog's counts of a run's artifacts: each step's `outputs.artifacts` entries, once
 * per step and path, classified by purpose and path. The catalog counted this way before
 * run.list rows left step artifacts out; the gateway now counts for it from the full run.
 */
export function runCatalogCounts(
  steps: readonly Pick<RunStep, 'name' | 'outputs'>[],
): RunCatalogCounts {
  const seen = new Set<string>();
  const summary: RunCatalogCounts = {
    artifactCount: 0,
    artifactBytes: 0,
    visualEvidenceCount: 0,
    validationEvidenceCount: 0,
    reviewEvidenceCount: 0,
  };
  for (const step of steps) {
    const artifacts = step.outputs?.artifacts;
    if (!Array.isArray(artifacts)) continue;
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== 'object' || !('path' in artifact)) continue;
      const path: unknown = artifact.path;
      if (typeof path !== 'string' || !path.trim()) continue;
      const key = `${step.name}:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      summary.artifactCount += 1;
      const sizeBytes: unknown = 'sizeBytes' in artifact ? artifact.sizeBytes : undefined;
      if (typeof sizeBytes === 'number') summary.artifactBytes += sizeBytes;
      const recorded: unknown = 'purpose' in artifact ? artifact.purpose : undefined;
      const purpose = typeof recorded === 'string' ? recorded.toLowerCase() : '';
      const pathLower = path.toLowerCase();
      if (/screenshot|video|visual/.test(purpose) || isRunArtifactMediaPath(pathLower))
        summary.visualEvidenceCount += 1;
      if (
        /recipe|validation|report|summary|trace|coverage|manifest/.test(purpose) ||
        /recipe|validation|report|summary|trace|coverage|manifest/.test(pathLower)
      )
        summary.validationEvidenceCount += 1;
      if (/review|comment/.test(purpose) || /review|comment/.test(pathLower))
        summary.reviewEvidenceCount += 1;
    }
  }
  return summary;
}

/**
 * The step-output artifacts a run.list row keeps for a client that computes list values from
 * the row itself (a build from before the served summary): videos, before/after visuals and
 * diff files, each as its path, purpose and size. From them such a client shows the same video
 * and compare chips and opens the same Diff file as from the row it used to get; its artifact
 * counts read lower until it updates. A step whose artifacts are of none of those kinds keeps
 * its first one, so those counts are never zero for a step that has evidence. At most `limit`
 * entries are kept.
 */
export function listStepArtifacts(
  outputs: Record<string, unknown> | undefined,
  limit: number,
): RunListStepArtifact[] {
  const entries: RunArtifactManifestEntry[] = [];
  collectRunArtifactEntries(outputs, entries);
  const kept = dedupeRunArtifacts(entries).filter(
    (entry) =>
      isRunEvidenceVideoArtifact(entry) ||
      (isRunEvidenceVisualArtifact(entry) && runEvidenceVisualArtifactKind(entry) !== null) ||
      diffArtifactScore(entry) > 0,
  );
  if (kept.length === 0) {
    const recorded: RunArtifactManifestEntry[] = [];
    collectRunArtifactEntries(outputs?.artifacts, recorded);
    kept.push(...recorded.slice(0, 1));
  }
  return kept.slice(0, limit).map(({ path, purpose, sizeBytes }) => ({
    path,
    purpose,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  }));
}

/**
 * The evidence summary computed from what `run` carries. The gateway computes it from the full
 * run and serves it on each run.list row; clients read a row's summary with
 * `runListEvidenceSummary`.
 */
export function summarizeRunEvidence(run: RunEvidenceSource): RunEvidenceSummary {
  const runArtifacts = extractRunArtifactManifest(run);
  // Same set as runEvidenceArtifacts, without extracting the run's artifacts twice.
  const artifacts = dedupeRunArtifacts([
    ...(run.liveRecipeContext?.artifactManifest ?? []),
    ...runArtifacts,
  ]);
  return {
    artifactCount: artifacts.length,
    videoCount: artifacts.filter(isRunEvidenceVideoArtifact).length,
    visualPairCount: countRunEvidenceVisualPairs(artifacts),
    diffStat: extractDiffStatFromSteps(run.steps),
    catalogCounts: runCatalogCounts(run.steps),
    diffArtifactPath: diffArtifactCandidate(runArtifacts)?.path,
  };
}

/** The best-ranked diff file among `artifacts`: what a run's Diff action opens. */
export function diffArtifactCandidate<T extends { path: string; purpose?: string }>(
  artifacts: readonly T[],
): T | undefined {
  const ranked = artifacts
    .map((artifact) => ({ artifact, score: diffArtifactScore(artifact) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.artifact;
}

function diffArtifactScore(artifact: { path: string; purpose?: string }): number {
  const lowerPath = artifact.path.toLowerCase();
  const lowerPurpose = artifact.purpose?.toLowerCase() ?? '';
  if (lowerPath === 'artifacts/diff.txt') return 100;
  if (lowerPath.endsWith('/diff.txt')) return 95;
  if (/\.(diff|patch)$/.test(lowerPath)) return 90;
  if (lowerPath.endsWith('.json')) return 0;
  if (lowerPurpose.includes('diff')) return 60;
  return 0;
}

/** What `runListEvidenceSummary` reads from a run.list row. */
export type RunListEvidenceSource = Pick<
  RunListRow,
  'decisions' | 'steps' | 'output' | 'liveRecipeContext' | 'evidenceSummary'
>;

/**
 * A run.list row's evidence summary: the one the gateway computed from the full run, or, on a
 * row cached before the gateway served one, the summary computed from the row itself.
 */
export function runListEvidenceSummary(row: RunListEvidenceSource): RunEvidenceSummary {
  return row.evidenceSummary ?? summarizeRunEvidence(row);
}

export function isRunEvidenceImageArtifact(entry: Pick<EvidenceManifestEntry, 'path'>): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i.test(entry.path);
}

/** Canonical "is this evidence displayable" check — image or video. Single
 * source of truth for visual evidence formats across gateway and UI surfaces. */
export function isRunEvidenceVisualArtifact(entry: Pick<EvidenceManifestEntry, 'path'>): boolean {
  return isRunEvidenceImageArtifact(entry) || isRunEvidenceVideoArtifact(entry);
}

export function runArtifactPathsToManifest(paths: readonly string[]): RunArtifactManifestEntry[] {
  return paths.map((path) => ({ path, purpose: inferRunArtifactPurpose(path) }));
}

export function inferRunArtifactPurpose(path: string): string {
  const normalized = path.toLowerCase();
  if (/\.(diff|patch)$/.test(normalized)) return 'diff';
  if (normalized.includes('screenshot')) return 'screenshot';
  if (isRunEvidenceVideoArtifact({ path })) return 'video';
  if (isRunArtifactImagePath(path)) return 'image';
  if (/diff[_-]?stat/i.test(normalized)) return 'diff-stat';
  if (/\/diff\.(txt|md)$/i.test(normalized)) return 'diff';
  if (normalized.includes('review')) return 'review';
  if (normalized.includes('report')) return 'report';
  if (normalized.includes('recipe')) return 'recipe';
  return 'artifact';
}

function collectRunArtifactEntries(value: unknown, entries: RunArtifactManifestEntry[]): void {
  if (value == null) return;
  if (typeof value === 'string') {
    // A bare string is an artifact only as a relative path, never prose or a host path.
    if (!/\s/.test(value) && isRelativeArtifactPath(value) && looksLikeRunArtifactPath(value)) {
      entries.push({ path: value, purpose: inferRunArtifactPurpose(value) });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectRunArtifactEntries(item, entries));
    return;
  }
  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (typeof record.path === 'string' && looksLikeRunArtifactEntry(record)) {
    entries.push({
      path: record.path,
      purpose:
        typeof record.purpose === 'string' ? record.purpose : inferRunArtifactPurpose(record.path),
      ...(typeof record.sizeBytes === 'number' ? { sizeBytes: record.sizeBytes } : {}),
      ...(typeof record.type === 'string' ? { type: record.type } : {}),
      ...(typeof record.label === 'string' ? { label: record.label } : {}),
      ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
      ...(typeof record.sha256 === 'string' ? { sha256: record.sha256 } : {}),
      ...(typeof record.timelinePath === 'string' ? { timelinePath: record.timelinePath } : {}),
      ...(typeof record.timelineUnavailableReason === 'string'
        ? { timelineUnavailableReason: record.timelineUnavailableReason }
        : {}),
    });
  }

  Object.values(record).forEach((item) => collectRunArtifactEntries(item, entries));
}

function looksLikeRunArtifactEntry(record: Record<string, unknown>): boolean {
  const path = record.path;
  if (typeof path !== 'string' || !isRelativeArtifactPath(path)) return false;
  return (
    typeof record.purpose === 'string' ||
    typeof record.type === 'string' ||
    typeof record.mimeType === 'string' ||
    looksLikeRunArtifactPath(path)
  );
}

function looksLikeRunArtifactPath(value: string): boolean {
  return isRunArtifactMediaPath(value) || /\.(md|json|txt|log|diff|patch)$/i.test(value);
}

function countRunEvidenceVisualPairs(entries: EvidenceManifestEntry[]): number {
  const buckets = new Map<
    string,
    { before?: EvidenceManifestEntry; after?: EvidenceManifestEntry }
  >();
  for (const entry of entries) {
    if (!isRunEvidenceVisualArtifact(entry)) continue;
    const kind = runEvidenceVisualArtifactKind(entry);
    if (!kind) continue;
    const key = runEvidenceVisualPairKey(entry.path);
    const bucket = buckets.get(key) ?? {};
    bucket[kind] = entry;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].filter((bucket) => bucket.before && bucket.after).length;
}

function runEvidenceVisualArtifactKind(entry: EvidenceManifestEntry): 'before' | 'after' | null {
  const purpose = entry.purpose.toLowerCase();
  if (/\b(before|baseline|reference)\b/.test(purpose)) return 'before';
  if (/\b(after|current|candidate)\b/.test(purpose)) return 'after';
  const normalizedPath = entry.path.toLowerCase();
  if (/\b(before|baseline|reference)\b/.test(normalizedPath)) return 'before';
  if (/\b(after|current|candidate)\b/.test(normalizedPath)) return 'after';
  return null;
}

function runEvidenceVisualPairKey(pathValue: string): string {
  const base = pathBasename(pathValue);
  const ext = (base.match(/\.[^.]+$/) ?? [''])[0].toLowerCase();
  const stem = (ext ? base.slice(0, -ext.length) : base)
    .replace(/^(before|baseline|reference|after|current|candidate)[-_.]*/i, '')
    .replace(/^evidence-/i, '')
    .replace(/[-_.]*(before|baseline|reference|after|current|candidate)$/i, '');
  return `${pathDirname(pathValue)}::${stem || base}::${ext}`;
}

function pathBasename(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').split('/').pop() ?? pathValue;
}

function pathDirname(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '.';
}

/** One entry per path; the most specific purpose and the latest retention metadata win. */
export function dedupeRunArtifacts<T extends RunArtifactManifestEntry>(entries: readonly T[]): T[] {
  const merged = new Map<string, T>();
  for (const entry of entries) {
    const existing = merged.get(entry.path);
    merged.set(entry.path, existing ? mergeRunArtifactMetadata(existing, entry) : entry);
  }
  return [...merged.values()];
}

const LATEST_RUN_ARTIFACT_FIELDS = [
  'sha256',
  'timelinePath',
  'timelineUnavailableReason',
  'bundleDigest',
] as const;

function mergeRunArtifactMetadata<T extends RunArtifactManifestEntry>(existing: T, incoming: T): T {
  const merged = { ...existing };
  for (const key of LATEST_RUN_ARTIFACT_FIELDS) {
    if (incoming[key] !== undefined) merged[key] = incoming[key];
  }
  const incomingIsMoreSpecific =
    runArtifactPurposeSpecificity(incoming.purpose) >
    runArtifactPurposeSpecificity(existing.purpose);
  if (incomingIsMoreSpecific) merged.purpose = incoming.purpose;
  const fixed = new Set<keyof T>(['path', 'purpose', ...LATEST_RUN_ARTIFACT_FIELDS]);
  for (const key of Object.keys(incoming) as Array<keyof T>) {
    if (fixed.has(key) || incoming[key] === undefined) continue;
    if (merged[key] === undefined || incomingIsMoreSpecific) merged[key] = incoming[key];
  }
  return merged;
}

const NEUTRAL_VISUAL_PURPOSES = new Set([
  'image',
  'screenshot',
  'debug-screenshot',
  'video',
  'visual',
]);

function runArtifactPurposeSpecificity(purpose: string): number {
  if (/\b(before|after|current|candidate|baseline|reference)\b/.test(purpose)) return 3;
  if (purpose === 'other') return 0;
  if (!NEUTRAL_VISUAL_PURPOSES.has(purpose) && purpose !== 'artifact') return 2;
  if (purpose === 'artifact') return 0;
  return 1;
}
