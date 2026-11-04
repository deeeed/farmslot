import { withViewState } from '../components/view-state';
import { useWorkGraphsController } from '../features/planning/use-work-graphs-controller';
import WorkGraphsScreen from '../features/planning/WorkGraphsScreen';

function WorkGraphsRoute() {
  return <WorkGraphsScreen screen={useWorkGraphsController()} />;
}

export default withViewState(WorkGraphsRoute);
