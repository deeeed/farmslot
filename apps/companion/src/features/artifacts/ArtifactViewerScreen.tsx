import { FlashList } from '@shopify/flash-list';
import { Text, View } from 'react-native';

import { ArtifactCard } from '../../components/ArtifactCard';
import { DocumentViewer } from '../../components/DocumentViewer';
import { MediaViewer } from '../../components/MediaViewer';
import { RecipeRunControls } from '../../components/RecipeRunControls';
import { ResourceReadStatus } from '../../components/ResourceReadStatus';
import { TaskAcceptancePanel } from '../../components/TaskAcceptancePanel';
import {
  type ArtifactManifestEntry,
  classifyArtifact,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
} from '../../lib/artifact-url';
import { diffArtifactCandidate } from '../../lib/diff';
import { baseStyles, spacing } from '../../lib/theme';

import { ArtifactHeader, ArtifactStickyFilter } from './components/artifact-viewer-panels';
import { artifactViewerStyles as styles } from './styles/artifact-viewer.styles';
import { useArtifactViewerController } from './use-artifact-viewer-controller';

export default function ArtifactViewerScreen() {
  const { viewModel, actions } = useArtifactViewerController();
  const {
    run,
    runId,
    runObservation,
    recipeObservation,
    insets,
    stickyNavVisible,
    artifactFilter,
    artifactQuery,
    artifactCounts,
    filteredSingles,
    visualPairCount,
    availableFilters,
    manifest,
    gatewayUrl,
    artifactAuthHeaders,
    recipeRuns,
    selectedRecipeRunId,
    selectedRecipeRun,
    artifactMirrorEpoch,
    artifactMirrorRefreshing,
    artifactMirrorFeedback,
    recordedEvidence,
    evidenceModel,
    reviewer,
    client,
    commandsReady,
    ownerKey,
    error,
    isFocused,
    viewerUri,
    viewerIndex,
    visualViewerItems,
    acceptanceViewer,
    documentViewer,
  } = viewModel;
  const {
    handleListScroll,
    refreshArtifactMirror,
    handleSelectRecipeRun,
    openVisualArtifact,
    openReviewDocument,
    openDiffPath,
    rememberFilterOffset,
    openDocument,
    artifactUrlFor,
  } = actions;
  const renderItem = ({ item, index }: { item: ArtifactManifestEntry; index: number }) => {
    if (!runId) return null;
    const url = artifactUrlFor(item);
    const mediaType = classifyArtifact(item);
    const isDiffArtifact = diffArtifactCandidate([item])?.path === item.path;
    return (
      <View style={[styles.artifactCell, index % 2 === 0 && styles.artifactCellLeft]}>
        <ArtifactCard
          url={url}
          path={item.path}
          purpose={item.purpose}
          type={item.type}
          label={item.label}
          mimeType={item.mimeType}
          sizeBytes={item.sizeBytes}
          sha256={item.sha256}
          authHeaders={artifactAuthHeaders}
          onPressImage={mediaType === 'image' ? () => openVisualArtifact(url) : undefined}
          onPressVideo={mediaType === 'video' ? () => openVisualArtifact(url) : undefined}
          onPressDocument={
            mediaType === 'document'
              ? isDiffArtifact
                ? () => openDiffPath(item.path)
                : () => openDocument(url, item.path, item.recipeRunId)
              : undefined
          }
          documentLabel={isDiffArtifact ? 'DIFF' : undefined}
          documentHint={isDiffArtifact ? 'Tap to review diff' : undefined}
        />
      </View>
    );
  };

  if (!run) {
    return (
      <View style={[baseStyles.container, styles.center, { paddingBottom: insets.bottom }]}>
        <ResourceReadStatus
          observation={runObservation}
          label="run artifacts"
          onRetry={actions.retry}
          retryLabel="Retry artifacts"
        />
        <Text style={baseStyles.textSecondary}>
          {runObservation.error ? 'Run is unavailable.' : 'Loading...'}
        </Text>
      </View>
    );
  }

  return (
    <View testID="companion-screen-run-files" style={baseStyles.container}>
      {stickyNavVisible ? (
        <View style={styles.stickyFilterChrome}>
          <ArtifactStickyFilter
            compact
            filter={artifactFilter}
            query={artifactQuery}
            counts={artifactCounts}
            visible={filteredSingles.length}
            visualPairCount={visualPairCount}
            filters={availableFilters}
            onFilterChange={actions.selectFilter}
          />
        </View>
      ) : null}
      <FlashList
        data={filteredSingles}
        keyExtractor={(item) => item.path}
        renderItem={renderItem}
        numColumns={2}
        onScroll={handleListScroll}
        scrollEventThrottle={16}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: styles.listContent.paddingBottom + insets.bottom },
        ]}
        ListHeaderComponent={
          <>
            <ResourceReadStatus
              observations={[
                { observation: runObservation, label: 'run artifacts' },
                { observation: recipeObservation, label: 'recipe evidence' },
              ]}
              onRetry={actions.retry}
              retryLabel="Retry artifacts"
            />
            <ArtifactHeader
              run={run}
              gatewayUrl={gatewayUrl}
              artifactCount={manifest.length}
              visualPairCount={visualPairCount}
              manifest={manifest}
              recipeRuns={recipeRuns}
              selectedRecipeRunId={selectedRecipeRunId}
              focusedArtifactQuery={artifactQuery}
              activeFilter={artifactFilter}
              artifactCounts={artifactCounts}
              filteredArtifactCount={filteredSingles.length}
              availableFilters={availableFilters}
              artifactMirrorEpoch={artifactMirrorEpoch}
              artifactMirrorRefreshing={artifactMirrorRefreshing}
              commandsReady={commandsReady}
              artifactMirrorFeedback={artifactMirrorFeedback}
              onRefreshArtifactMirror={refreshArtifactMirror}
              onFilterChange={actions.selectFilter}
              onSelectRecipeRun={handleSelectRecipeRun}
              onOpenVisual={openVisualArtifact}
              onOpenDocument={openReviewDocument}
              onOpenDiff={openDiffPath}
              onFilterLayout={rememberFilterOffset}
              onClearFocusedArtifact={actions.clearArtifactFocus}
            />
            <TaskAcceptancePanel
              acceptanceStatus={recordedEvidence?.input?.claims ?? null}
              evidenceModel={evidenceModel}
              judgmentRows={evidenceModel.judgmentRows(reviewer)}
              onRecordVisualReview={commandsReady ? actions.recordVisualReview : undefined}
              showOccurrences
              onOpenEvidence={actions.openEvidence}
              onOpenOccurrence={actions.openOccurrence}
            />
            {recipeRuns.length > 0 ? (
              <View style={styles.recipeControlsWrap}>
                <RecipeRunControls
                  client={client}
                  runId={run.id}
                  slotId={run.slotId}
                  project={run.project}
                  recipeRunId={
                    selectedRecipeRun?.groupKind === CURRENT_ARTIFACTS_RECIPE_RUN_PARAM
                      ? null
                      : selectedRecipeRun?.id
                  }
                  key={ownerKey}
                  commandsReady={commandsReady}
                  assertCurrent={actions.assertCurrentInputs}
                />
              </View>
            ) : null}
          </>
        }
        ListEmptyComponent={
          <Text style={styles.emptyText}>No files match the current filter.</Text>
        }
      />
      {error && (
        <Text style={[styles.errorText, { paddingBottom: spacing.lg + insets.bottom }]}>
          {error}
        </Text>
      )}
      <MediaViewer
        testID="companion-artifact-media-viewer"
        visible={isFocused && !!viewerUri && viewerIndex >= 0}
        uri={viewerUri}
        items={visualViewerItems}
        authHeaders={artifactAuthHeaders}
        initialIndex={viewerIndex}
        onClose={actions.closeMedia}
      />
      <MediaViewer
        testID="companion-ac-evidence-viewer"
        visible={isFocused && acceptanceViewer.visible}
        uri={null}
        items={acceptanceViewer.items}
        authHeaders={artifactAuthHeaders}
        initialIndex={acceptanceViewer.initialIndex}
        onClose={acceptanceViewer.close}
        acceptance={acceptanceViewer.review}
      />
      <DocumentViewer
        visible={isFocused && !!documentViewer}
        sharedArtifact={documentViewer?.sharedArtifact}
        title={documentViewer?.title ?? ''}
        body={documentViewer?.body ?? ''}
        onClose={actions.closeDocument}
      />
    </View>
  );
}
