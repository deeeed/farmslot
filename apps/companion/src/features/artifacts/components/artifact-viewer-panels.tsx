import { type LayoutChangeEvent, Pressable, ScrollView, Text, View } from 'react-native';

import { type RecipeRunArtifactGroup, type Run } from '@farmslot/protocol';

import {
  type ArtifactManifestEntry,
  artifactUrlForEntry,
  classifyArtifact,
} from '../../../lib/artifact-url';
import {
  type ArtifactWorkspaceCounts,
  type ArtifactWorkspaceFilter,
  artifactWorkspaceFilterPresentation,
  artifactWorkspaceHeaderPresentation,
} from '../../../lib/artifact-workspace';
import { diffArtifactCandidate } from '../../../lib/diff';
import { colors } from '../../../lib/theme';
import { artifactViewerStyles as styles } from '../styles/artifact-viewer.styles';

export function routeParamString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
export function ArtifactStickyFilter({
  compact = false,
  filter,
  query,
  counts,
  visible,
  visualPairCount,
  filters,
  onFilterChange,
}: {
  compact?: boolean;
  filter: ArtifactWorkspaceFilter;
  query: string;
  counts: ArtifactWorkspaceCounts;
  visible: number;
  visualPairCount: number;
  filters: Array<{ id: ArtifactWorkspaceFilter; label: string }>;
  onFilterChange: (filter: ArtifactWorkspaceFilter) => void;
}) {
  const header = artifactWorkspaceHeaderPresentation({
    activeFilter: filter,
    visible,
    total: counts.all,
    visualPairCount,
  });
  if (compact) {
    return (
      <View style={[styles.stickyFilter, styles.stickyFilterCompact]}>
        <View style={styles.stickyFilterCompactRow}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.stickyFilterCompactChips}
          >
            {filters.map((item) => {
              const active = filter === item.id;
              const presentation = artifactWorkspaceFilterPresentation({
                filter: item.id,
                fallbackLabel: item.label,
                counts,
                visualPairCount,
              });
              return (
                <Pressable
                  key={item.id}
                  style={[
                    styles.filterChip,
                    styles.filterChipCompact,
                    active && styles.filterChipActive,
                  ]}
                  onPress={() => onFilterChange(item.id)}
                >
                  <Text
                    style={[
                      styles.filterText,
                      styles.filterTextCompact,
                      active && styles.filterTextActive,
                    ]}
                  >
                    {presentation.label} {presentation.count}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <Text style={styles.stickyFilterCompactCount}>{header.countLabel}</Text>
        </View>
        {query.trim() ? (
          <Text style={styles.stickyFilterCompactQuery} numberOfLines={1}>
            Focus: {query.trim()}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.stickyFilter}>
      <View style={styles.filterTopRow}>
        <Text style={styles.filterTitle}>{header.title}</Text>
        <Text style={styles.filterCount}>{header.countLabel}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {filters.map((item) => {
          const active = filter === item.id;
          const presentation = artifactWorkspaceFilterPresentation({
            filter: item.id,
            fallbackLabel: item.label,
            counts,
            visualPairCount,
          });
          return (
            <Pressable
              key={item.id}
              style={[styles.filterChip, active && styles.filterChipActive]}
              onPress={() => onFilterChange(item.id)}
            >
              <Text style={[styles.filterText, active && styles.filterTextActive]}>
                {presentation.label} {presentation.count}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {query.trim() ? (
        <Pressable style={styles.focusedFilterPill} onPress={() => onFilterChange(filter)}>
          <Text style={styles.focusedFilterText} numberOfLines={1}>
            Focus: {query.trim()}
          </Text>
          <Text style={styles.focusedFilterClear}>Clear</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
export function ArtifactHeader({
  run,
  gatewayUrl,
  artifactCount,
  manifest,
  recipeRuns,
  selectedRecipeRunId,
  focusedArtifactQuery,
  activeFilter,
  artifactCounts,
  filteredArtifactCount,
  availableFilters,
  artifactMirrorEpoch,
  artifactMirrorRefreshing,
  artifactMirrorFeedback,
  onRefreshArtifactMirror,
  onFilterChange,
  onSelectRecipeRun,
  onOpenVisual,
  onOpenDocument,
  onOpenDiff,
  onFilterLayout,
  onClearFocusedArtifact,
}: {
  run: Run;
  gatewayUrl: string;
  artifactCount: number;
  manifest: ArtifactManifestEntry[];
  recipeRuns: RecipeRunArtifactGroup[];
  selectedRecipeRunId: string | null;
  focusedArtifactQuery: string;
  activeFilter: ArtifactWorkspaceFilter;
  artifactCounts: ArtifactWorkspaceCounts;
  filteredArtifactCount: number;
  availableFilters: Array<{ id: ArtifactWorkspaceFilter; label: string }>;
  artifactMirrorEpoch: number;
  artifactMirrorRefreshing: boolean;
  artifactMirrorFeedback: string | null;
  onRefreshArtifactMirror: () => void;
  onFilterChange: (filter: ArtifactWorkspaceFilter) => void;
  onSelectRecipeRun: (id: string | null) => void;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: ArtifactManifestEntry) => void;
  onOpenDiff: (path?: string) => void;
  onFilterLayout: (event: LayoutChangeEvent) => void;
  onClearFocusedArtifact: () => void;
}) {
  const normalizedFocusedArtifactQuery = focusedArtifactQuery.trim();
  const focusedArtifactPath = manifest.some(
    (artifact) => artifact.path === normalizedFocusedArtifactQuery,
  )
    ? normalizedFocusedArtifactQuery
    : null;
  const focusedArtifact =
    manifest.find((artifact) => artifact.path === focusedArtifactPath) ?? null;
  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <View style={[styles.flowBadge, { backgroundColor: colors.accent + '30' }]}>
          <Text style={[styles.flowText, { color: colors.accent }]}>{run.flowType}</Text>
        </View>
        <View style={styles.headerActions}>
          <Text style={styles.countText}>{artifactCount} artifacts</Text>
          <Pressable
            style={[styles.refreshButton, artifactMirrorRefreshing && styles.refreshButtonDisabled]}
            disabled={artifactMirrorRefreshing}
            onPress={onRefreshArtifactMirror}
          >
            <Text style={styles.refreshButtonText}>
              {artifactMirrorRefreshing ? 'Refreshing…' : artifactMirrorFeedback || 'Refresh'}
            </Text>
          </Pressable>
        </View>
      </View>
      <Text style={styles.ticketText}>{run.ticketOrPr}</Text>
      <View onLayout={onFilterLayout}>
        <ArtifactStickyFilter
          filter={activeFilter}
          query={focusedArtifactQuery}
          counts={artifactCounts}
          visible={filteredArtifactCount}
          visualPairCount={0}
          filters={availableFilters}
          onFilterChange={onFilterChange}
        />
      </View>
      {focusedArtifact ? (
        <FocusedArtifactPanel
          run={run}
          artifact={focusedArtifact}
          gatewayUrl={gatewayUrl}
          artifactMirrorEpoch={artifactMirrorEpoch}
          onOpenVisual={onOpenVisual}
          onOpenDocument={onOpenDocument}
          onOpenDiff={onOpenDiff}
          onClear={onClearFocusedArtifact}
        />
      ) : null}
      {recipeRuns.length > 0 && (
        <RecipeRunPicker
          groups={recipeRuns}
          selectedId={selectedRecipeRunId}
          onSelect={onSelectRecipeRun}
        />
      )}
      {/* Section title for individual artifacts */}
      {artifactCount > 0 && <Text style={styles.sectionTitle}>All Artifacts</Text>}
    </View>
  );
}
export function FocusedArtifactPanel({
  run,
  artifact,
  gatewayUrl,
  artifactMirrorEpoch,
  onOpenVisual,
  onOpenDocument,
  onOpenDiff,
  onClear,
}: {
  run: Run;
  artifact: ArtifactManifestEntry;
  gatewayUrl: string;
  artifactMirrorEpoch: number;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: ArtifactManifestEntry) => void;
  onOpenDiff: (path?: string) => void;
  onClear: () => void;
}) {
  const mediaType = classifyArtifact(artifact);
  const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
  const openArtifact = () => {
    if (mediaType === 'image' || mediaType === 'video') {
      onOpenVisual(artifactUrlForEntry(gatewayUrl, run.id, artifact, artifactMirrorEpoch));
      return;
    }
    if (isDiffArtifact) {
      onOpenDiff(artifact.path);
      return;
    }
    if (mediaType === 'document') {
      onOpenDocument(artifact);
    }
  };
  const canOpen =
    mediaType === 'image' || mediaType === 'video' || mediaType === 'document' || isDiffArtifact;
  return (
    <View style={styles.focusedArtifactPanel}>
      <View style={styles.focusedArtifactHeader}>
        <View style={styles.focusedArtifactTitleBlock}>
          <Text style={styles.focusedArtifactEyebrow}>Focused artifact</Text>
          <Text style={styles.focusedArtifactPath} numberOfLines={2}>
            {artifact.path}
          </Text>
          {artifact.purpose || artifact.label ? (
            <Text style={styles.focusedArtifactMeta} numberOfLines={1}>
              {[artifact.label, artifact.purpose].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
        </View>
        <View style={styles.focusedArtifactTypeBadge}>
          <Text style={styles.focusedArtifactTypeText}>
            {isDiffArtifact ? 'DIFF' : mediaType.toUpperCase()}
          </Text>
        </View>
      </View>
      <View style={styles.focusedArtifactActions}>
        <Pressable
          style={[styles.focusedArtifactAction, !canOpen && styles.focusedArtifactActionDisabled]}
          disabled={!canOpen}
          onPress={openArtifact}
        >
          <Text style={styles.focusedArtifactActionText}>
            {isDiffArtifact ? 'Open diff' : mediaType === 'document' ? 'Open document' : 'Preview'}
          </Text>
        </Pressable>
        <Pressable style={styles.focusedArtifactClear} onPress={onClear}>
          <Text style={styles.focusedArtifactClearText}>Clear</Text>
        </Pressable>
      </View>
    </View>
  );
}
export function RecipeRunPicker({
  groups,
  selectedId,
  onSelect,
}: {
  groups: RecipeRunArtifactGroup[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <View style={styles.recipePicker}>
      <View style={styles.recipePickerHeader}>
        <Text style={styles.recipePickerTitle}>Recipe runs</Text>
        <Text style={styles.recipePickerHint}>Tap a run to scope artifacts</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Pressable
          style={[styles.recipeChip, selectedId === null && styles.recipeChipActive]}
          onPress={() => onSelect(null)}
        >
          <Text style={[styles.recipeChipText, selectedId === null && styles.recipeChipTextActive]}>
            Decision evidence
          </Text>
        </Pressable>
        {groups.map((group) => (
          <Pressable
            key={group.id}
            style={[styles.recipeChip, selectedId === group.id && styles.recipeChipActive]}
            onPress={() => onSelect(group.id)}
          >
            <Text
              style={[
                styles.recipeChipText,
                selectedId === group.id && styles.recipeChipTextActive,
              ]}
              numberOfLines={1}
            >
              {group.label}
            </Text>
            <Text style={styles.recipeChipMeta}>
              {group.status} · {group.artifactManifest?.length ?? 0}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
