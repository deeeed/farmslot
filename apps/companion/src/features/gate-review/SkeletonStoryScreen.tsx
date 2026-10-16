import { useState } from 'react';
import { Pressable, ScrollView, Text, useColorScheme, View } from 'react-native';

import type { RunDecision } from '@farmslot/protocol';
import { type PublicationGateClaim, ReviewDispatchViewModel } from '@farmslot/review-dispatch';
import { publicationGateColors } from '@farmslot/theme';

import { EvidenceReviewSkeleton } from '../../components/EvidenceReviewSkeleton';

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

/** Development-only story using the production gate renderer and real press handlers. */
export function SkeletonStoryScreen() {
  const [phase, setPhase] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [picker] = useState(
    () => new ReviewDispatchViewModel({ context: { allowedActions: ['request-review'] } }),
  );
  const appearance = useColorScheme();
  const palette = publicationGateColors[appearance === 'light' ? 'light' : 'dark'];
  if (!__DEV__) return null;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.background }}
      contentContainerStyle={{ padding: 16, paddingTop: 60, gap: 16 }}
    >
      <View style={{ flexDirection: 'row', gap: 12 }}>
        {(['loading', 'loaded', 'error'] as const).map((value) => (
          <Pressable
            key={value}
            testID={`skeleton-phase-${value}`}
            accessibilityRole="button"
            accessibilityState={{ selected: phase === value }}
            onPress={() => setPhase(value)}
            style={{
              minHeight: 44,
              minWidth: 76,
              justifyContent: 'center',
              alignItems: 'center',
              borderWidth: 1,
              borderColor: palette.border,
              borderRadius: 6,
            }}
          >
            <Text style={{ color: palette.text }}>{value}</Text>
          </Pressable>
        ))}
      </View>
      <View testID="native-gate-layout-frame">
        {phase === 'loaded' ? (
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
            retry={() => setPhase('loading')}
          />
        )}
      </View>
      <Text testID="native-gate-layout-anchor" style={{ color: palette.text }}>
        Package and evidence
      </Text>
      <EvidenceReviewSkeleton
        error={phase === 'error' ? 'Evidence unavailable' : undefined}
        retry={() => setPhase('loading')}
      />
    </ScrollView>
  );
}
