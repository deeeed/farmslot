import { useLocalSearchParams, useRouter } from 'expo-router';

import { CopilotScreen } from '../../features/copilot/CopilotScreen';
import { useCopilotController } from '../../features/copilot/use-copilot-controller';
import { firstRouteParam, tmuxWorkerRouteParamsFromRef } from '../../lib/tmux-workers';

export default function CopilotRoute() {
  const router = useRouter();
  const { draft } = useLocalSearchParams<{ draft?: string | string[] }>();
  const pendingDraft = firstRouteParam(draft)?.trim();
  const screen = useCopilotController();
  return (
    <CopilotScreen
      {...screen}
      draft={pendingDraft}
      openNative={() =>
        router.push({ pathname: '/native', params: pendingDraft ? { draft: pendingDraft } : {} })
      }
      openTerminal={(session) => {
        if (session.status !== 'running' || !session.terminalWorker) return;
        router.push({
          pathname: '/terminal/worker',
          params: {
            ...tmuxWorkerRouteParamsFromRef(session.terminalWorker, 'Co-Pilot'),
            ...(pendingDraft ? { draft: pendingDraft } : {}),
          },
        });
      }}
    />
  );
}
