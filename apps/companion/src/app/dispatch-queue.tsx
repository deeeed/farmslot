import DispatchQueueScreen from '../features/planning/DispatchQueueScreen';
import { useDispatchQueueController } from '../features/planning/use-dispatch-queue-controller';

export default function DispatchQueueRoute() {
  return <DispatchQueueScreen screen={useDispatchQueueController()} />;
}
