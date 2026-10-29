import React from 'react';

import BacklogScreen from '../../features/planning/BacklogScreen';
import { useBacklogController } from '../../features/planning/use-backlog-controller';

export default function BacklogRoute() {
  return <BacklogScreen screen={useBacklogController()} />;
}
