import { useLocalSearchParams } from 'expo-router';

import { GateReviewScreen } from '../../features/gate-review/GateReviewScreen';
import { useGateReviewController } from '../../features/gate-review/use-gate-review-controller';
import { routeParamString } from '../../features/workspace-shared/route-params';

export default function GateReviewRoute() {
  const { decisionId, runId } = useLocalSearchParams<{
    decisionId: string | string[];
    runId: string | string[];
  }>();
  const screen = useGateReviewController({
    runId: routeParamString(runId),
    decisionId: routeParamString(decisionId),
  });
  return <GateReviewScreen {...screen} />;
}
