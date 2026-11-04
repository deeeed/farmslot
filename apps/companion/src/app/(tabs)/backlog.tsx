import React from 'react';

import { withViewState } from '../../components/view-state';
import BacklogScreen from '../../features/planning/BacklogScreen';
import { useBacklogController } from '../../features/planning/use-backlog-controller';

function BacklogRoute() {
  return <BacklogScreen screen={useBacklogController()} />;
}

export default withViewState(BacklogRoute);
