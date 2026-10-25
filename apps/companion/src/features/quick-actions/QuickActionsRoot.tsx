import { Platform } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';

import { FloatingQuickActions } from './FloatingQuickActions';
import { useQuickActions } from './quick-actions-context';

export function QuickActionsRoot() {
  const { activeOutlet } = useQuickActions();
  if (activeOutlet) return null;
  return Platform.OS === 'ios' ? (
    <FullWindowOverlay>
      <FloatingQuickActions />
    </FullWindowOverlay>
  ) : (
    <FloatingQuickActions />
  );
}
