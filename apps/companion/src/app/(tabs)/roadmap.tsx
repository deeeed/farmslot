import RoadmapScreen from '../../features/planning/RoadmapScreen';
import { useRoadmapController } from '../../features/planning/use-roadmap-controller';

export default function RoadmapRoute() {
  return <RoadmapScreen screen={useRoadmapController()} />;
}
