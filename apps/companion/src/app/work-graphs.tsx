import { useWorkGraphsController } from '../features/planning/use-work-graphs-controller';
import WorkGraphsScreen from '../features/planning/WorkGraphsScreen';

export default function WorkGraphsRoute() {
  return <WorkGraphsScreen screen={useWorkGraphsController()} />;
}
