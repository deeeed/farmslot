import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';

import {
  CI_DECISION_TYPES,
  ciDecisionCheckView,
  Methods,
  type PRStatus,
  type PRStatusResult,
  type RunDecision,
} from '@farmslot/protocol';

import { useConnectedTransport } from '../../hooks/useConnectedTransport';
import { currentFarmConnection } from '../../lib/connection-authority';
import { useConnectionStore } from '../../store/connection';

interface CurrentCIState {
  key: string;
  status: 'loading' | 'ready' | 'error';
  pr: PRStatus | null;
  error: string | null;
}

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
  const eligible = CI_DECISION_TYPES.some((type) => type === decision?.type);
  const key = JSON.stringify([decision?.id, generation, pr, project, repo]);
  const [current, setCurrent] = useState<CurrentCIState>({
    key: '',
    status: 'loading',
    pr: null,
    error: null,
  });
  const [linkError, setLinkError] = useState<string | null>(null);
  const sequence = useRef(0);
  const pending = useRef(false);
  const load = useCallback(
    async (force: boolean) => {
      if (!eligible || !client || generation === null || !pr || !project || pending.current) return;
      const isCurrent = currentFarmConnection(client);
      if (!isCurrent()) return;
      const request = ++sequence.current;
      pending.current = true;
      setCurrent((old) => ({
        key,
        status: 'loading',
        pr: old.key === key ? old.pr : null,
        error: null,
      }));
      try {
        const result = await client.request<PRStatusResult>(
          Methods.PR_STATUS,
          { pr, project, force },
          30_000,
        );
        if (request !== sequence.current || !isCurrent()) return;
        setCurrent({ key, status: 'ready', pr: result.pr, error: null });
      } catch (error) {
        if (request !== sequence.current || !isCurrent()) return;
        setCurrent((old) => ({ ...old, key, status: 'error', error: (error as Error).message }));
      } finally {
        if (request === sequence.current) pending.current = false;
      }
    },
    [client, eligible, generation, key, pr, project],
  );
  useEffect(() => {
    pending.current = false;
    setLinkError(null);
    void load(false);
    return () => {
      sequence.current++;
      pending.current = false;
    };
  }, [load]);
  const visible = current.key === key ? current : null;
  return {
    view: decision
      ? ciDecisionCheckView({
          decision,
          pr,
          repo,
          current: visible?.pr,
          currentState: !pr || !project ? 'error' : (visible?.status ?? 'loading'),
        })
      : null,
    busy: visible?.status === 'loading' || !client || generation === null || !pr || !project,
    error: visible?.error ?? linkError,
    refresh: () => {
      void load(true);
    },
    openLink: (url: string) => {
      void Linking.openURL(url).catch((error: Error) => setLinkError(error.message));
    },
  };
}
