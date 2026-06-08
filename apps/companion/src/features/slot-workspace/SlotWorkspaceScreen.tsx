import { Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

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
    requestedArtifactPath,
    workspaceRouteContext,
    taskProgressError,
    currentRun,
    currentRecipeRuns,
    currentRecipeRunsLoaded,
    familySnapshot,
    selectedRecipeRunId,
    slotHistory,
    historyRecipeEvidence,
    historyRunVisualEvidence,
    detailError,
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

  if (!slot) {
    return (
      <View style={[baseStyles.container, styles.center, { paddingBottom: insets.bottom }]}>
        <Text style={baseStyles.textSecondary}>Slot not found</Text>
      </View>
    );
  }

  return (
    <View style={baseStyles.container}>
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
            <Text style={styles.slotName}>{slot.slot}</Text>
            <View
              style={[styles.badge, { backgroundColor: `${lifecycleColor(slot.lifecycle)}30` }]}
            >
              <Text style={[styles.badgeText, { color: lifecycleColor(slot.lifecycle) }]}>
                {slot.lifecycle}
              </Text>
            </View>
          </View>
          <Text style={baseStyles.textSecondary}>
            {slot.machine} | {slot.platform}
          </Text>
          {slot.branch && (
            <Text style={[baseStyles.textSecondary, { marginTop: spacing.sm }]}>{slot.branch}</Text>
          )}
          {slot.dispatchedAt && (
            <Text style={baseStyles.textMuted}>Dispatched {relativeTime(slot.dispatchedAt)}</Text>
          )}
        </View>

        <View onLayout={rememberNavLayout}>
          <RunWorkspaceNav {...workspaceNavProps} />
        </View>

        {detailError ? <Text style={styles.errorText}>{detailError}</Text> : null}

        <SlotWorkspaceSection
          slotId={slot.slot}
          slotCurrentRunId={slot.currentRunId}
          run={currentRun}
          recipeRuns={currentRecipeRuns}
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

        {/* Runner / Model */}
        {(slot.runner || slot.model) && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Worker</Text>
            <View style={styles.infoRow}>
              {slot.runner && <Text style={baseStyles.textPrimary}>Runner: {slot.runner}</Text>}
              {slot.model && <Text style={baseStyles.textPrimary}>Model: {slot.model}</Text>}
            </View>
          </View>
        )}
      </Animated.ScrollView>
    </View>
  );
}
