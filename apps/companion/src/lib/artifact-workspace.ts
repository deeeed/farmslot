import {
  type ArtifactManifestEntry,
  classifyArtifact,
  isAfterVisualArtifact,
  isBeforeVisualArtifact,
} from './artifact-url';

export type ArtifactWorkspaceGroup = 'before' | 'after' | 'review' | 'supporting';

export type ArtifactWorkspaceFilter =
  | 'all'
  | ArtifactWorkspaceGroup
  | 'visual'
  | 'docs'
  | 'diffs'
  | 'reports'
  | 'recipes';

export type ArtifactWorkspaceCounts = Record<ArtifactWorkspaceFilter, number>;

const ARTIFACT_WORKSPACE_FILTERS = new Set<ArtifactWorkspaceFilter>([
  'all',
  'before',
  'after',
  'review',
  'supporting',
  'visual',
  'docs',
  'diffs',
  'reports',
  'recipes',
]);

export function isArtifactWorkspaceFilter(value: string): value is ArtifactWorkspaceFilter {
  return ARTIFACT_WORKSPACE_FILTERS.has(value as ArtifactWorkspaceFilter);
}

export interface ArtifactWorkspaceFilterPresentation {
  label: string;
  count: number;
}

export function artifactWorkspaceFilterPresentation({
  filter,
  fallbackLabel,
  counts,
  visualPairCount = 0,
}: {
  filter: ArtifactWorkspaceFilter;
  fallbackLabel: string;
  counts: ArtifactWorkspaceCounts;
  visualPairCount?: number;
}): ArtifactWorkspaceFilterPresentation {
  if (filter === 'visual' && visualPairCount > 0) {
    return { label: 'Before→After', count: visualPairCount };
  }
  return { label: fallbackLabel, count: counts[filter] };
}

export function artifactWorkspaceHeaderPresentation({
  activeFilter,
  visible,
  total,
  visualPairCount = 0,
}: {
  activeFilter: ArtifactWorkspaceFilter;
  visible: number;
  total: number;
  visualPairCount?: number;
}): { title: string; countLabel: string } {
  if (activeFilter === 'visual' && visualPairCount > 0) {
    return {
      title: 'Before-after differences',
      countLabel: `${visualPairCount} pair${visualPairCount === 1 ? '' : 's'}`,
    };
  }
  return {
    title: artifactWorkspaceHeaderTitle(activeFilter),
    countLabel: `${visible}/${total}`,
  };
}

function artifactWorkspaceHeaderTitle(activeFilter: ArtifactWorkspaceFilter): string {
  switch (activeFilter) {
    case 'before':
      return 'Before captures';
    case 'after':
      return 'After captures';
    case 'review':
      return 'Review evidence';
    case 'visual':
      return 'Visual evidence';
    case 'docs':
      return 'Document evidence';
    case 'diffs':
      return 'Diff files';
    case 'reports':
      return 'Review reports';
    case 'recipes':
      return 'Recipe artifacts';
    case 'supporting':
      return 'Supporting files';
    case 'all':
      return 'Files';
  }
}

export function artifactWorkspaceGroup(artifact: ArtifactManifestEntry): ArtifactWorkspaceGroup {
  if (isBeforeVisualArtifact(artifact)) return 'before';
  if (isAfterVisualArtifact(artifact)) return 'after';
  const normalized = `${artifact.path} ${artifact.purpose} ${artifact.label ?? ''} ${
    artifact.type ?? ''
  }`.toLowerCase();
  if (
    normalized.includes('review') ||
    normalized.includes('quality') ||
    normalized.includes('report') ||
    normalized.includes('diff')
  ) {
    return 'review';
  }
  return 'supporting';
}

export function buildArtifactWorkspaceCounts(
  artifacts: ArtifactManifestEntry[],
): ArtifactWorkspaceCounts {
  const counts: ArtifactWorkspaceCounts = {
    all: artifacts.length,
    before: 0,
    after: 0,
    review: 0,
    supporting: 0,
    visual: 0,
    docs: 0,
    diffs: 0,
    reports: 0,
    recipes: 0,
  };
  for (const artifact of artifacts) {
    counts[artifactWorkspaceGroup(artifact)] += 1;
    const mediaType = classifyArtifact(artifact);
    const purpose = artifact.purpose.toLowerCase();
    const path = artifact.path.toLowerCase();
    if (mediaType === 'image' || mediaType === 'video') counts.visual += 1;
    if (mediaType === 'document') counts.docs += 1;
    if (isDiffArtifact(path, purpose)) counts.diffs += 1;
    if (isReportArtifact(purpose)) counts.reports += 1;
    if (artifact.recipeRunId != null || purpose.includes('recipe')) counts.recipes += 1;
  }
  return counts;
}

export function filterArtifactWorkspace(
  artifacts: ArtifactManifestEntry[],
  filter: ArtifactWorkspaceFilter,
  query: string,
): ArtifactManifestEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  return artifacts.filter((artifact) => {
    if (!matchesArtifactWorkspaceFilter(artifact, filter)) return false;
    if (!normalizedQuery) return true;
    return (
      artifact.path.toLowerCase().includes(normalizedQuery) ||
      artifact.purpose.toLowerCase().includes(normalizedQuery) ||
      artifact.label?.toLowerCase().includes(normalizedQuery) === true ||
      artifact.sourceLabel?.toLowerCase().includes(normalizedQuery) === true
    );
  });
}

export function matchesArtifactWorkspaceFilter(
  artifact: ArtifactManifestEntry,
  filter: ArtifactWorkspaceFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'before' || filter === 'after' || filter === 'review' || filter === 'supporting') {
    return artifactWorkspaceGroup(artifact) === filter;
  }
  const mediaType = classifyArtifact(artifact);
  const purpose = artifact.purpose.toLowerCase();
  const path = artifact.path.toLowerCase();
  if (filter === 'visual') return mediaType === 'image' || mediaType === 'video';
  if (filter === 'docs') return mediaType === 'document';
  if (filter === 'diffs') return isDiffArtifact(path, purpose);
  if (filter === 'reports') return isReportArtifact(purpose);
  if (filter === 'recipes') return artifact.recipeRunId != null || purpose.includes('recipe');
  return true;
}

function isDiffArtifact(path: string, purpose: string): boolean {
  return purpose.includes('diff') || /\.(diff|patch)$/.test(path) || path.endsWith('/diff.txt');
}

function isReportArtifact(purpose: string): boolean {
  return purpose.includes('report') || purpose.includes('review') || purpose.includes('quality');
}
