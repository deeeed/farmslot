// run-completion/draft-pr.ts — local-first draft PR title/body and evidence preview helpers.

import path from 'node:path';

import { type ArtifactRef, isPublishEvidenceArtifact, type Run } from '@farmslot/protocol';

import { getProjectField, inferArtifactPurpose } from '../core/index.js';
import { loadProjectVarsOrNull } from '../run-engine/project-vars.js';

import {
  autoDetectEvidenceManifest,
  buildEvidenceSection,
  type EvidenceManifest,
  evidenceManifestArtifactPaths,
} from './evidence-manifest.js';
import { exactEvidenceKeys } from './evidence-paths.js';
import { PR_BODY_ARTIFACT, PR_PROSE_ARTIFACT, renderPrBody } from './pr-body-render.js';
import { readEvidenceManifest, replaceMarkdownSection } from './publication-artifacts.js';
import { readTaskArtifactText } from './retrospective.js';

function inferDraftPrTitleScope(run: Run): string {
  const text = [run.ticketData?.title, run.ticketData?.description, run.branch, run.summary]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
  if (/\bperps?\b/i.test(text)) return 'perps';
  return '';
}

function sanitizeDraftPrTitleDescription(rawTitle: string): string {
  return rawTitle
    .trim()
    .replace(/^\[(core|extension|mobile|terminal|mm[em])\]\s*[:—-]?\s*/i, '')
    .replace(/[.\s]+$/, '');
}

export function buildDraftPrTitle(run: Run): string {
  const commitType = run.flowType === 'fix-bug' ? 'fix' : run.flowType === 'dev' ? 'feat' : 'chore';
  const scope = inferDraftPrTitleScope(run);
  const scopePart = scope ? `(${scope})` : '';
  const rawTitle = run.ticketData?.title?.trim();
  if (rawTitle) {
    const sanitized = sanitizeDraftPrTitleDescription(rawTitle);
    // Lower-case a leading word, never a ticket key (`TAT-4037`).
    const desc = /^[A-Z][A-Z0-9]*-\d+/.test(sanitized)
      ? sanitized
      : sanitized.charAt(0).toLowerCase() + sanitized.slice(1);
    return `${commitType}${scopePart}: ${desc}`;
  }
  const fallbackSubject =
    run.flowType === 'fix-bug' ? 'bug' : run.flowType === 'dev' ? 'feature' : 'work';
  const ticket = run.ticketOrPr && !run.ticketOrPr.includes('#') ? run.ticketOrPr : fallbackSubject;
  const verb = commitType === 'fix' ? 'resolve' : 'implement';
  return `${commitType}${scopePart}: ${verb} ${ticket}`;
}

// A basename stands for an artifact only when no other artifact shares it:
// `a/menu.png` and `b/menu.png` never resolve through `menu.png`.
function buildLocalArtifactUrlMaps(artifacts: ArtifactRef[]): {
  manifestUrls: Map<string, string>;
  detectionUrls: Map<string, string>;
} {
  const manifestUrls = new Map<string, string>();
  const detectionUrls = new Map<string, string>();
  const paths = [...new Set(artifacts.map((artifact) => artifact.path.replace(/\\/g, '/')))].sort();
  const byBasename = groupByBasename(paths);
  for (const normalized of paths) {
    const basename = path.posix.basename(normalized);
    const unique = byBasename.get(basename)!.length === 1;
    manifestUrls.set(normalized, normalized);
    if (unique && !manifestUrls.has(basename)) manifestUrls.set(basename, normalized);
    detectionUrls.set(unique ? basename : normalized, normalized);
  }
  return { manifestUrls, detectionUrls };
}

function groupByBasename(paths: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const artifactPath of paths) {
    const basename = path.posix.basename(artifactPath);
    groups.set(basename, [...(groups.get(basename) ?? []), artifactPath]);
  }
  return groups;
}

/**
 * Manifest paths that match no artifact exactly and whose basename is shared
 * by more than one artifact, with the artifacts they could mean, sorted.
 */
export function ambiguousEvidenceManifestPaths(
  artifacts: ArtifactRef[],
  manifest: EvidenceManifest | null | undefined,
): Array<{ path: string; matches: string[] }> {
  const paths = new Set(artifacts.map((artifact) => artifact.path));
  const byBasename = groupByBasename([...paths].sort());
  return evidenceManifestArtifactPaths(manifest).flatMap((manifestPath) => {
    if (exactEvidenceKeys(manifestPath).some((key) => paths.has(key))) return [];
    const matches = byBasename.get(path.posix.basename(manifestPath)) ?? [];
    return matches.length > 1 ? [{ path: manifestPath, matches }] : [];
  });
}

function trustedEvidencePurpose(artifactPath: string, fallbackPurpose?: string): string {
  const relative = artifactPath.replace(/\\/g, '/').replace(/^artifacts\//, '');
  const inferred = inferArtifactPurpose(relative);
  if (inferred === 'debug-screenshot') return 'screenshot';
  return fallbackPurpose && fallbackPurpose !== 'debug-screenshot' ? fallbackPurpose : inferred;
}

export function mergeEvidenceManifestArtifactRefs(
  artifacts: ArtifactRef[],
  manifest: EvidenceManifest | null | undefined,
): ArtifactRef[] {
  const merged = new Map<string, ArtifactRef>();
  for (const artifact of artifacts) merged.set(artifact.path, artifact);
  const byBasename = groupByBasename([...merged.keys()].sort());
  const ambiguous = new Set(
    ambiguousEvidenceManifestPaths(artifacts, manifest).map((entry) => entry.path),
  );
  const claimed = new Set<string>();

  for (const manifestPath of evidenceManifestArtifactPaths(manifest)) {
    // An ambiguous name picks no artifact; the preview warns about it instead.
    if (ambiguous.has(manifestPath)) continue;
    const sameName = byBasename.get(path.posix.basename(manifestPath)) ?? [];
    const existingPath =
      exactEvidenceKeys(manifestPath).find((key) => merged.has(key)) ??
      (sameName.length === 1 && merged.has(sameName[0]) && !claimed.has(sameName[0])
        ? sameName[0]
        : undefined);
    const existing = existingPath ? merged.get(existingPath) : undefined;
    const next: ArtifactRef = {
      ...(existing ?? {}),
      path: manifestPath,
      purpose: trustedEvidencePurpose(manifestPath, existing?.purpose),
    };
    if (existingPath && existingPath !== manifestPath) merged.delete(existingPath);
    merged.set(manifestPath, next);
    claimed.add(manifestPath);
  }

  return [...merged.values()];
}

export function isEvidenceManifestReferencedArtifact(
  artifactPath: string,
  manifest: EvidenceManifest | null | undefined,
): boolean {
  const referenced = new Set(evidenceManifestArtifactPaths(manifest).flatMap(exactEvidenceKeys));
  return exactEvidenceKeys(artifactPath).some((variant) => referenced.has(variant));
}

export function isPackageSelectableEvidenceArtifact(
  artifact: Pick<ArtifactRef, 'path' | 'purpose'>,
  manifest: EvidenceManifest | null | undefined,
): boolean {
  return (
    isPublishEvidenceArtifact(artifact) ||
    isEvidenceManifestReferencedArtifact(artifact.path, manifest)
  );
}

// Without an artifacts repo nothing gets uploaded, so a local image preview
// would publish as broken images. Unknown config keeps the image preview.
async function projectHasNoArtifactsRepo(run: Run): Promise<boolean> {
  const pv = await loadProjectVarsOrNull(run.project, 'draft evidence preview', run.id);
  return pv !== null && !getProjectField(pv.projectJson, 'artifacts_repo');
}

function buildUnhostedEvidenceSection(run: Run, manifest: EvidenceManifest): string | null {
  const names = [
    ...new Set(evidenceManifestArtifactPaths(manifest).map((p) => path.posix.basename(p))),
  ];
  if (names.length === 0) return null;
  return [
    `Not embedded: this project has no artifacts repo to host them. They are in the Farmslot run \`${run.id.slice(0, 8)}\` evidence:`,
    '',
    ...names.map((name) => `- \`${name}\``),
  ].join('\n');
}

async function applyLocalEvidencePreview(
  run: Run,
  body: string,
  artifacts: ArtifactRef[],
): Promise<string> {
  const manifestFromFile = await readEvidenceManifest(run);
  const previewArtifacts = mergeEvidenceManifestArtifactRefs(artifacts, manifestFromFile);
  const { manifestUrls, detectionUrls } = buildLocalArtifactUrlMaps(previewArtifacts);
  const manifest = manifestFromFile ?? autoDetectEvidenceManifest(detectionUrls);
  if (!manifest) return body;
  const section = (await projectHasNoArtifactsRepo(run))
    ? buildUnhostedEvidenceSection(run, manifest)
    : buildEvidenceSection(manifest, manifestUrls);
  const warnings = ambiguousEvidenceManifestPaths(artifacts, manifestFromFile).map(
    (entry) => `ambiguous evidence path ${entry.path}: matches ${entry.matches.join(', ')}`,
  );
  for (const warning of warnings)
    console.warn(`[run-completion] run ${run.id.slice(0, 8)} — ${warning}`);
  const evidenceSection = [section, ...warnings.map((warning) => `> ${warning}`)]
    .filter(Boolean)
    .join('\n\n');
  if (!evidenceSection) return body;
  return replaceMarkdownSection(body, '## **Screenshots/Recordings**', evidenceSection);
}

const PUBLICATION_GATE_METADATA_PATTERNS: RegExp[] = [
  /^artifacts\/independent-review-\d+\.(?:json|md)$/,
  /^artifacts\/self-review-\d+\.(?:json|md)$/,
  /^artifacts\/review-loop-\d+\//,
  /^artifacts\/publication-gate-/,
  /^artifacts\/pr-package\.(?:json|md)$/,
  /^artifacts\/session-metrics\.json$/,
];

export function isPublicationGateMetadataArtifact(artifactPath: string): boolean {
  return PUBLICATION_GATE_METADATA_PATTERNS.some((pattern) => pattern.test(artifactPath));
}

function stripExecutionPreamble(rawBody: string): string {
  const lines = rawBody.trim().split('\n');
  const summaryIndexes = lines
    .map((line, index) => (/^## Summary\s*$/i.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const summaryIndex = summaryIndexes[0];
  if (summaryIndex === undefined || summaryIndex <= 0) return rawBody.trim();

  const preamble = lines.slice(0, summaryIndex).join('\n');
  const isExecutionPreamble =
    /^#\s+\S/m.test(preamble) &&
    /^\*\*Branch:\*\*/m.test(preamble) &&
    /^\*\*Commit:\*\*/m.test(preamble);
  return isExecutionPreamble ? lines.slice(summaryIndex).join('\n').trim() : rawBody.trim();
}

export async function buildDraftPrBody(
  run: Run,
  report: string | null,
  artifacts: ArtifactRef[],
): Promise<string> {
  // The pack's renderer (when declared) turns the authored prose plus the
  // recipe and run artifacts into the body that is published; the render is
  // used as returned, never read back from the mirror, where a refresh may
  // have put the worker's own pr-body.md. Without a renderer the authored file
  // is the body, as before. Approval re-renders the same way.
  const render = await renderPrBody(run);
  if (!render.rendered) {
    console.log(`[run-completion] pr-body not rendered for run ${run.id}: ${render.reason}`);
  }
  const existing = render.rendered
    ? render.body
    : ((await readTaskArtifactText(run, PR_PROSE_ARTIFACT)) ??
      (await readTaskArtifactText(run, PR_BODY_ARTIFACT)));
  if (existing?.trim()) {
    return applyLocalEvidencePreview(run, stripExecutionPreamble(existing), artifacts);
  }
  const publishableArtifacts = artifacts.filter(
    (artifact) => !isPublicationGateMetadataArtifact(artifact.path),
  );
  const artifactList = publishableArtifacts.length
    ? publishableArtifacts.map((artifact) => `- ${artifact.path} (${artifact.purpose})`).join('\n')
    : '- No artifacts copied';
  const normalizedReport = report?.trim() ? stripExecutionPreamble(report) : null;
  const summary = normalizedReport ?? `Local-first package prepared for ${run.ticketOrPr}.`;
  const body = [
    ...(summary.startsWith('## Summary') ? [summary] : ['## Summary', summary]),
    '',
    '## Validation / Evidence',
    artifactList,
    '',
    '<!-- Published by Farmslot after human approval. -->',
  ].join('\n');
  return applyLocalEvidencePreview(run, body, artifacts);
}
