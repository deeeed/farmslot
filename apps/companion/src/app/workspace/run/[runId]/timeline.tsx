import { withViewState } from '../../../../components/view-state';
import RunDetailScreen from '../../../../features/run-detail/RunDetailScreen';
import { ReviewPackageTabProvider } from '../../../../features/workspace-shared/review-package-tabs';

function RunTimelineRoute() {
  return (
    <ReviewPackageTabProvider tab="timeline">
      <RunDetailScreen />
    </ReviewPackageTabProvider>
  );
}

export default withViewState(RunTimelineRoute);
