import { useRef } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EvidenceReviewWorkspace } from '../../components/EvidenceReviewWorkspace';
import { MediaViewer } from '../../components/MediaViewer';
import { TaskAcceptancePanel } from '../../components/TaskAcceptancePanel';
import { baseStyles } from '../../lib/theme';

import { GateActions, GateReviewVerdicts, GateSummaryCard } from './components/gate-review-panels';
import { gateReviewStyles as styles } from './styles/gate-review.styles';
import type { GateReviewActions, GateReviewScreenState } from './use-gate-review-controller';

/**
 * One open publish gate, top to bottom in the order it is judged: the package,
 * the reviewers' latest verdicts, the acceptance criteria, their evidence, and
 * the decision's own actions.
 */
export function GateReviewScreen({
  state,
  actions,
}: {
  state: GateReviewScreenState;
  actions: GateReviewActions;
}) {
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null);
  if (state.status !== 'ready') {
    return (
      <View style={[baseStyles.container, styles.center]} testID="companion-screen-gate-review">
        <Text style={baseStyles.textSecondary}>
          {state.status === 'error' ? state.message : 'Loading gate...'}
        </Text>
        {state.status === 'error' ? (
          <Pressable onPress={actions.refresh}>
            <Text style={baseStyles.textSecondary}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  const { viewModel } = state;
  const { acceptance } = viewModel;
  return (
    <ScrollView
      ref={scroll}
      testID="companion-screen-gate-review"
      style={baseStyles.container}
      contentContainerStyle={[
        styles.scrollContent,
        { paddingBottom: styles.scrollContent.paddingBottom + insets.bottom },
      ]}
    >
      {viewModel.error ? <Text style={styles.error}>{viewModel.error}</Text> : null}
      <GateSummaryCard summary={viewModel.summary} onOpenLog={actions.openLog} />
      <GateReviewVerdicts reviews={viewModel.reviews} />
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Acceptance criteria</Text>
        {acceptance.view || acceptance.error ? (
          <TaskAcceptancePanel
            evidenceModel={acceptance.evidenceModel}
            onMarkUntestable={actions.markUntestable}
            acceptanceStatus={acceptance.acceptanceStatus}
            acceptanceCriteria={acceptance.acceptanceCriteria}
            acceptanceEvidenceLinks={acceptance.acceptanceEvidenceLinks}
            error={acceptance.error}
            onOpenEvidence={actions.openEvidence}
          />
        ) : (
          <Text style={styles.muted}>Loading acceptance criteria...</Text>
        )}
        {acceptance.view?.rows.length === 0 && !acceptance.error ? (
          <Text style={styles.muted}>This run registered no acceptance criteria.</Text>
        ) : null}
      </View>
      <EvidenceReviewWorkspace
        runId={viewModel.run.id}
        gatewayUrl={viewModel.gatewayUrl}
        artifacts={viewModel.artifacts}
        pairs={viewModel.pairs}
        evidenceModel={acceptance.evidenceModel}
        reviewer={acceptance.reviewer}
        onRecordVisualReview={actions.recordVisualReview}
        onFocusClaim={(y) => scroll.current?.scrollTo({ y, animated: true })}
        onOpenRecordedEvidence={actions.openRecordedEvidence}
        onOpenVisual={actions.openVisual}
        onOpenDocument={(artifact) => actions.openLog(artifact.path)}
        onOpenDiff={actions.openLog}
        authHeaders={viewModel.authHeaders}
      />
      <MediaViewer
        visible={Boolean(viewModel.media)}
        items={viewModel.media?.items ?? []}
        uri={viewModel.media?.uri ?? null}
        authHeaders={viewModel.authHeaders}
        onClose={actions.closeMedia}
      />
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Actions</Text>
        <GateActions
          reviewPicker={viewModel.reviewPicker}
          decision={viewModel.decision}
          actions={viewModel.actions}
          sendingActionId={viewModel.sendingActionId}
          onResolve={actions.resolve}
          attestationReason={viewModel.attestationReason}
          onAttestationReason={actions.setAttestationReason}
        />
      </View>
      <View
        testID="companion-screen-gate-review-end"
        accessible
        collapsable={false}
        accessibilityLabel="End of gate review"
        style={styles.endMarker}
      />
    </ScrollView>
  );
}
