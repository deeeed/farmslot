import RunDetailScreen from '../../../../features/run-detail/RunDetailScreen';
import { ReviewPackageTabProvider } from '../../../../features/workspace-shared/review-package-tabs';

export default function RunEvidenceRoute() {
  return (
    <ReviewPackageTabProvider tab="evidence">
      <RunDetailScreen />
    </ReviewPackageTabProvider>
  );
}
