import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';

import { quickVoiceWorkerKey } from '../../lib/quick-actions';
import { tmuxWorkerRouteParamsFromRef } from '../../lib/tmux-workers';
import { useCopilotController } from '../copilot/use-copilot-controller';

import { useQuickActions } from './quick-actions-context';

/** Mounted only after an explicit Voice gesture, never to warm a hidden view. */
export function CopilotVoiceHandoff({
  context,
  scope,
  done,
}: {
  context: string;
  scope: string;
  done(): void;
}) {
  const { viewModel } = useCopilotController();
  const actions = useQuickActions();
  const router = useRouter();
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    if (actions.scope !== scope) {
      handled.current = true;
      done();
      return;
    }
    if (viewModel.loading) {
      return;
    }
    if (viewModel.connected && !viewModel.settled) return;
    handled.current = true;
    const worker =
      viewModel.connected && !viewModel.error && viewModel.runtime?.status === 'running'
        ? viewModel.runtime.terminalWorker
        : undefined;
    if (worker) {
      actions.requestVoice(quickVoiceWorkerKey(worker), context);
      router.push({
        pathname: '/terminal/worker',
        params: tmuxWorkerRouteParamsFromRef(worker, 'Co-Pilot'),
      });
    } else {
      router.push({ pathname: '/(tabs)/copilot', params: { draft: context } });
    }
    done();
  }, [actions, context, done, router, scope, viewModel]);
  return null;
}
