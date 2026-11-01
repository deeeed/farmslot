import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { AGENT_ROLES } from '@farmslot/protocol';

import type { TerminalSelector } from '../../lib/terminal-worker-ref';
import { tmuxWorkerRefFromRouteParams } from '../../lib/tmux-workers';
import { routeParamString } from '../workspace-shared/route-params';

import { ResolvedTerminal } from './ResolvedTerminal';
import { TerminalPane } from './WorkerTerminalScreen';

type TerminalRouteParams = Record<string, string | string[] | undefined>;

/** The slot or run a terminal link names, and a draft handed over with it (Copilot voice). */
export function terminalLinkFromParams(params: TerminalRouteParams): {
  selector: TerminalSelector;
  draft: string;
} {
  const role = AGENT_ROLES.find((candidate) => candidate === routeParamString(params.role));
  const optional = (name: string) => routeParamString(params[name]) || undefined;
  return {
    selector: {
      slotId: optional('slotId'),
      runId: optional('runId'),
      contextId: optional('contextId'),
      ...(role ? { role } : {}),
    },
    draft:
      routeParamString(params.draft) ||
      routeParamString(params.voiceDraft) ||
      routeParamString(params.voiceTranscript),
  };
}

/** `/terminal/worker`: Terminals opens a pane; a slot or run link resolves its pane first. */
export default function TerminalScreen() {
  const params: TerminalRouteParams = useLocalSearchParams();
  const key = JSON.stringify(params);
  const { worker, link, title } = useMemo(
    () => ({
      worker: tmuxWorkerRefFromRouteParams(params),
      link: terminalLinkFromParams(params),
      title: routeParamString(params.title) || undefined,
    }),
    // The params object changes identity on every render; its content is the key.
    [key],
  );
  if (worker) return <TerminalPane worker={worker} title={title} initialDraft={link.draft} />;
  if (link.selector.slotId || link.selector.runId)
    return <ResolvedTerminal selector={link.selector} initialDraft={link.draft} />;
  return <TerminalPane worker={null} />;
}
