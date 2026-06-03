import assert from 'node:assert/strict';
import test from 'node:test';

import type { PendingDecision, Run } from '@farmslot/protocol';

import { decisionDisplayTitle, runDisplayTitle } from './run-display';

test('runDisplayTitle prefers fetched PR or ticket title before generated summary', () => {
  assert.deepEqual(
    runDisplayTitle({
      ticketOrPr: 'example-org/example-mobile#30125',
      summary: 'Generated fallback summary',
      branch: 'feat/mobile-fix',
      ticketData: {
        source: 'github',
        title: 'Fix perps amount validation on mobile',
        description: '',
        acceptanceCriteria: [],
        affectedArea: '',
        stepsToReproduce: [],
        screenshots: [],
        labels: [],
      },
    } as Pick<Run, 'ticketOrPr' | 'summary' | 'ticketData' | 'branch'>),
    {
      title: 'Fix perps amount validation on mobile',
      subtitle: 'example-org/example-mobile#30125',
    },
  );
});

test('runDisplayTitle uses generated summary when ticket title is unavailable', () => {
  assert.deepEqual(
    runDisplayTitle({
      ticketOrPr: 'PROJ-3077',
      summary: 'Fix unspecified application bug',
      branch: 'fix/proj-3077-fix-application-bug',
    } as Pick<Run, 'ticketOrPr' | 'summary' | 'ticketData' | 'branch'>),
    { title: 'Fix unspecified application bug', subtitle: 'PROJ-3077' },
  );
});

test('decisionDisplayTitle prefers ready-gate input ticket title before gate label', () => {
  assert.deepEqual(
    decisionDisplayTitle({
      id: 'd1',
      type: 'engine_ready_gate',
      slotId: 'runner-browser-1',
      title: 'PROJ-2970 — human gate',
      description: 'Review ready gate',
      context: {},
      actions: [],
      createdAt: '2026-05-22T10:09:20.000Z',
      runMeta: {
        runId: 'r1',
        flowType: 'fix-bug',
        ticketOrPr: 'PROJ-2970',
        summary: 'Generated summary',
      },
      payload: {
        kind: 'ready',
        inputSnapshot: {
          ticketData: { title: 'Show liquidation distance on perps positions' },
        },
      } as unknown as PendingDecision['payload'],
    }),
    { title: 'Show liquidation distance on perps positions', subtitle: 'PROJ-2970 — human gate' },
  );
});
