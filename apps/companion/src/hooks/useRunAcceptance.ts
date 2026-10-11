/**
 * Reads a run's acceptance criteria and ledger (ADR-060) from `task.progress`,
 * the same source the run detail timeline uses. Unlike the timeline it reads
 * whether or not the worker is active: a run parked at a gate is exactly when
 * the ledger is reviewed. A progress broadcast for the run triggers a re-read
 * rather than replacing the data, so an update that carries no acceptance
 * fields can never empty the criteria. Each reconnect re-reads too, since
 * broadcasts sent while disconnected never arrive.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  type AcceptanceCriterionRef,
  type AcceptanceEvidenceLink,
  type AcceptanceStatusLedger,
  Events,
  Methods,
  type Run,
  type TaskProgressResult,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';

import type { GatewayClient } from '../lib/gateway-client';
import { isGatewayBackgroundPauseError } from '../lib/recoverable-errors';
import { taskProgressRequestForRun, taskProgressUpdateTargetsRun } from '../lib/task-progress';
import { type AcceptanceLedgerView, acceptanceLedgerView } from '../lib/task-progress-view';
import { useConnectionStore } from '../store/connection';

import { useConnectedTransport } from './useConnectedTransport';

export interface RunAcceptance {
  acceptanceStatus: AcceptanceStatusLedger | null;
  acceptanceCriteria: AcceptanceCriterionRef[] | null;
  acceptanceEvidenceLinks: AcceptanceEvidenceLink[] | null;
  /** Null until the first read lands, so "loading" is never mistaken for "no criteria". */
  view: AcceptanceLedgerView | null;
  error: string | null;
}

export type RunAcceptanceSource = Pick<Run, 'id' | 'slotId' | 'reviewWorkspace' | 'updatedAt'>;

type AcceptanceData = Pick<
  TaskProgressResult,
  | 'acceptanceStatus'
  | 'acceptanceCriteria'
  | 'acceptanceEvidenceLinks'
  | 'acceptanceStatusError'
  | 'acceptanceEvidenceLinksError'
>;

const NO_PROGRESS_SURFACE = 'the run has no slot or review workspace to read them from';

export function useRunAcceptance(
  client: GatewayClient | null,
  run: RunAcceptanceSource | null,
): RunAcceptance {
  const [data, setData] = useState<AcceptanceData | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [broadcasts, setBroadcasts] = useState(0);
  const requestRef = useRef(0);
  const runId = run?.id;
  const slotId = run?.slotId;
  const workspaceId = run?.reviewWorkspace?.workspaceId;
  const updatedAt = run?.updatedAt;
  const target = taskProgressRequestForRun(run);
  const noSurface = Boolean(run) && !target;
  const authorityEpoch = useConnectionStore((s) => s.authorityEpoch);
  const connection = useConnectedTransport();

  // Another gateway or principal makes the ledger on screen someone else's answer.
  useEffect(() => {
    requestRef.current += 1;
    setData(null);
    setRequestError(null);
  }, [authorityEpoch, runId, slotId, workspaceId]);

  useEffect(() => {
    if (!client || !target) return;
    if (connection === null) {
      // Drop reads in flight; the next connected transport re-reads.
      requestRef.current += 1;
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    client
      .request<TaskProgressResult>(Methods.TASK_PROGRESS, target)
      .then((result) => {
        if (requestRef.current !== requestId) return;
        setData(result);
        setRequestError(null);
      })
      .catch((err: Error) => {
        if (requestRef.current !== requestId) return;
        if (isGatewayBackgroundPauseError(err)) {
          // Backgrounding pauses gateway requests; the last ledger read stays the
          // Gateway's answer until the next refresh replaces it.
          console.warn(`Acceptance criteria refresh paused: ${err.message}`);
          return;
        }
        setRequestError(`Acceptance criteria unavailable: ${err.message}`);
      });
    // `target` is derived from the run fields listed here.
  }, [broadcasts, client, connection, runId, slotId, workspaceId, updatedAt]);

  useEffect(() => {
    if (!client || !run) return;
    return client.subscribe(Events.TASK_PROGRESS_UPDATED, (payload) => {
      if (!taskProgressUpdateTargetsRun(run, payload as TaskProgressUpdatedPayload)) return;
      setBroadcasts((count) => count + 1);
    });
  }, [client, runId, slotId, workspaceId]);

  return useMemo(() => {
    const acceptanceStatus = data?.acceptanceStatus ?? null;
    const acceptanceCriteria = data?.acceptanceCriteria ?? null;
    const acceptanceEvidenceLinks = data?.acceptanceEvidenceLinks ?? null;
    const error =
      (noSurface ? NO_PROGRESS_SURFACE : null) ??
      requestError ??
      data?.acceptanceStatusError ??
      (!acceptanceStatus ? (data?.acceptanceEvidenceLinksError ?? null) : null);
    const ledger = acceptanceStatus ?? { schemaVersion: 1 as const, criteria: [] };
    return {
      acceptanceStatus,
      acceptanceCriteria,
      acceptanceEvidenceLinks,
      view: data
        ? acceptanceLedgerView(
            ledger,
            acceptanceCriteria ?? ledger.criteria,
            acceptanceEvidenceLinks ?? [],
          )
        : null,
      error,
    };
  }, [data, noSurface, requestError]);
}
