import { useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';

import type { Run } from '@farmslot/protocol';

import { currentFarmConnection } from '../../lib/connection-authority';
import { reviewPublicationView } from '../../lib/review-publication';
import { useConnectionStore } from '../../store/connection';
import { useRunStore } from '../../store/runs';

import { retryReviewPublication } from './review-publication-action';

export function useReviewPublication(run: Run) {
  const client = useConnectionStore((state) => state.client);
  const profileId = useConnectionStore((state) => state.activeProfileId);
  const epoch = useConnectionStore((state) => state.authorityEpoch);
  const status = useConnectionStore((state) => state.status);
  const identity = `${run.id}:${profileId}:${epoch}:${client?.connectionGeneration}`;
  const scope = useRef({ client, identity });
  if (scope.current.client !== client || scope.current.identity !== identity)
    scope.current = { client, identity };
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [action, setAction] = useState<{ scope: object; busy: boolean; error?: string }>();
  const pending = useRef<object | undefined>(undefined);
  const currentAction = action?.scope === scope.current ? action : undefined;
  const storedRun = useRunStore((state) => state.runs.find((item) => item.id === run.id));
  const viewModel = reviewPublicationView(
    storedRun && storedRun.updatedAt >= run.updatedAt ? storedRun : run,
  );
  const execute = async (operation: 'retry' | 'open') => {
    if (!client || status !== 'connected' || pending.current === scope.current) return;
    const capturedScope = scope.current;
    const isCurrentConnection = currentFarmConnection(client);
    const current = () =>
      active.current &&
      scope.current === capturedScope &&
      useConnectionStore.getState().client === client &&
      useConnectionStore.getState().activeProfileId === profileId &&
      useConnectionStore.getState().authorityEpoch === epoch &&
      isCurrentConnection();
    pending.current = capturedScope;
    setAction({ scope: capturedScope, busy: true });
    try {
      if (operation === 'open') {
        if (viewModel?.url) await Linking.openURL(viewModel.url);
      } else {
        await retryReviewPublication(client, run.id, current, useRunStore.getState().upsertRun);
      }
      if (current()) setAction({ scope: capturedScope, busy: false });
    } catch (error) {
      if (current())
        setAction({
          scope: capturedScope,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (pending.current === capturedScope) pending.current = undefined;
    }
  };
  return {
    viewModel,
    busy: currentAction?.busy ?? false,
    error: viewModel?.state === 'published' ? undefined : currentAction?.error,
    disabled: status !== 'connected',
    retry: () => {
      void execute('retry');
    },
    open: () => {
      void execute('open');
    },
  };
}
