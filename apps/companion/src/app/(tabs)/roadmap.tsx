import { withViewState } from '../../components/view-state';
import RoadmapScreen from '../../features/planning/RoadmapScreen';
import { useRoadmapViewSharing } from '../../features/quick-actions/use-roadmap-view-sharing';

function RoadmapRoute() {
  return <RoadmapScreen screen={useRoadmapViewSharing()} />;
}

export default withViewState(RoadmapRoute);
