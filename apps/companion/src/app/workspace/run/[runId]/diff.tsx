import { withViewState } from '../../../../components/view-state';
import RunDiffScreen from '../../../../features/diff/RunDiffScreen';
import { ReviewPackageTabProvider } from '../../../../features/workspace-shared/review-package-tabs';

function RunDiffRoute() {
  return (
    <ReviewPackageTabProvider tab="diff">
      <RunDiffScreen />
    </ReviewPackageTabProvider>
  );
}

export default withViewState(RunDiffRoute);
