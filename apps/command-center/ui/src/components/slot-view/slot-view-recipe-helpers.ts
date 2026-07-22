import type {
  ArtifactRef,
  EvidenceManifestStandalone,
  RecipeRunArtifactGroup,
} from '@farmslot/protocol';

function artifactMimeType(artifact: ArtifactRef): string {
  return artifact.mimeType?.toLowerCase().trim() ?? '';
}

function artifactType(artifact: ArtifactRef): string {
  return artifact.type?.toLowerCase().trim() ?? '';
}

export function isVideoRecipeArtifact(artifact: ArtifactRef): boolean {
  const mimeType = artifactMimeType(artifact);
  return (
    artifactType(artifact) === 'video' ||
    mimeType.startsWith('video/') ||
    /\.(mp4|mov|webm)$/i.test(artifact.path)
  );
}

export function isImageRecipeArtifact(artifact: ArtifactRef): boolean {
  const mimeType = artifactMimeType(artifact);
  return (
    artifactType(artifact) === 'screenshot' ||
    mimeType.startsWith('image/') ||
    /\.(png|jpg|jpeg|gif)$/i.test(artifact.path)
  );
}

export function isVisualRecipeArtifact(artifact: ArtifactRef): boolean {
  return isImageRecipeArtifact(artifact) || isVideoRecipeArtifact(artifact);
}

export interface SlotViewRecipeEvidenceResult {
  allArtifacts: ArtifactRef[];
  effectiveArtifacts: ArtifactRef[];
  hiddenDiagnosticCount: number;
  usedCuratedManifest: boolean;
  usedTypedManifest: boolean;
}

export function selectedRecipeRunRequestId(
  selectedRun: Pick<RecipeRunArtifactGroup, 'id' | 'groupKind'> | null | undefined,
): string | undefined {
  if (!selectedRun || selectedRun.groupKind === 'current-artifacts') return undefined;
  return selectedRun.id;
}

export function buildRecipeActionRequestParams(args: {
  runId: string;
  slotId: string;
  recipeArtifactPath?: string;
  selectedRun: Pick<RecipeRunArtifactGroup, 'id' | 'groupKind'> | null | undefined;
}): { runId: string; slotId: string; recipeArtifactPath?: string; recipeRunId?: string } {
  const params: {
    runId: string;
    slotId: string;
    recipeArtifactPath?: string;
    recipeRunId?: string;
  } = {
    runId: args.runId,
    slotId: args.slotId,
  };
  if (args.recipeArtifactPath) params.recipeArtifactPath = args.recipeArtifactPath;
  const recipeRunId = selectedRecipeRunRequestId(args.selectedRun);
  if (recipeRunId) params.recipeRunId = recipeRunId;
  return params;
}

export function canShowRecipeExecutionControls(canRerun: boolean): boolean {
  return canRerun;
}

export function effectiveRecipeJsonForSelection({
  selectedRecipeDependencyJson,
  recipeHostRecipeJson,
  packageRunRecipeJson,
}: {
  selectedRecipeDependencyJson: string | null | undefined;
  recipeHostRecipeJson: string | null | undefined;
  packageRunRecipeJson: string | null | undefined;
}): string | null {
  if (selectedRecipeDependencyJson) return selectedRecipeDependencyJson;
  if (recipeHostRecipeJson) return recipeHostRecipeJson;
  return packageRunRecipeJson ?? null;
}

function normalizeArtifactPath(pathValue: string): string {
  return pathValue.replaceAll('\\', '/');
}

function escapeRegExp(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesArtifactCandidate(artifactPath: string, candidate: string): boolean {
  const normalizedArtifactPath = normalizeArtifactPath(artifactPath);
  const normalizedCandidate = normalizeArtifactPath(candidate);
  return (
    normalizedArtifactPath === normalizedCandidate ||
    normalizedArtifactPath.endsWith(`/${normalizedCandidate}`)
  );
}

const MANIFEST_EVIDENCE_FILE_EXTENSIONS = [
  // Include the empty suffix so recipe node filenames that already include
  // their extension, or manifest entries that are bare stems, can match exactly.
  '',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.mp4',
  '.mov',
  '.webm',
  '.json',
  '.md',
] as const;
const MANIFEST_VIDEO_FILE_EXTENSION = /\.(mp4|mov|webm)$/i;

function matchesArtifactCandidateWithKnownExtension(
  artifactPath: string,
  candidate: string,
): boolean {
  return MANIFEST_EVIDENCE_FILE_EXTENSIONS.some((extension) =>
    matchesArtifactCandidate(artifactPath, `${candidate}${extension}`),
  );
}

function matchesNodeToken(value: string, nodeId: string): boolean {
  const normalizedValue = value.toLowerCase();
  const normalizedNodeId = nodeId.toLowerCase();
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedNodeId)}($|[^a-z0-9])`);
  return pattern.test(normalizedValue);
}

function matchesManifestEvidenceFile(entryFile: string, filename: string): boolean {
  // Keep manifest-entry matching named separately from artifact-path matching:
  // callers compare manifest files against recipe node filenames that often omit extensions.
  return matchesArtifactCandidateWithKnownExtension(entryFile, filename);
}

function labelForManifestVideoKey(key: string): string {
  const label = key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  return `${label || 'Video'} recording`;
}

export interface EvidenceManifestParseResult {
  entries: EvidenceManifestStandalone[];
  droppedVideoEntryCount: number;
}

export function parseEvidenceManifestEntriesWithDiagnostics(
  json: unknown,
): EvidenceManifestParseResult {
  if (!json || typeof json !== 'object') return { entries: [], droppedVideoEntryCount: 0 };
  const root = json as {
    before_after_pairs?: unknown;
    standalone?: unknown;
    videos?: unknown;
  };
  const entries: EvidenceManifestStandalone[] = [];
  let droppedVideoEntryCount = 0;
  if (Array.isArray(root.before_after_pairs)) {
    for (const entry of root.before_after_pairs) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as { label?: unknown; before?: unknown; after?: unknown; note?: unknown };
      const label = typeof row.label === 'string' ? row.label : 'Before/after evidence';
      const note = typeof row.note === 'string' ? row.note : undefined;
      if (typeof row.before === 'string') {
        entries.push({ label: `${label} — before`, file: row.before, ...(note ? { note } : {}) });
      }
      if (typeof row.after === 'string') {
        entries.push({ label: `${label} — after`, file: row.after, ...(note ? { note } : {}) });
      }
    }
  }
  if (Array.isArray(root.standalone)) {
    for (const entry of root.standalone) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as { label?: unknown; file?: unknown; note?: unknown };
      if (typeof row.label !== 'string' || typeof row.file !== 'string') continue;
      entries.push({
        label: row.label,
        file: row.file,
        ...(typeof row.note === 'string' ? { note: row.note } : {}),
      });
    }
  }
  if (root.videos && typeof root.videos === 'object') {
    const videos = root.videos as Record<string, unknown>;
    for (const key of Object.keys(videos)) {
      if (key === 'note' || key === 'preferred') continue;
      const file = videos[key];
      if (typeof file !== 'string' || !file.trim() || !MANIFEST_VIDEO_FILE_EXTENSION.test(file)) {
        droppedVideoEntryCount += 1;
        continue;
      }
      entries.push({
        label: labelForManifestVideoKey(key),
        file,
        // The manifest schema has one note for the recording group, so each
        // emitted before/after/video entry intentionally shares it.
        ...(typeof videos.note === 'string' ? { note: videos.note } : {}),
      });
    }
  }
  const seenFiles = new Set<string>();
  return {
    entries: entries.filter((entry) => {
      if (seenFiles.has(entry.file)) return false;
      seenFiles.add(entry.file);
      return true;
    }),
    droppedVideoEntryCount,
  };
}

export function parseEvidenceManifestEntries(json: unknown): EvidenceManifestStandalone[] {
  return parseEvidenceManifestEntriesWithDiagnostics(json).entries;
}

export function parseRecipeWorkflow(
  recipeJson: string | null | undefined,
): { entry: string; nodes: Record<string, Record<string, unknown>> } | null {
  if (!recipeJson) return null;
  try {
    const parsed = JSON.parse(recipeJson);
    const workflow = parsed?.workflow;
    if (
      !workflow ||
      typeof workflow.entry !== 'string' ||
      !workflow.nodes ||
      typeof workflow.nodes !== 'object'
    )
      return null;
    return workflow;
  } catch {
    return null;
  }
}

function recipeNodeTargets(node: Record<string, unknown>): string[] {
  if (node.cases && typeof node.cases === 'object' && !Array.isArray(node.cases)) {
    const targets: string[] = [];
    for (const target of Object.values(node.cases))
      if (typeof target === 'string') targets.push(target);
    if (typeof node.default === 'string') targets.push(node.default);
    return targets;
  }
  if (typeof node.next === 'string') return [node.next];
  return [];
}

function recipeNodeEvidenceFilename(node: Record<string, unknown>): string | null {
  return typeof node.filename === 'string' && node.filename.trim().length > 0
    ? node.filename
    : null;
}

function deriveNearestDownstreamEvidenceNodes(
  nodes: Record<string, Record<string, unknown>>,
  nodeId: string,
): Array<{ nodeId: string; filename: string }> {
  const start = nodes[nodeId];
  if (!start) return [];
  const queue = recipeNodeTargets(start).map((target) => ({ nodeId: target, depth: 1 }));
  const seen = new Set<string>([nodeId]);
  const matches: Array<{ nodeId: string; filename: string; depth: number }> = [];
  let nearestDepth: number | null = null;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.nodeId)) continue;
    if (nearestDepth != null && current.depth > nearestDepth) continue;
    seen.add(current.nodeId);

    const node = nodes[current.nodeId];
    if (!node) continue;
    const filename = recipeNodeEvidenceFilename(node);
    if (filename) {
      matches.push({ nodeId: current.nodeId, filename, depth: current.depth });
      nearestDepth = current.depth;
      continue;
    }
    for (const target of recipeNodeTargets(node)) {
      queue.push({ nodeId: target, depth: current.depth + 1 });
    }
  }

  return matches.map(({ nodeId: id, filename }) => ({ nodeId: id, filename }));
}

export function deriveEvidenceArtifactCandidates(
  recipeJson: string | null | undefined,
  nodeId: string,
): string[] {
  const workflow = parseRecipeWorkflow(recipeJson);
  if (!workflow || !workflow.nodes[nodeId]) return [];
  const node = workflow.nodes[nodeId];
  if (!node || typeof node !== 'object') return [];
  const filename = recipeNodeEvidenceFilename(node);
  if (filename) return [filename];
  return deriveNearestDownstreamEvidenceNodes(workflow.nodes, nodeId).map(
    (match) => match.filename,
  );
}

export function deriveEvidenceNodeCandidates(
  recipeJson: string | null | undefined,
  nodeId: string,
): string[] {
  const workflow = parseRecipeWorkflow(recipeJson);
  if (!workflow || !workflow.nodes[nodeId]) return [];
  const node = workflow.nodes[nodeId];
  if (!node || typeof node !== 'object') return [];
  if (recipeNodeEvidenceFilename(node)) return [nodeId];
  return [
    nodeId,
    ...deriveNearestDownstreamEvidenceNodes(workflow.nodes, nodeId).map((match) => match.nodeId),
  ];
}

export function recipeNodeExists(recipeJson: string | null | undefined, nodeId: string): boolean {
  const workflow = parseRecipeWorkflow(recipeJson);
  return Boolean(workflow?.nodes?.[nodeId]);
}

export function sortRecipeEvidenceArtifacts(artifactManifest: ArtifactRef[]): ArtifactRef[] {
  const artifactOrder: Record<string, number> = {
    'pr-package-md': 0,
    screenshot: 1,
    'video-before': 2,
    'video-after': 2,
    video: 2,
    summary: 3,
    trace: 4,
    report: 5,
    json: 6,
    metric: 7,
    diff: 8,
    log: 9,
    recipe: 10,
    'recipe-quality': 11,
    learnings: 12,
    'pr-package-json': 13,
    other: 14,
    script: 15,
  };
  return [...artifactManifest].sort((a, b) => {
    const orderDelta = (artifactOrder[a.purpose] ?? 99) - (artifactOrder[b.purpose] ?? 99);
    return orderDelta !== 0 ? orderDelta : a.path.localeCompare(b.path);
  });
}

function artifactBasename(artifactPath: string): string {
  return artifactPath.replace(/\\/g, '/').split('/').pop() ?? artifactPath;
}

function artifactPathSegments(artifactPath: string): string[] {
  return normalizeArtifactPath(artifactPath)
    .split('/')
    .filter((segment) => segment.length > 0);
}

function purposeHasPrefix(purpose: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => purpose === prefix || purpose.startsWith(`${prefix}-`));
}

function isRecipeRunnerDefinitionArtifact(artifact: ArtifactRef): boolean {
  const normalizedPath = normalizeArtifactPath(artifact.path);
  const basename = artifactBasename(normalizedPath).toLowerCase();
  if (
    artifact.purpose === 'recipe' ||
    artifact.purpose === 'recipe-quality' ||
    artifact.purpose === 'recipe-coverage' ||
    artifact.purpose === 'learnings' ||
    artifact.purpose === 'artifact-manifest' ||
    artifact.purpose === 'evidence-manifest'
  )
    return true;
  if (
    basename === 'recipe.json' ||
    basename === 'recipe-resolution.json' ||
    basename === 'recipe-quality.json' ||
    basename === 'recipe-coverage.md' ||
    basename === 'learnings.md' ||
    basename === 'artifact-manifest.json' ||
    basename === 'evidence-manifest.json' ||
    basename.endsWith('.recipe.json') ||
    basename.startsWith('recipe-issues')
  )
    return true;
  return normalizedPath.includes('/resolved-recipes/');
}

function isPublicationOrReviewArtifact(artifact: ArtifactRef): boolean {
  const basename = artifactBasename(artifact.path).toLowerCase();
  if (
    purposeHasPrefix(artifact.purpose, [
      'pr-package',
      'pr-description',
      'review-loop',
      'review',
      'line-comments',
    ])
  )
    return true;
  if (
    basename === 'pr-package.md' ||
    basename === 'pr-package.json' ||
    basename === 'pr-description.md' ||
    basename === 'review.md' ||
    basename === 'line-comments.json'
  )
    return true;
  return artifactPathSegments(artifact.path).some((segment) => segment.startsWith('review-loop'));
}

function isRecipeRuntimeEvidenceArtifact(artifact: ArtifactRef): boolean {
  if (isRecipeRunnerDefinitionArtifact(artifact)) return false;
  if (isPublicationOrReviewArtifact(artifact)) return false;
  return true;
}

function isTypedArtifactManifestRef(artifact: ArtifactRef): boolean {
  return typeof artifact.type === 'string';
}

export function normalizeRecipeEvidenceArtifacts(artifactManifest: ArtifactRef[]): ArtifactRef[] {
  const hasPackagePreview = artifactManifest.some(
    (artifact) =>
      artifact.purpose === 'pr-package-md' || artifactBasename(artifact.path) === 'pr-package.md',
  );
  if (!hasPackagePreview) return artifactManifest;
  const hiddenPublicationArtifacts = new Set([
    'pr-description.md',
    'pr-package.md',
    'pr-package.json',
  ]);
  return artifactManifest.filter(
    (artifact) => !hiddenPublicationArtifacts.has(artifactBasename(artifact.path)),
  );
}

export function filterNodeRecipeEvidenceArtifacts(
  allArtifacts: ArtifactRef[],
  recipeJson: string | null | undefined,
  nodeId: string,
  evidenceManifest: EvidenceManifestStandalone[],
  allowNamespacedNodeIds = false,
): ArtifactRef[] {
  const filenames = deriveEvidenceArtifactCandidates(recipeJson, nodeId);
  const nodeCandidates = [
    ...new Set([nodeId, ...deriveEvidenceNodeCandidates(recipeJson, nodeId)]),
  ];
  const typedMatches = allArtifacts.filter((artifact) => {
    const artifactNodeId = artifact.nodeId;
    return (
      typeof artifactNodeId === 'string' &&
      nodeCandidates.some((candidate) =>
        allowNamespacedNodeIds
          ? artifactNodeId.endsWith(`/${candidate}`)
          : artifactNodeId === candidate,
      )
    );
  });
  if (typedMatches.length > 0) return typedMatches;
  const manifestMatches = evidenceManifest
    .filter(
      (entry) =>
        nodeCandidates.some(
          (candidate) =>
            matchesNodeToken(entry.label, candidate) || matchesNodeToken(entry.file, candidate),
        ) || filenames.some((filename) => matchesManifestEvidenceFile(entry.file, filename)),
    )
    .map((entry) => entry.file);

  return allArtifacts.filter((artifact) =>
    [...filenames, ...manifestMatches].some((filename) =>
      matchesArtifactCandidateWithKnownExtension(artifact.path, filename),
    ),
  );
}

export function filterManifestRecipeEvidenceArtifacts(
  allArtifacts: ArtifactRef[],
  evidenceManifest: EvidenceManifestStandalone[],
): ArtifactRef[] {
  const manifestFiles = evidenceManifest.map((entry) => entry.file).filter(Boolean);
  return allArtifacts.filter((artifact) =>
    manifestFiles.some((filename) =>
      matchesArtifactCandidateWithKnownExtension(artifact.path, filename),
    ),
  );
}

export function computeRecipeEvidenceArtifacts({
  artifactManifest,
  recipeJson,
  selectedNodeId,
  evidenceManifest,
  mode,
  usedTypedArtifactManifest,
  allowNamespacedNodeIds,
}: {
  artifactManifest: ArtifactRef[];
  recipeJson: string | null | undefined;
  selectedNodeId: string;
  evidenceManifest: EvidenceManifestStandalone[];
  mode: 'all' | 'node';
  usedTypedArtifactManifest?: boolean;
  allowNamespacedNodeIds?: boolean;
}): SlotViewRecipeEvidenceResult {
  const reviewable = normalizeRecipeEvidenceArtifacts(artifactManifest).filter((artifact) =>
    isRecipeRuntimeEvidenceArtifact(artifact),
  );
  const allArtifacts = sortRecipeEvidenceArtifacts(reviewable);
  const usedTypedManifest =
    usedTypedArtifactManifest ?? allArtifacts.some(isTypedArtifactManifestRef);
  if (!selectedNodeId || mode === 'all') {
    const curatedArtifacts = filterManifestRecipeEvidenceArtifacts(allArtifacts, evidenceManifest);
    const effectiveArtifacts =
      usedTypedManifest || curatedArtifacts.length === 0 ? allArtifacts : curatedArtifacts;
    return {
      allArtifacts,
      effectiveArtifacts,
      hiddenDiagnosticCount: Math.max(0, allArtifacts.length - effectiveArtifacts.length),
      usedCuratedManifest: !usedTypedManifest && curatedArtifacts.length > 0,
      usedTypedManifest,
    };
  }
  const effectiveArtifacts = filterNodeRecipeEvidenceArtifacts(
    allArtifacts,
    recipeJson,
    selectedNodeId,
    evidenceManifest,
    allowNamespacedNodeIds,
  );
  return {
    allArtifacts,
    effectiveArtifacts,
    hiddenDiagnosticCount: 0,
    usedCuratedManifest: false,
    usedTypedManifest,
  };
}
