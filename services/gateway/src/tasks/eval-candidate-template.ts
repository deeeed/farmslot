import { readFile } from 'node:fs/promises';

import { candidateExecutionTemplate } from '@farmslot/agent-runtime';
import type { RunEngineState } from '@farmslot/protocol';

import type { ResolvedConfiguredExecutionTemplate } from './execution-template-catalog.js';

export type EvalCandidateTemplate = NonNullable<
  NonNullable<RunEngineState['evalExperiment']>['candidateTemplate']
>;

export async function readEvalCandidateTemplate(
  snapshot: EvalCandidateTemplate,
  context?: { flow: string; platform?: string; domain?: string },
): Promise<ResolvedConfiguredExecutionTemplate> {
  const selected = candidateExecutionTemplate({
    path: snapshot.path,
    markdown: await readFile(snapshot.path, 'utf8'),
    flow: snapshot.reference.flow,
    relativePath: snapshot.reference.relativePath,
    ...context,
  });
  if (selected.reference.sha256 !== snapshot.reference.sha256)
    throw new Error('Frozen candidate template hash mismatch.');
  return selected;
}
