import type { Run } from '../../src/contracts/runs.js';

export function storedRun(id: string, fields: Partial<Run> = {}): Run {
  return {
    id,
    familyId: `family-${id}`,
    lane: 'production',
    flowType: 'dev',
    status: 'done',
    project: 'farm',
    ticketOrPr: id,
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...fields,
  };
}
