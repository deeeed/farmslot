import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';

import { type GateReviewFrame, observeD12GateReview } from '../../farmslot/d12-native-proof';
import { GateReviewScreen } from '../../features/gate-review/GateReviewScreen';
import { useGateReviewController } from '../../features/gate-review/use-gate-review-controller';
import { routeParamString } from '../../features/workspace-shared/route-params';

export default function GateReviewRoute() {
  const { decisionId, runId, ac } = useLocalSearchParams<{
    ac?: string | string[];
    decisionId: string | string[];
    runId: string | string[];
  }>();
  const screen = useGateReviewController({
    runId: routeParamString(runId),
    decisionId: routeParamString(decisionId),
  });
  // Dev-only recipe evidence: what this screen renders for its decision.
  const frame = useRef<GateReviewFrame>({ decisionId: '', ready: false, details: false });
  const { state } = screen;
  frame.current = {
    decisionId: routeParamString(decisionId),
    ready: state.status === 'ready',
    details: state.status === 'ready' && Boolean(state.viewModel.summary.title),
  };
  useEffect(() => {
    if (__DEV__) return observeD12GateReview(() => frame.current);
  }, []);
  return <GateReviewScreen {...screen} initialClaimId={routeParamString(ac)} />;
}
