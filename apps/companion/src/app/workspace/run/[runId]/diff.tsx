import RunDiffScreen from '../../../../features/diff/RunDiffScreen';
import { ReviewPackageTabProvider } from '../../../../features/workspace-shared/review-package-tabs';

export default function RunDiffRoute() {
  return (
    <ReviewPackageTabProvider tab="diff">
      <RunDiffScreen />
    </ReviewPackageTabProvider>
  );
}
