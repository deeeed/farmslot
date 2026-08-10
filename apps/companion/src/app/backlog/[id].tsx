import { useLocalSearchParams } from 'expo-router';

import BacklogDetailScreen from '../../features/planning/BacklogDetailScreen';
import { useBacklogDetailController } from '../../features/planning/use-backlog-detail-controller';

export default function BacklogDetailRoute() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const itemId = Array.isArray(id) ? id[0] : id;
  return <BacklogDetailScreen screen={useBacklogDetailController(itemId)} />;
}
