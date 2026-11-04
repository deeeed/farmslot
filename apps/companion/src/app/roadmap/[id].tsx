import { useLocalSearchParams } from 'expo-router';

import { withViewState } from '../../components/view-state';
import RoadmapDetailScreen from '../../features/planning/RoadmapDetailScreen';
import { useRoadmapDetailController } from '../../features/planning/use-roadmap-detail-controller';

function RoadmapDetailRoute() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const itemId = Array.isArray(id) ? id[0] : id;
  return <RoadmapDetailScreen screen={useRoadmapDetailController(itemId)} />;
}

export default withViewState(RoadmapDetailRoute);
