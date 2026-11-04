import { withViewState } from '../../../../components/view-state';
import RunDetailScreen from '../../../../features/run-detail/RunDetailScreen';
import { ReviewPackageTabProvider } from '../../../../features/workspace-shared/review-package-tabs';

function RunEvidenceRoute() {
  return (
    <ReviewPackageTabProvider tab="evidence">
      <RunDetailScreen />
    </ReviewPackageTabProvider>
  );
}

export default withViewState(RunEvidenceRoute);
