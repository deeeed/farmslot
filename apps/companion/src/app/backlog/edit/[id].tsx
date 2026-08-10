import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';

import { BacklogEditScreen } from '../../../features/planning/BacklogEditScreen';
import { useBacklogEditController } from '../../../features/planning/use-backlog-edit-controller';

export default function BacklogEditRoute() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  const itemId = Array.isArray(id) ? id[0] : id;
  const router = useRouter();
  const screen = useBacklogEditController(itemId);

  return (
    <BacklogEditScreen
      state={screen.state}
      onSaved={() => router.back()}
      onRefresh={() => void screen.actions.refresh()}
    />
  );
}
