import { useCallback, useEffect, useState } from 'react';

export type TerminalOrientationMode = 'portrait' | 'landscape';

type ScreenOrientationModule = typeof import('expo-screen-orientation');

type OrientationStatus = 'ready' | 'applying' | 'unsupported' | 'failed';

export type TerminalOrientationControls = {
  mode: TerminalOrientationMode;
  status: OrientationStatus;
  toggle: () => void;
};

async function loadScreenOrientation(): Promise<ScreenOrientationModule | null> {
  try {
    return await import('expo-screen-orientation');
  } catch (error) {
    // Expected on already-installed dev clients until the native module is rebuilt in.
    void error;
    return null;
  }
}

async function requestTerminalOrientation(
  mode: TerminalOrientationMode,
): Promise<OrientationStatus> {
  const ScreenOrientation = await loadScreenOrientation();
  if (!ScreenOrientation) return 'unsupported';
  try {
    await ScreenOrientation.lockAsync(
      mode === 'landscape'
        ? ScreenOrientation.OrientationLock.LANDSCAPE
        : ScreenOrientation.OrientationLock.PORTRAIT_UP,
    );
    return 'ready';
  } catch (error) {
    // Treat native lock rejection as recoverable so old builds keep terminal controls usable.
    void error;
    return 'failed';
  }
}

export function useTerminalOrientationControls(active: boolean): TerminalOrientationControls {
  const [mode, setMode] = useState<TerminalOrientationMode>('portrait');
  const [status, setStatus] = useState<OrientationStatus>('ready');

  const applyMode = useCallback(async (nextMode: TerminalOrientationMode) => {
    setStatus('applying');
    const result = await requestTerminalOrientation(nextMode);
    setStatus(result);
    if (result === 'ready') setMode(nextMode);
  }, []);

  const toggle = useCallback(() => {
    const nextMode = mode === 'landscape' ? 'portrait' : 'landscape';
    void applyMode(nextMode);
  }, [applyMode, mode]);

  useEffect(() => {
    if (active) return;
    if (mode === 'portrait') return;
    void applyMode('portrait');
  }, [active, applyMode, mode]);

  useEffect(
    () => () => {
      void requestTerminalOrientation('portrait');
    },
    [],
  );

  return { mode, status, toggle };
}
