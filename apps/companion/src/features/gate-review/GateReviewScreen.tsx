import { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { reviewRoundBudgetLabel } from '@farmslot/protocol';
import { PUBLICATION_GATE_TABS, publicationGateCriteria } from '@farmslot/review-dispatch';
import { publicationGateColors } from '@farmslot/theme';

import { EvidenceReviewWorkspace } from '../../components/EvidenceReviewWorkspace';
import { MediaViewer } from '../../components/MediaViewer';
import {
  acceptancePanelViewportHeight,
  TaskAcceptancePanel,
} from '../../components/TaskAcceptancePanel';
import { baseStyles } from '../../lib/theme';

import { GateActions, GateReviewVerdicts, GateSummaryCard } from './components/gate-review-panels';
import { GateBlockers } from './components/GateBlockers';
import { GateReviewSkeleton } from './components/GateReviewSkeleton';
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
  const [acceptingDecisionId, setAcceptingDecisionId] = useState<string | null>(null);
  const appearance = useColorScheme();
  const palette = publicationGateColors[appearance === 'light' ? 'light' : 'dark'];
  const [focusClaim, setFocusClaim] = useState<{ claimId: string }>();
  useEffect(() => {
    if (initialClaimId) {
      setTab('evidence');
      setFocusClaim({ claimId: initialClaimId });
    }
  }, [initialClaimId]);
  const viewport = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null);
  const evidenceOffset = useRef(0);
  if (state.status !== 'ready') {
    return (
      <View style={[baseStyles.container, { padding: 16 }]} testID="companion-screen-gate-review">
        <GateReviewSkeleton
          error={state.status === 'error' ? state.message : undefined}
          retry={actions.refresh}
        />
      </View>
    );
  }
  const { viewModel } = state;
  const { acceptance } = viewModel;
  const expectedRows = publicationGateCriteria(
    viewModel.decision.payload?.kind === 'ready' ? viewModel.decision.payload : undefined,
  ).length;
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
      <ScrollView
        ref={scroll}
        testID="companion-gate-review-content"
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
      >
        <GateBlockers
          run={viewModel.run}
          decision={viewModel.decision}
          actions={viewModel.actions}
          evidenceModel={acceptance.evidenceModel}
          reviewer={acceptance.reviewer}
          busy={judging || viewModel.sendingActionId !== null}
          onSkip={actions.markUntestable}
          acceptingFindings={acceptingDecisionId === viewModel.decision.id}
          onAcceptFindingsChange={(accepting) =>
            setAcceptingDecisionId(accepting ? viewModel.decision.id : null)
          }
          onAnotherRound={actions.giveAnotherRound}
        />
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
        {tab === 'pr-preview' ? (
          <GateSummaryCard summary={viewModel.summary} onOpenLog={actions.openLog} />
        ) : null}
        {tab === 'quality' ? <GateReviewVerdicts reviews={viewModel.reviews} /> : null}
        {tab === 'criteria' ? (
          <View>
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Acceptance criteria</Text>
              <ScrollView
                nestedScrollEnabled
                style={{ height: acceptancePanelViewportHeight(expectedRows, viewport.height) }}
              >
                <TaskAcceptancePanel
                  loading={acceptance.loading}
                  expectedRows={expectedRows}
                  evidenceModel={acceptance.evidenceModel}
                  judgmentRows={acceptance.evidenceModel?.judgmentRows(acceptance.reviewer)}
                  onRecordVisualReview={recordVisualReview}
                  onMarkUntestable={actions.markUntestable}
                  acceptanceStatus={acceptance.acceptanceStatus}
                  acceptanceCriteria={acceptance.acceptanceCriteria}
                  acceptanceEvidenceLinks={acceptance.acceptanceEvidenceLinks}
                  error={acceptance.error}
                  onRetry={acceptance.retry}
                  onOpenEvidence={actions.openEvidence}
                />
              </ScrollView>
              {acceptance.view?.rows.length === 0 && !acceptance.error ? (
                <Text style={styles.muted}>This run registered no acceptance criteria.</Text>
              ) : null}
            </View>
          </View>
        ) : null}
        {tab === 'evidence' ? (
          <View
            onLayout={(event) => {
              evidenceOffset.current = event.nativeEvent.layout.y;
            }}
          >
            <EvidenceReviewWorkspace
              runId={viewModel.run.id}
              gatewayUrl={viewModel.gatewayUrl}
              artifacts={viewModel.artifacts}
              pairs={viewModel.pairs}
              evidenceModel={acceptance.evidenceModel}
              loading={acceptance.evidenceLoading}
              error={acceptance.evidenceError ?? undefined}
              retry={acceptance.retry}
              onFocusClaim={(y) =>
                scroll.current?.scrollTo({ y: evidenceOffset.current + y, animated: true })
              }
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
        {viewModel.decision.payload?.kind === 'ready' &&
        viewModel.decision.payload.reviewRoundBudget?.noVerdict ? (
          <Text style={styles.muted} testID="companion-gate-review-round-budget">
            {reviewRoundBudgetLabel(viewModel.decision.payload.reviewRoundBudget)}
          </Text>
        ) : null}
        <GateActions
          run={viewModel.run}
          showClaims={false}
          loading={acceptance.loading}
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
          acceptingFindings={acceptingDecisionId === viewModel.decision.id}
          onAcceptFindings={() => setAcceptingDecisionId(viewModel.decision.id)}
        />
      </View>
    </View>
  );
}
