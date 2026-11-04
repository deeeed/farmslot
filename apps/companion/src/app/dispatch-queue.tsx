import { withViewState } from '../components/view-state';
import DispatchQueueScreen from '../features/planning/DispatchQueueScreen';
import { useDispatchQueueController } from '../features/planning/use-dispatch-queue-controller';

function DispatchQueueRoute() {
  return <DispatchQueueScreen screen={useDispatchQueueController()} />;
}

export default withViewState(DispatchQueueRoute);
