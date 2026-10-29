import { Platform } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';

import { FloatingQuickActions } from './FloatingQuickActions';
import { useQuickActions } from './quick-actions-context';

export function QuickActionsRoot() {
  const { activeOutlet } = useQuickActions();
  if (activeOutlet) return null;
  // The overlay's native default makes it accessibility-modal, which hides the app behind it
  // from VoiceOver and XCUITest; the quick actions float over the app, they do not replace it.
  return Platform.OS === 'ios' ? (
    <FullWindowOverlay unstable_accessibilityContainerViewIsModal={false}>
      <FloatingQuickActions />
    </FullWindowOverlay>
  ) : (
    <FloatingQuickActions />
  );
}
