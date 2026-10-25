import { isRecord } from '@farmslot/protocol/recipe';

/** Check caller-supplied ticket data before it becomes a durable run input. */
export function assertValidTicketData(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error('Invalid field: ticketData (expected an object)');
  const invalid = (field: string, expected: string) =>
    new Error(
      `${value[field] === undefined ? 'Missing required' : 'Invalid'} field: ticketData.${field} (expected ${expected})`,
    );
  for (const field of ['title', 'description', 'affectedArea']) {
    if (typeof value[field] !== 'string') throw invalid(field, 'a string');
  }
  if (
    typeof value.source !== 'string' ||
    !['jira', 'github', 'both', 'manual'].includes(value.source)
  )
    throw invalid('source', 'jira, github, both or manual');
  for (const field of ['acceptanceCriteria', 'stepsToReproduce', 'screenshots', 'labels']) {
    const entries = value[field];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string'))
      throw invalid(field, 'an array of strings');
  }
}
