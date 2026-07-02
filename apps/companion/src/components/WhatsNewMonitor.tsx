import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';

import { getCompanionEnvironment } from '../lib/app-environment';
import { COMPANION_RELEASE_NOTES, isVersionNewer } from '../lib/release-notes';

import { WhatsNewModal } from './WhatsNewModal';

const WHATS_NEW_SEEN_VERSION_KEY = '@farmslot:whats-new-seen-version';

export const WhatsNewMonitor = React.memo(function WhatsNewMonitor() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let disposed = false;
    const evaluate = async () => {
      const notes = COMPANION_RELEASE_NOTES;
      if (!notes.items.length) return;
      const seenVersion = await AsyncStorage.getItem(WHATS_NEW_SEEN_VERSION_KEY);
      const { appVersion } = getCompanionEnvironment();
      const targetVersion = notes.version || appVersion;
      if (!isVersionNewer(targetVersion, seenVersion)) return;
      if (!disposed) setVisible(true);
    };
    void evaluate();
    return () => {
      disposed = true;
    };
  }, []);

  const dismiss = async () => {
    const notes = COMPANION_RELEASE_NOTES;
    const { appVersion } = getCompanionEnvironment();
    await AsyncStorage.setItem(WHATS_NEW_SEEN_VERSION_KEY, notes.version || appVersion);
    setVisible(false);
  };

  return (
    <WhatsNewModal
      visible={visible}
      notes={COMPANION_RELEASE_NOTES}
      onDismiss={() => void dismiss()}
    />
  );
});
