import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking } from 'react-native';

import {
  CI_DECISION_TYPES,
  ciDecisionCheckView,
  Methods,
  type PRStatusResult,
  type RunDecision,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { useConnectedTransport } from '../../hooks/useConnectedTransport';
import { useResourceQuery } from '../../hooks/useResourceQuery';
import { currentFarmConnection } from '../../lib/connection-authority';
import { useWorkspaceRenderAccess } from '../../lib/use-workspace-render-access';
import { useConnectionStore } from '../../store/connection';

export function useDecisionCIContext(
  decision: RunDecision | null,
  fallbackPr: number | null,
  project: string | null,
  fallbackRepo: string | null,
) {
  const pr =
    typeof decision?.context?.prNumber === 'number' ? decision.context.prNumber : fallbackPr;
  const repo = typeof decision?.context?.repo === 'string' ? decision.context.repo : fallbackRepo;
  const client = useConnectionStore((state) => state.client);
  const generation = useConnectedTransport();
  const access = useWorkspaceRenderAccess();
  const eligible = CI_DECISION_TYPES.some((type) => type === decision?.type);
  // Passive display of the gateway's shared PR observation; it updates without polling.
  const query = useMemo(
    () =>
      eligible && pr && project && access === 'farm'
        ? resourceQuery<PRStatusResult>(Methods.PR_STATUS, { pr, project })
        : undefined,
    [access, eligible, pr, project],
  );
  const observation = useResourceQuery(query);
  const [checking, setChecking] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const ticket = useRef<symbol | null>(null);
  useEffect(() => {
    ticket.current = null;
    setChecking(false);
    setCommandError(null);
    setLinkError(null);
  }, [query]);
  const checkGitHub = useCallback(async () => {
    if (!client || !query || !pr || !project || ticket.current) return;
    const isCurrent = currentFarmConnection(client);
    if (!isCurrent()) return;
    const current = Symbol();
    ticket.current = current;
    setChecking(true);
    setCommandError(null);
    try {
      // Explicit GitHub check. Its notification, not this reply, updates the observed status.
      await client.request<PRStatusResult>(Methods.PR_STATUS, { pr, project, force: true }, 30_000);
    } catch (error) {
      if (ticket.current === current && isCurrent()) setCommandError((error as Error).message);
    } finally {
      if (ticket.current === current) {
        ticket.current = null;
        setChecking(false);
      }
    }
  }, [client, pr, project, query]);
  // Without farm access there is no observation to wait for.
  const currentState =
    !pr || !project || (eligible && !query)
      ? 'error'
      : observation.data
        ? 'ready'
        : observation.status === 'error'
          ? 'error'
          : 'loading';
  return {
    view: decision
      ? ciDecisionCheckView({
          decision,
          pr,
          repo,
          current: observation.data?.pr,
          currentState,
        })
      : null,
    busy:
      (query !== undefined && observation.status === 'loading') ||
      checking ||
      !client ||
      generation === null ||
      !pr ||
      !project,
    error: commandError ?? observation.error?.message ?? linkError,
    refresh: () => {
      void checkGitHub();
    },
    openLink: (url: string) => {
      void Linking.openURL(url).catch((error: Error) => setLinkError(error.message));
    },
  };
}
