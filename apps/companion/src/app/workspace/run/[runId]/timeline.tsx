import RunDetailScreen from '../../../../features/run-detail/RunDetailScreen';
import { ReviewPackageTabProvider } from '../../../../features/workspace-shared/review-package-tabs';

export default function RunTimelineRoute() {
  return (
    <ReviewPackageTabProvider tab="timeline">
      <RunDetailScreen />
    </ReviewPackageTabProvider>
  );
}
