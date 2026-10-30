import { Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { ResourceReadStatus } from '../../components/ResourceReadStatus';
import { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import { baseStyles, lifecycleColor, spacing } from '../../lib/theme';
import { relativeTime } from '../workspace-shared/format';

import { healthColor, SlotWorkspaceSection } from './components/slot-workspace-panels';
import { slotWorkspaceStyles as styles } from './styles/slot-workspace.styles';
import { useSlotWorkspaceController } from './use-slot-workspace-controller';

export default function SlotWorkspaceScreen() {
  const {
    insets,
    router,
    id,
    slot,
    workspaceRunId,
    boundRunId,
    requestedArtifactPath,
    workspaceRouteContext,
    taskProgressError,
    currentRun,
    runObservation,
    retryRead,
    readObservations,
    currentRecipeRuns,
    currentRecipeRunsLoaded,
    currentEvidenceModel,
    familySnapshot,
    selectedRecipeRunId,
    slotHistory,
    historyRecipeEvidence,
    historyRunVisualEvidence,
    navLayout,
    stickyNavVisible,
    scrollRef,
    scrollHandler,
    stickyNavStyle,
    rememberNavLayout,
    shouldShowTaskProgress,
    activeTaskProgress,
    fallbackTaskProgress,
    workspaceNavProps,
    gatewayUrl,
    artifactAuthHeaders,
    setSelectedRecipeRunId,
    openLiveTerminal,
  } = useSlotWorkspaceController();

  if (!slot && !currentRun) {
    return (
      <View style={[baseStyles.container, styles.center, { paddingBottom: insets.bottom }]}>
        <Text style={baseStyles.textSecondary}>Slot details unavailable</Text>
        <ResourceReadStatus observation={runObservation} label="slot run" />
      </View>
    );
  }

  return (
    <View testID="companion-screen-slot-workspace" style={baseStyles.container}>
      <Animated.View
        pointerEvents={stickyNavVisible && navLayout !== null ? 'auto' : 'none'}
        style={[styles.stickyWorkspaceNav, stickyNavStyle]}
      >
        <RunWorkspaceNav {...workspaceNavProps} />
      </Animated.View>
      <Animated.ScrollView
        ref={scrollRef}
        style={baseStyles.container}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: styles.scrollContent.paddingBottom + insets.bottom },
        ]}
      >
        <View style={styles.headerCard}>
          <View style={styles.row}>
            <Text style={styles.slotName}>{slot?.slot ?? id}</Text>
            <View
              style={[
                styles.badge,
                { backgroundColor: `${lifecycleColor(slot?.lifecycle ?? 'unknown')}30` },
              ]}
            >
              <Text
                style={[styles.badgeText, { color: lifecycleColor(slot?.lifecycle ?? 'unknown') }]}
              >
                {slot?.lifecycle ?? 'Slot details unavailable'}
              </Text>
            </View>
          </View>
          <Text style={baseStyles.textSecondary}>
            {slot ? `${slot.machine} | ${slot.platform}` : 'Showing the saved run'}
          </Text>
          {slot?.branch && (
            <Text style={[baseStyles.textSecondary, { marginTop: spacing.sm }]}>{slot.branch}</Text>
          )}
          {slot?.dispatchedAt && (
            <Text style={baseStyles.textMuted}>Dispatched {relativeTime(slot.dispatchedAt)}</Text>
          )}
        </View>

        <View onLayout={rememberNavLayout}>
          <RunWorkspaceNav {...workspaceNavProps} />
        </View>

        <ResourceReadStatus
          observations={readObservations}
          onRetry={() => void retryRead()}
          retryLabel="Retry slot run reads"
        />
        <SlotWorkspaceSection
          slotId={slot?.slot ?? id}
          slotCurrentRunId={boundRunId}
          run={currentRun}
          recipeRuns={currentRecipeRuns}
          evidenceModel={currentEvidenceModel}
          recipeRunsLoaded={currentRecipeRunsLoaded}
          selectedRecipeRunId={selectedRecipeRunId}
          familySnapshot={familySnapshot}
          history={slotHistory}
          focusedArtifactPath={requestedArtifactPath || null}
          historyRecipeEvidence={historyRecipeEvidence}
          historyRunVisualEvidence={historyRunVisualEvidence}
          gatewayUrl={gatewayUrl}
          artifactAuthHeaders={artifactAuthHeaders}
          activeTaskProgress={shouldShowTaskProgress ? activeTaskProgress : undefined}
          fallbackTaskProgress={!shouldShowTaskProgress ? fallbackTaskProgress : null}
          taskProgressError={taskProgressError}
          workspaceRouteContext={workspaceRouteContext}
          routeWorkspace={workspaceRouteContext.workspace}
          onOpenTerminal={openLiveTerminal}
          onSelectRecipeRun={(recipeRunId) => {
            setSelectedRecipeRunId(recipeRunId);
            router.setParams({
              id,
              ...workspaceRouteContext,
              ...(workspaceRunId ? { runId: workspaceRunId } : {}),
              recipeRun: recipeRunId ?? undefined,
            });
          }}
        />

        {/* Health Grid */}
        {slot ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Health</Text>
            <View style={styles.healthGrid}>
              {Object.entries(slot.health).map(([key, val]) => (
                <View key={key} style={styles.healthItem}>
                  <Text style={styles.healthLabel}>{key}</Text>
                  <Text style={[styles.healthValue, { color: healthColor(val) }]}>{val}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* Runner / Model */}
        {(slot?.runner || slot?.model) && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Worker</Text>
            <View style={styles.infoRow}>
              {slot?.runner && <Text style={baseStyles.textPrimary}>Runner: {slot.runner}</Text>}
              {slot?.model && <Text style={baseStyles.textPrimary}>Model: {slot.model}</Text>}
            </View>
          </View>
        )}
      </Animated.ScrollView>
    </View>
  );
}
