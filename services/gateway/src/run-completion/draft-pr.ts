// run-completion/draft-pr.ts — local-first draft PR title/body and evidence preview helpers.

import path from 'node:path';

import { type ArtifactRef, isPublishEvidenceArtifact, type Run } from '@farmslot/protocol';

import { inferArtifactPurpose } from '../core/index.js';

import {
  autoDetectEvidenceManifest,
  buildEvidenceSection,
  type EvidenceManifest,
  evidenceManifestArtifactPaths,
} from './evidence-manifest.js';
import { evidenceKeyVariants } from './evidence-paths.js';
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
    .replace(/^\[(core|extension|mobile|mm[em])\]\s*[:—-]?\s*/i, '')
    .replace(/[.\s]+$/, '');
}

export function buildDraftPrTitle(run: Run): string {
  const commitType = run.flowType === 'fix-bug' ? 'fix' : run.flowType === 'dev' ? 'feat' : 'chore';
  const scope = inferDraftPrTitleScope(run);
  const scopePart = scope ? `(${scope})` : '';
  const rawTitle = run.ticketData?.title?.trim();
  if (rawTitle) {
    const sanitized = sanitizeDraftPrTitleDescription(rawTitle);
    const desc = sanitized.charAt(0).toLowerCase() + sanitized.slice(1);
    return `${commitType}${scopePart}: ${desc}`;
  }
  const fallbackSubject =
    run.flowType === 'fix-bug' ? 'bug' : run.flowType === 'dev' ? 'feature' : 'work';
  const ticket = run.ticketOrPr && !run.ticketOrPr.includes('#') ? run.ticketOrPr : fallbackSubject;
  const verb = commitType === 'fix' ? 'resolve' : 'implement';
  return `${commitType}${scopePart}: ${verb} ${ticket}`;
}

function buildLocalArtifactUrlMaps(artifacts: ArtifactRef[]): {
  manifestUrls: Map<string, string>;
  detectionUrls: Map<string, string>;
} {
  const manifestUrls = new Map<string, string>();
  const detectionUrls = new Map<string, string>();
  for (const artifact of artifacts) {
    const normalized = artifact.path.replace(/\\/g, '/');
    const basename = path.posix.basename(normalized);
    manifestUrls.set(normalized, normalized);
    if (!manifestUrls.has(basename)) manifestUrls.set(basename, normalized);
    if (!detectionUrls.has(basename)) detectionUrls.set(basename, normalized);
  }
  return { manifestUrls, detectionUrls };
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
  const variantsToPath = new Map<string, string>();
  const remember = (artifact: ArtifactRef) => {
    merged.set(artifact.path, artifact);
    for (const variant of evidenceKeyVariants(artifact.path)) {
      if (!variantsToPath.has(variant)) variantsToPath.set(variant, artifact.path);
    }
  };
  for (const artifact of artifacts) remember(artifact);

  for (const manifestPath of evidenceManifestArtifactPaths(manifest)) {
    const existingPath = evidenceKeyVariants(manifestPath)
      .map((variant) => variantsToPath.get(variant))
      .find((value): value is string => typeof value === 'string');
    const existing = existingPath ? merged.get(existingPath) : undefined;
    const next: ArtifactRef = {
      ...(existing ?? {}),
      path: manifestPath,
      purpose: trustedEvidencePurpose(manifestPath, existing?.purpose),
    };
    if (existingPath && existingPath !== manifestPath) merged.delete(existingPath);
    remember(next);
  }

  return [...merged.values()];
}

export function isEvidenceManifestReferencedArtifact(
  artifactPath: string,
  manifest: EvidenceManifest | null | undefined,
): boolean {
  const referenced = new Set(evidenceManifestArtifactPaths(manifest).flatMap(evidenceKeyVariants));
  return evidenceKeyVariants(artifactPath).some((variant) => referenced.has(variant));
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
  const evidenceSection = buildEvidenceSection(manifest, manifestUrls);
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
  const summaryIndex = summaryIndexes.length > 1 ? summaryIndexes[1] : summaryIndexes[0];
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
  const existing =
    (await readTaskArtifactText(run, 'pr-description.md')) ??
    (await readTaskArtifactText(run, 'pr-body.md'));
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
