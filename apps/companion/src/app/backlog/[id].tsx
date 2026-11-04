import { useLocalSearchParams } from 'expo-router';

import { withViewState } from '../../components/view-state';
import BacklogDetailScreen from '../../features/planning/BacklogDetailScreen';
import { useBacklogDetailController } from '../../features/planning/use-backlog-detail-controller';

function BacklogDetailRoute() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const itemId = Array.isArray(id) ? id[0] : id;
  return <BacklogDetailScreen screen={useBacklogDetailController(itemId)} />;
}

export default withViewState(BacklogDetailRoute);
