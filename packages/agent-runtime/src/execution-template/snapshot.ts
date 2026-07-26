import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ExecutionTemplateReference } from '@farmslot/protocol';

import type { ExecutionTemplateEntry } from './types.js';

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function executionTemplateReference(
  entry: ExecutionTemplateEntry,
  renderedMarkdown?: string,
): ExecutionTemplateReference {
  const declaredVersion = entry.frontmatter?.version;
  return {
    id: entry.id,
    sourceId: entry.sourceId,
    flow: entry.flow,
    ...(entry.runMode ? { runMode: entry.runMode } : {}),
    platforms: entry.platforms,
    labels: entry.labels,
    relativePath: entry.relativePath,
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
