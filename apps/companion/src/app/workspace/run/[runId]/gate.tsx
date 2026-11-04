import { withViewState } from '../../../../components/view-state';
import DecisionWorkspaceScreen from '../../../../features/decision-workspace/DecisionWorkspaceScreen';

function RunGateRoute() {
  return <DecisionWorkspaceScreen embedded />;
}

export default withViewState(RunGateRoute);
