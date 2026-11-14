import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ExecutionTemplateReference } from '@farmslot/protocol';

import { inferTemplateMetadata } from './infer.js';
import { executionTemplateEntryCompatible } from './select.js';
import type { ExecutionTemplateEntry, SelectedExecutionTemplate } from './types.js';

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function executionTemplateReference(
  entry: ExecutionTemplateEntry,
  renderedMarkdown?: string,
): ExecutionTemplateReference {
  const declaredVersion = entry.frontmatter?.version;
  const firstSubtask = entry.frontmatter?.firstSubtask;
  if (
    firstSubtask !== undefined &&
    (firstSubtask !== 'derive-acceptance' || entry.flow !== 'pr-complete')
  )
    throw new Error('firstSubtask must be derive-acceptance on a PR-completion template');
  return {
    id: entry.id,
    sourceId: entry.sourceId,
    flow: entry.flow,
    platforms: entry.platforms,
    labels: entry.labels,
    relativePath: entry.relativePath,
    ...(firstSubtask ? { firstSubtask } : {}),
    ...(entry.sourceRevision ? { sourceRevision: entry.sourceRevision } : {}),
    ...(entry.sourceDirty === undefined ? {} : { sourceDirty: entry.sourceDirty }),
    ...(declaredVersion == null || declaredVersion === ''
      ? {}
      : { version: String(declaredVersion) }),
    sha256: entry.sha256,
    ...(renderedMarkdown === undefined ? {} : { renderedSha256: sha256Text(renderedMarkdown) }),
  };
}

export function readExecutionTemplateSnapshot(entry: ExecutionTemplateEntry): {
  markdown: string;
  reference: ExecutionTemplateReference;
} {
  const markdown = readFileSync(entry.path, 'utf8');
  if (sha256Text(markdown) !== entry.sha256) {
    throw new Error(
      `Execution template "${entry.id}" changed after catalog resolution. Refresh the catalog and select it again.`,
    );
  }
  return { markdown, reference: executionTemplateReference(entry) };
}

export function materializeExecutionTemplate(
  entry: ExecutionTemplateEntry,
  outputPath: string,
): {
  path: string;
  reference: ExecutionTemplateReference;
} {
  const destination = path.resolve(outputPath);
  if (existsSync(destination)) {
    throw new Error(`Execution-template destination already exists: ${destination}`);
  }
  const snapshot = readExecutionTemplateSnapshot(entry);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, snapshot.markdown, { encoding: 'utf8', flag: 'wx' });
  return {
    path: destination,
    reference: executionTemplateReference(entry, snapshot.markdown),
  };
}

/** Select one trial-owned Markdown snapshot without scanning or registering a source. */
export interface CandidateExecutionTemplateInput {
  path: string;
  relativePath: string;
  markdown: string;
  flow: string;
  platform?: string;
  domain?: string;
}

export function candidateExecutionTemplate(
  input: CandidateExecutionTemplateInput,
): SelectedExecutionTemplate & { markdown: string } {
  const entry = {
    ...inferTemplateMetadata({
      // Storage names must not change filename-derived platform metadata.
      absolutePath: input.relativePath,
      relativePath: input.relativePath,
      source: {
        id: 'eval-candidate',
        kind: 'custom',
        root: path.dirname(input.path),
        layout: 'flow-tree',
      },
      text: input.markdown,
    }),
    path: input.path,
  };
  if (!executionTemplateEntryCompatible(entry, input))
    throw new Error('Candidate template is incompatible with the trial flow, platform or domain.');
  return {
    entry,
    markdown: input.markdown,
    reason: 'explicit',
    reference: executionTemplateReference(entry),
  };
}
