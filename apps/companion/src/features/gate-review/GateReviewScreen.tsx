import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, useColorScheme, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PUBLICATION_GATE_TABS } from '@farmslot/review-dispatch';
import { publicationGateColors } from '@farmslot/theme';

import { EvidenceReviewWorkspace } from '../../components/EvidenceReviewWorkspace';
import { MediaViewer } from '../../components/MediaViewer';
import { TaskAcceptancePanel } from '../../components/TaskAcceptancePanel';
import { baseStyles } from '../../lib/theme';

import { GateActions, GateReviewVerdicts, GateSummaryCard } from './components/gate-review-panels';
import { gateReviewStyles as styles } from './styles/gate-review.styles';
import type { GateReviewActions, GateReviewScreenState } from './use-gate-review-controller';

/** Evidence first; the publication action stays visible in every tab. */
export function GateReviewScreen({
  state,
  actions,
  initialClaimId,
}: {
  initialClaimId?: string;
  state: GateReviewScreenState;
  actions: GateReviewActions;
}) {
  const [tab, setTab] = useState<string>('evidence');
  const [judging, setJudging] = useState(false);
  const appearance = useColorScheme();
  const palette = publicationGateColors[appearance === 'light' ? 'light' : 'dark'];
  const [focusClaim, setFocusClaim] = useState<{ claimId: string }>();
  useEffect(() => {
    if (initialClaimId) {
      setTab('evidence');
      setFocusClaim({ claimId: initialClaimId });
    }
  }, [initialClaimId]);
  const insets = useSafeAreaInsets();
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
  const recordVisualReview: GateReviewActions['recordVisualReview'] = async (...args) => {
    setJudging(true);
    try {
      await actions.recordVisualReview(...args);
    } finally {
      setJudging(false);
    }
  };
  return (
    <View
      testID="companion-screen-gate-review"
      style={[
        baseStyles.container,
        { paddingBottom: insets.bottom, backgroundColor: palette.background },
      ]}
    >
      {viewModel.error ? <Text style={styles.error}>{viewModel.error}</Text> : null}
      <View
        accessibilityRole="tablist"
        style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12 }}
      >
        {PUBLICATION_GATE_TABS.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === item.id }}
            onPress={() => setTab(item.id)}
            style={{
              minHeight: 44,
              minWidth: 44,
              padding: 12,
              borderBottomWidth: tab === item.id ? 2 : 0,
              borderColor: palette.accent,
            }}
          >
            <Text style={{ color: palette.text }}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView
        testID="companion-gate-review-content"
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
      >
        {tab === 'pr-preview' ? (
          <GateSummaryCard summary={viewModel.summary} onOpenLog={actions.openLog} />
        ) : null}
        {tab === 'quality' ? <GateReviewVerdicts reviews={viewModel.reviews} /> : null}
        {tab === 'criteria' ? (
          <View>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Acceptance criteria</Text>
              {acceptance.view || acceptance.error ? (
                <TaskAcceptancePanel
                  evidenceModel={acceptance.evidenceModel}
                  judgmentRows={acceptance.evidenceModel?.judgmentRows(acceptance.reviewer)}
                  onRecordVisualReview={recordVisualReview}
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
          </View>
        ) : null}
        {tab === 'evidence' ? (
          <View>
            <EvidenceReviewWorkspace
              runId={viewModel.run.id}
              gatewayUrl={viewModel.gatewayUrl}
              artifacts={viewModel.artifacts}
              pairs={viewModel.pairs}
              evidenceModel={acceptance.evidenceModel}
              reviewer={acceptance.reviewer}
              onRecordVisualReview={recordVisualReview}
              focusClaim={focusClaim}
              onOpenRecordedEvidence={actions.openRecordedEvidence}
              onOpenVisual={actions.openVisual}
              onOpenDocument={(artifact) => actions.openLog(artifact.path)}
              onOpenDiff={actions.openLog}
              authHeaders={viewModel.authHeaders}
            />
            <MediaViewer
              testID="companion-artifact-media-viewer"
              visible={Boolean(viewModel.media)}
              items={viewModel.media?.items ?? []}
              uri={viewModel.media?.uri ?? null}
              authHeaders={viewModel.authHeaders}
              onClose={actions.closeMedia}
            />
          </View>
        ) : null}
        <View
          testID="companion-screen-gate-review-end"
          accessible
          collapsable={false}
          accessibilityLabel="End of gate review"
          style={styles.endMarker}
        />
      </ScrollView>
      <View style={styles.section}>
        <GateActions
          showClaims={false}
          disabled={judging}
          reviewPicker={viewModel.reviewPicker}
          decision={viewModel.decision}
          actions={viewModel.actions}
          reviewDisabled={
            viewModel.decision.payload?.kind === 'ready' &&
            viewModel.decision.payload.reviewRoundBudget?.remaining === 0
          }
          sendingActionId={viewModel.sendingActionId}
          onResolve={actions.resolve}
          claims={acceptance.evidenceModel?.claims}
          judgmentRows={acceptance.evidenceModel?.judgmentRows(acceptance.reviewer)}
          onRecordVisualReview={recordVisualReview}
          onRefreshPackage={() => void actions.refreshPackage()}
          pendingVisualClaimIds={acceptance.evidenceModel?.pendingVisualClaimIds}
          readiness={
            viewModel.decision.payload?.kind === 'ready'
              ? viewModel.decision.payload.gateReadiness
              : undefined
          }
          onFocusClaim={(id) => {
            setTab('evidence');
            setFocusClaim({ claimId: id });
          }}
          attestationReason={viewModel.attestationReason}
          onAttestationReason={actions.setAttestationReason}
        />
      </View>
    </View>
  );
}
