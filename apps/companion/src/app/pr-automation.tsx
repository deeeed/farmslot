import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { PRAutomationScreen } from '../features/pr-automation/PRAutomationScreen';
import { usePRAutomationController } from '../features/pr-automation/use-pr-automation-controller';

export default function PRAutomationRoute() {
  const params = useLocalSearchParams<{
    monitorId?: string | string[];
    attentionId?: string | string[];
    notificationId?: string | string[];
  }>();
  const screen = usePRAutomationController({
    attentionId: typeof params.attentionId === 'string' ? params.attentionId : undefined,
    monitorId: typeof params.monitorId === 'string' ? params.monitorId : undefined,
    notificationId: typeof params.notificationId === 'string' ? params.notificationId : undefined,
  });
  return <PRAutomationScreen {...screen} />;
}
