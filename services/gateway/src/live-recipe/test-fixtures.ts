import { createHash } from 'node:crypto';
import path from 'node:path';

import { WebSocket } from 'ws';

import type { Run } from '@farmslot/protocol';

import { handleNodeResponse } from '../fleet/node-rpc.js';
import { farmslotRoot } from '../projects/repo-root.js';

export const poolDir = path.join(farmslotRoot, 'pool');

export class FakeNodeWebSocket {
  readyState = WebSocket.OPEN;

  constructor(
    private readonly handlers: {
      onRead?: (params: { path: string }) => { content: string } | undefined;
      onList?: (params: {
        path: string;
      }) => { entries: Array<{ name: string; type: string; size?: number }> } | undefined;
    },
  ) {}

  send(raw: string) {
    const frame = JSON.parse(raw) as { id: string; method: string; params: { path: string } };
    queueMicrotask(() => {
      if (frame.method === 'fs.read') {
        const result = this.handlers.onRead?.(frame.params);
        if (result) {
          handleNodeResponse(frame.id, true, result);
        } else {
          handleNodeResponse(frame.id, false, null, `ENOENT: ${frame.params.path}`);
        }
        return;
      }
      if (frame.method === 'fs.readBase64') {
        const result = this.handlers.onRead?.(frame.params);
        if (result) {
          const bytes = Buffer.from(result.content);
          handleNodeResponse(frame.id, true, {
            content: bytes.toString('base64'),
            size: bytes.length,
          });
        } else {
          handleNodeResponse(frame.id, false, null, `ENOENT: ${frame.params.path}`);
        }
        return;
      }
      if (frame.method === 'fs.hash') {
        const result = this.handlers.onRead?.(frame.params);
        if (result) {
          const bytes = Buffer.from(result.content);
          handleNodeResponse(frame.id, true, {
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
          });
        } else {
          handleNodeResponse(frame.id, false, null, `ENOENT: ${frame.params.path}`);
        }
        return;
      }
      if (frame.method === 'fs.list') {
        const result = this.handlers.onList?.(frame.params);
        if (result) {
          handleNodeResponse(frame.id, true, result);
        } else {
          handleNodeResponse(frame.id, false, null, `EIO: ${frame.params.path}`);
        }
        return;
      }
      handleNodeResponse(frame.id, false, null, `unexpected method ${frame.method}`);
    });
  }
}

export function makeRun(taskFile: string | null, overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-live-1',
    familyId: overrides.familyId ?? 'family-live-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'PROJ-1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'dev',
    mode: overrides.mode ?? 'interactive',
    status: overrides.status ?? 'monitoring',
    project: overrides.project ?? 'example-mobile-farm',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    app: overrides.app,
    slotId: overrides.slotId ?? 'slot-1',
    branch: overrides.branch ?? 'feat/live-recipe',
    taskFile,
    activeTaskFile: overrides.activeTaskFile,
    prNumber: overrides.prNumber,
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics ?? {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: overrides.createdAt ?? '2026-04-21T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-21T00:00:00.000Z',
    ticketData: overrides.ticketData,
    grade: overrides.grade,
    humanGrade: overrides.humanGrade,
    links: overrides.links,
    summary: overrides.summary,
    reviewTier: overrides.reviewTier,
    safetyTier: overrides.safetyTier,
    completedAt: overrides.completedAt,
    error: overrides.error,
    monitorState: overrides.monitorState,
    ciWatchState: overrides.ciWatchState,
    engineState: overrides.engineState,
    liveRecipeContext: overrides.liveRecipeContext,
  };
}
