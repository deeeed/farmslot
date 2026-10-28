import RoadmapScreen from '../../features/planning/RoadmapScreen';
import { useRoadmapViewSharing } from '../../features/quick-actions/use-roadmap-view-sharing';

export default function RoadmapRoute() {
  return <RoadmapScreen screen={useRoadmapViewSharing()} />;
}
