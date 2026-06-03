import React, { useEffect, useRef } from 'react';

import { useAppUpdates } from '../hooks/useAppUpdates';

export const AppUpdatesMonitor = React.memo(function AppUpdatesMonitor() {
  const { checkUpdates } = useAppUpdates();
  const hasCheckedForUpdates = useRef(false);

  useEffect(() => {
    if (hasCheckedForUpdates.current) return;
    hasCheckedForUpdates.current = true;
    void checkUpdates({ silent: true, reloadWhenDownloaded: true });
  }, [checkUpdates]);

  return null;
});
