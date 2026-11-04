import { useLocalSearchParams } from 'expo-router';

import { withViewState } from '../../components/view-state';
import { VisualReviewScreen } from '../../features/visual-review/VisualReviewScreen';
import { routeParamString } from '../../features/workspace-shared/route-params';

function VisualReviewRoute() {
  const { runId, source, recipeRun } = useLocalSearchParams<{
    runId: string | string[];
    source?: string | string[];
    recipeRun?: string | string[];
  }>();
  return (
    <VisualReviewScreen
      route={{
        runId: routeParamString(runId),
        sourcePath: routeParamString(source) || undefined,
        recipeRunId: routeParamString(recipeRun) || undefined,
      }}
    />
  );
}

export default withViewState(VisualReviewRoute);
