import { useLocalSearchParams } from 'expo-router';

import { routeParamString } from '../../../../features/workspace-shared/route-params';
import { SlotWorkspaceTabsProvider } from '../../../../features/workspace-shared/slot-workspace-tabs';
import { WorkspaceTabsLayout } from '../../../../features/workspace-shared/WorkspaceTabsLayout';

export default function SlotWorkspaceTabsLayout() {
  const { slotId } = useLocalSearchParams<{ slotId: string | string[] }>();
  const resolvedSlotId = routeParamString(slotId);
  const params = { slotId: resolvedSlotId };

  return (
    <SlotWorkspaceTabsProvider>
      <WorkspaceTabsLayout
        fallbackHref="/(tabs)/fleet"
        title={resolvedSlotId}
        tabs={[
          {
            href: { pathname: '/workspace/slot/[slotId]/slot', params },
            label: 'Slot',
            name: 'slot',
            testID: 'companion-slot-tab-slot',
          },
          {
            href: { pathname: '/workspace/slot/[slotId]/terminal', params },
            label: 'Terminal',
            name: 'terminal',
            testID: 'companion-slot-tab-terminal',
          },
          {
            href: { pathname: '/workspace/slot/[slotId]/diff', params },
            label: 'Diff',
            name: 'diff',
            testID: 'companion-slot-tab-diff',
          },
        ]}
      />
    </SlotWorkspaceTabsProvider>
  );
}
