import type { RunTicketData } from '@farmslot/protocol';

import { acceptanceCriteriaFromMarkdown } from '../../external/ticket-markdown.js';

export function buildBlindTicketData(
  problem: string,
  acceptanceCriteria?: string[],
): RunTicketData {
  const criteria = acceptanceCriteria ?? acceptanceCriteriaFromMarkdown(problem);
  return {
    source: 'manual',
    title: problem.split('\n')[0].slice(0, 200),
    description: problem,
    acceptanceCriteria:
      acceptanceCriteria !== undefined || criteria.length
        ? [...criteria]
        : ['Satisfy the supplied problem statement and retain local artifacts.'],
    affectedArea: 'eval',
    stepsToReproduce: [],
    screenshots: [],
    labels: ['eval', 'artifact-only'],
  };
}
