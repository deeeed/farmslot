import { useEffect, useState } from 'react';

import { commandCenterUrlError } from '@farmslot/protocol/surfaces/view-links';

import type { GatewayProfile } from '../../lib/gateway-profiles';
import { useConnectionStore } from '../../store/connection';

export function useCommandCenterUrlController(profile: GatewayProfile) {
  const saveProfile = useConnectionStore((state) => state.saveProfile);
  const [value, setValue] = useState(profile.commandCenterUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    setValue(profile.commandCenterUrl ?? '');
    setMessage('');
  }, [profile.id, profile.commandCenterUrl]);
  const save = async () => {
    if (saving) return;
    const url = value.trim();
    const error = url ? commandCenterUrlError(url) : null;
    if (error) {
      setMessage(error);
      return;
    }
    const current = useConnectionStore
      .getState()
      .profiles.find((candidate) => candidate.id === profile.id);
    if (!current || current.url !== profile.url) {
      setMessage('The gateway profile changed. Open it again.');
      return;
    }
    setSaving(true);
    try {
      await saveProfile({ ...current, commandCenterUrl: url });
      setMessage('Command Center URL saved');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Unable to save the Command Center URL.');
    } finally {
      setSaving(false);
    }
  };
  return { value, setValue, saving, message, save };
}
