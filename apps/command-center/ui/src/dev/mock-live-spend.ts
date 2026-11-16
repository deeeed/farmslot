// Live spend for the dev harness: the first six checklist segments of run 6ff29609 (Pi, DeepSeek
// V4.1 Flash), with the per-step costs the live reader computed from that session's transcript.
import type { TaskLiveSpend } from '@farmslot/protocol';

import { MOCK_TOOL_USAGE } from './mock-tool-usage.js';

const COSTS = [0.026766, 0.000746, 0.007017, 0, 0.048385, 0];

const segments = MOCK_TOOL_USAGE.steps.slice(0, 6).map((step, index) => ({
  ...step,
  // The sixth segment is the step being worked on: no mark has closed it yet.
  ...(index === 5
    ? { segment: 'after-last-mark' as const, stepNumber: undefined, title: undefined }
    : {}),
  costUsd: COSTS[index],
}));

export const MOCK_LIVE_SPEND: TaskLiveSpend = {
  runner: 'pi',
  readAt: '2026-11-15T13:12:00.000Z',
  totalTokens: segments.reduce((sum, step) => sum + (step.totalTokens ?? 0), 0),
  costUsd: COSTS.reduce((sum, cost) => sum + cost, 0),
  compactions: 0,
  toolCalls: segments.reduce((sum, step) => sum + step.toolCalls, 0),
  steps: segments,
};
