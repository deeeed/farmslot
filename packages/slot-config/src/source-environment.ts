import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertSourceEntry, type SourceMaterialization } from '@farmslot/protocol';

import { SourceMaterializer } from './sources/materialization.js';
import { currentProjectSources, type ProjectSourceContext } from './source-binding.js';

export function sourceExecutionEnvironment(sources: ProjectSourceContext): Record<string, string> {
  const execution = sources.execution ?? sources.materialization;
  return {
    FARMSLOT_SOURCE_RECEIPT: execution.receiptPath,
    FARMSLOT_SOURCE_LOCK_DIGEST: execution.lock.digest,
    FARMSLOT_SOURCE_PACK_ID: sources.pack.sourceId,
    FARMSLOT_SOURCE_PACK_ENTRY: sources.pack.entry,
  };
}

/** A retained process keeps its immutable inputs while run ownership changes. */
export function sourceWorkerEnvironment(sources: ProjectSourceContext): Record<string, string> {
  const execution = sources.workerExecution ?? sources.execution ?? sources.materialization;
  return sourceExecutionEnvironment({ ...sources, execution });
}

export function withSourceEnvironment(command: string, sources = currentProjectSources()): string {
  if (!sources) return command;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `${Object.entries(sourceExecutionEnvironment(sources))
    .map(([key, value]) => `export ${key}=${quote(value)};`)
    .join(' ')} ${command}`;
}

/** CLI/harness invocations inherit an exact node receipt, never a branch or arbitrary source root. */
export async function executionSourceContext(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectSourceContext | undefined> {
  const current = currentProjectSources();
  if (current) return current;
  const receiptPath = env.FARMSLOT_SOURCE_RECEIPT;
  if (!receiptPath && !env.FARMSLOT_SOURCE_LOCK_DIGEST && !env.FARMSLOT_SOURCE_PACK_ID)
    return undefined;
  if (!receiptPath || !env.FARMSLOT_SOURCE_LOCK_DIGEST || !path.isAbsolute(receiptPath))
    throw new Error('Execution requires its exact source receipt and lock digest');
  const stored = JSON.parse(await readFile(receiptPath, 'utf8')) as SourceMaterialization;
  if (stored.lock.digest !== env.FARMSLOT_SOURCE_LOCK_DIGEST || stored.receiptPath !== receiptPath)
    throw new Error('Execution source receipt was substituted');
  const pack = { sourceId: env.FARMSLOT_SOURCE_PACK_ID, entry: env.FARMSLOT_SOURCE_PACK_ENTRY };
  assertSourceEntry(pack);
  const materializer = new SourceMaterializer(
    stored.receipt.nodeId,
    path.dirname(path.dirname(receiptPath)),
  );
  const materialization = await materializer.verify(stored.lock);
  return {
    project: stored.lock.context.project,
    pack,
    materialization,
    packs: stored.lock.packBindings,
  };
}
