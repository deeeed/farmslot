import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { generateReviewBoard } from './review-board.mjs';

function visualCaptureNodes(recipe, surfaceLocations) {
  return Object.entries(recipe.workflow?.nodes ?? {})
    .filter(
      ([, node]) =>
        node.action === 'ui.capture_surface' ||
        (node.action === 'ui.screenshot' && node.visual_review),
    )
    .map(([nodeId, node]) => ({
      id: nodeId,
      title: node.label ?? nodeId,
      nodeId,
      proofTargets: node.proves ?? [],
      ...(surfaceLocations[nodeId] ? { location: surfaceLocations[nodeId] } : {}),
      ...(node.visual_review?.parent ? { parentId: node.visual_review.parent } : {}),
      navigation: node.visual_review?.navigation ?? [],
      ...(node.visual_review?.related ? { relatedSurfaceIds: node.visual_review.related } : {}),
      imageTemplate: node.path ?? `screenshots/${nodeId}.png`,
    }));
}

function resolveArtifact(root, relativePath, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} must stay inside ${resolvedRoot}.`);
  }
  return resolved;
}

export function buildRecipeReviewBoard({
  artifactsDir,
  outputDir,
  platform,
  recipePath,
  sourceId,
  project,
  runId,
  surfaceLocations = {},
  title,
  storageKey = `farmslot-visual-review:${sourceId}`,
}) {
  const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
  const captures = visualCaptureNodes(recipe, surfaceLocations);
  if (captures.length === 0) {
    throw new Error(`Recipe has no visual review capture nodes: ${recipePath}`);
  }

  const resolvedOutputDir = path.resolve(outputDir);
  mkdirSync(resolvedOutputDir, { recursive: true });
  const sourcePath = path.join(resolvedOutputDir, 'visual-review-source.json');
  const previous = existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath, 'utf8')) : null;
  const previousSurfaces =
    previous?.kind === 'visual-review-source' && previous.id === sourceId ? previous.surfaces : [];
  const previousNavigationEdges =
    previous?.kind === 'visual-review-source' && previous.id === sourceId
      ? (previous.navigationEdges ?? [])
      : [];
  const byId = new Map(previousSurfaces.map((surface) => [surface.id, surface]));
  const imageCopies = [];

  for (const capture of captures) {
    const relativeImagePath = capture.imageTemplate.replaceAll('{{params.platform}}', platform);
    const sourceImagePath = resolveArtifact(
      artifactsDir,
      relativeImagePath,
      'Recipe artifact path',
    );
    if (!existsSync(sourceImagePath)) {
      throw new Error(`Recipe capture artifact is missing: ${sourceImagePath}`);
    }
    const destinationPath = resolveArtifact(
      resolvedOutputDir,
      relativeImagePath,
      'Review image path',
    );
    imageCopies.push({ destinationPath, sourceImagePath });

    const existing = byId.get(capture.id);
    const captureId = `${platform}-${capture.id}`;
    byId.set(capture.id, {
      id: capture.id,
      title: capture.title,
      nodeId: capture.nodeId,
      proofTargets: capture.proofTargets,
      ...(capture.location ? { location: capture.location } : {}),
      ...(capture.parentId ? { parentId: capture.parentId } : {}),
      ...(capture.relatedSurfaceIds ? { relatedSurfaceIds: capture.relatedSurfaceIds } : {}),
      captures: [
        ...(existing?.captures ?? []).filter((candidate) => candidate.id !== captureId),
        {
          id: captureId,
          platform,
          image: { path: relativeImagePath, mimeType: 'image/png' },
        },
      ],
    });
  }

  const surfaces = [...byId.values()];
  const replacedTargets = new Set(captures.map((capture) => capture.id));
  const navigationEdges = [
    ...previousNavigationEdges.filter((edge) => !replacedTargets.has(edge.toSurfaceId)),
    ...captures.flatMap((capture) =>
      capture.navigation.map((edge) => ({
        fromSurfaceId: edge.from,
        toSurfaceId: capture.id,
        kind: edge.kind,
      })),
    ),
  ];
  const platforms = [
    ...new Set(surfaces.flatMap((surface) => surface.captures.map((capture) => capture.platform))),
  ].sort();
  const source = {
    version: 1,
    kind: 'visual-review-source',
    id: sourceId,
    title: title ?? recipe.title ?? sourceId,
    capturedAt: new Date().toISOString(),
    description: `${surfaces.length} surface${surfaces.length === 1 ? '' : 's'} · ${platforms.join('/')}`,
    ...(project ? { project } : {}),
    ...(runId ? { runId } : {}),
    surfaces,
    ...(navigationEdges.length > 0 ? { navigationEdges } : {}),
  };
  generateReviewBoard({
    outputDir: resolvedOutputDir,
    source,
    storageKey,
    defaultPlatform: platform,
  });
  for (const { destinationPath, sourceImagePath } of imageCopies) {
    mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (sourceImagePath !== destinationPath) copyFileSync(sourceImagePath, destinationPath);
  }
  return source;
}
