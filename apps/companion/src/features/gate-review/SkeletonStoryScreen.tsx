import { useState } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';

import type {
  AcceptanceCriterionStatus,
  AcceptanceStatusLedger,
  RunDecision,
} from '@farmslot/protocol';
import { type PublicationGateClaim, ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import { EvidenceReviewWorkspace } from '../../components/EvidenceReviewWorkspace';
import {
  acceptancePanelViewportHeight,
  TaskAcceptancePanel,
  TaskAcceptanceSkeleton,
} from '../../components/TaskAcceptancePanel';
import { colors } from '../../lib/theme';

import { GateActions } from './components/gate-review-panels';
import { GateReviewSkeleton } from './components/GateReviewSkeleton';

const claims: PublicationGateClaim[] = [
  { id: 'AC-1', text: 'The chart shows the order control at the selected price.', status: null },
  { id: 'AC-2', text: 'Selecting the control opens the order form at that price.', status: null },
  { id: 'AC-3', text: 'The order retains its price when switching display options.', status: null },
  { id: 'AC-4', text: 'Open orders appear on the chart at their retained price.', status: null },
];
const decision: RunDecision = {
  id: 'layout-story',
  type: 'engine_human_gate',
  title: 'Gate layout story',
  description: '',
  createdAt: '2026-10-16T00:00:00Z',
  actions: [
    { id: 'approve-publish', label: 'Approve publish', style: 'primary' },
    { id: 'hold', label: 'Hold', style: 'secondary' },
  ],
};
// A historical all-proven display fixture exercises the panel's collapsed default; no run is written.
const passed: AcceptanceStatusLedger = {
  schemaVersion: 1,
  criteria: claims.map(
    (claim): AcceptanceCriterionStatus => ({
      id: claim.id,
      text: claim.text,
      verdict: 'proven',
      evidence: [],
      recipeNodes: [],
    }),
  ),
};
const artifacts = [{ path: 'artifacts/retained-report.txt', purpose: 'report' }];

/** Development-only production-component story; its controls never record a judgment. */
export function SkeletonStoryScreen() {
  const [phase, setPhase] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [panel, setPanel] = useState<'gate' | 'acceptance' | 'evidence'>('gate');
  const [picker] = useState(
    () => new ReviewDispatchViewModel({ context: { allowedActions: ['request-review'] } }),
  );
  const viewport = useWindowDimensions();
  const retry = () => setPhase('loaded');
  if (!__DEV__) return null;
  const choice = (value: string, selected: boolean, press: () => void, id: string) => (
    <Pressable
      key={value}
      testID={id}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={press}
      style={{
        minHeight: 44,
        minWidth: 76,
        paddingHorizontal: 8,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: colors.textSecondary,
        borderRadius: 6,
      }}
    >
      <Text style={{ color: colors.textPrimary }}>{value}</Text>
    </Pressable>
  );
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bgBase }}
      contentContainerStyle={{ padding: 16, gap: 16 }}
    >
      <View style={{ flexDirection: 'row', gap: 12 }}>
        {(['loading', 'loaded', 'error'] as const).map((value) =>
          choice(value, phase === value, () => setPhase(value), `skeleton-phase-${value}`),
        )}
      </View>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        {(['gate', 'acceptance', 'evidence'] as const).map((value) =>
          choice(value, panel === value, () => setPanel(value), `skeleton-panel-${value}`),
        )}
      </View>
      <View testID="native-gate-layout-frame" collapsable={false}>
        {panel === 'gate' ? (
          phase === 'loaded' ? (
            <GateActions
              decision={decision}
              actions={decision.actions.map((action) => ({ ...action, disabledReason: null }))}
              reviewPicker={picker}
              claims={claims}
              sendingActionId={null}
              onResolve={() => undefined}
              attestationReason=""
              onAttestationReason={() => undefined}
            />
          ) : (
            <GateReviewSkeleton
              rows={claims.length}
              error={phase === 'error' ? 'Evidence unavailable' : undefined}
              retry={retry}
            />
          )
        ) : panel === 'acceptance' ? (
          <ScrollView
            nestedScrollEnabled
            style={{ height: acceptancePanelViewportHeight(claims.length, viewport.height) }}
          >
            {phase === 'loading' ? (
              <TaskAcceptanceSkeleton rows={claims.length} />
            ) : (
              <TaskAcceptancePanel
                key={phase}
                acceptanceStatus={phase === 'loaded' ? passed : null}
                acceptanceCriteria={claims}
                error={phase === 'error' ? 'Acceptance read unavailable' : null}
                onRetry={retry}
              />
            )}
          </ScrollView>
        ) : (
          <EvidenceReviewWorkspace
            runId="layout-fixture"
            gatewayUrl="http://127.0.0.1:1"
            artifacts={phase === 'loading' ? [] : artifacts}
            pairs={[]}
            loading={phase === 'loading'}
            error={phase === 'error' ? 'Acceptance read unavailable' : null}
            retry={retry}
            onOpenVisual={() => undefined}
            onOpenDocument={() => undefined}
          />
        )}
      </View>
      <Text testID="native-gate-layout-anchor" style={{ color: colors.textPrimary }}>
        Content below {panel}
      </Text>
    </ScrollView>
  );
}
