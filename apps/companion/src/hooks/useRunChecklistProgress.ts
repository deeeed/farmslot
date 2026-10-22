import { useEffect, useRef, useState } from 'react';

import {
  Events,
  Methods,
  type Run,
  type TaskProgressResult,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
} from '@farmslot/protocol';
import { acceptsRunChecklistProgress, runChecklistProgressTarget } from '@farmslot/review-dispatch';

import { useConnectionStore } from '../store/connection';

/** List rows read the same projection and accept the same live updates as detail. */
export function useRunChecklistProgress(run: Run) {
  const client = useConnectionStore((state) => state.client);
  const status = useConnectionStore((state) => state.status);
  const target = runChecklistProgressTarget(run);
  const current = useRef(run);
  current.current = run;
  const [snapshot, setSnapshot] = useState<{
    key: string;
    progress: TaskProgressStructured | null;
    error?: string;
  } | null>(null);
  const key = target?.key;
  useEffect(() => {
    const request = runChecklistProgressTarget(current.current);
    if (!client || !request) return;
    let disposed = false;
    let eventReceived = false;
    const unsubscribe = client.subscribe(Events.TASK_PROGRESS_UPDATED, (payload) => {
      const update = payload as TaskProgressUpdatedPayload;
      if (!acceptsRunChecklistProgress(current.current, update)) return;
      eventReceived = true;
      setSnapshot({ key: request.key, progress: update.progress.structured ?? null });
    });
    void client.request<TaskProgressResult>(Methods.TASK_PROGRESS, request.params).then(
      (result) => {
        if (!disposed && !eventReceived)
          setSnapshot({ key: request.key, progress: result.structured ?? null });
      },
      (error: Error) => {
        if (!disposed && !eventReceived)
          setSnapshot({ key: request.key, progress: null, error: error.message });
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [client, status, key]);
  return snapshot?.key === key ? snapshot : null;
}
