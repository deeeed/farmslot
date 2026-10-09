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
import { evidenceKeyVariants } from './evidence-paths.js';
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
  const evidenceSection = (await projectHasNoArtifactsRepo(run))
    ? buildUnhostedEvidenceSection(run, manifest)
    : buildEvidenceSection(manifest, manifestUrls);
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
