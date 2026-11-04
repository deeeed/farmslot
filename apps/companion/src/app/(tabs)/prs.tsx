import React from 'react';

import { PRDashboardScreen } from '../../components/PRDashboardScreen';
import { withViewState } from '../../components/view-state';

function PullRequestsTabScreen() {
  return <PRDashboardScreen />;
}

export default withViewState(PullRequestsTabScreen);
