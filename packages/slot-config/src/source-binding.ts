import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import path from 'node:path';

import {
  assertSourceEntry,
  type RunSourcePlan,
  type RunSourceProvenance,
  type SourceEntryRef,
  type SourceMaterialization,
} from '@farmslot/protocol';

import { sourceLockDigest } from './sources/lock.js';

/** Only a verified materialization supplies execution-local roots. Callers select IDs and entries. */
export interface SourceBinding {
  sourceId: string;
  entry: string;
  root: string;
  commit: string;
  lockDigest: string;
}

export interface ProjectSourceContext {
  project: string;
  pack: SourceEntryRef;
  materialization: SourceMaterialization;
  execution?: SourceMaterialization;
  workerExecution?: SourceMaterialization;
  packs?: Record<string, SourceEntryRef>;
}

const context = new AsyncLocalStorage<ProjectSourceContext>();
const legacy = new AsyncLocalStorage<string | undefined>();
let projectProvider: ((project: string) => Promise<ProjectSourceContext>) | undefined;
let projectNames: (() => string[]) | undefined;

export function configureProjectSources(
  provider: (project: string) => Promise<ProjectSourceContext>,
  names: () => string[],
): void {
  projectProvider = provider;
  projectNames = names;
}

export function declaredProjectNames(): string[] | undefined {
  if (legacy.getStore()) return undefined;
  return projectNames?.();
}

export function currentProjectSources(): ProjectSourceContext | undefined {
  if (legacy.getStore()) return undefined;
  return context.getStore();
}

export function withProjectSources<T>(value: ProjectSourceContext, operation: () => T): T {
  return legacy.run(undefined, () => context.run(value, operation));
}

export function withLegacyProjectSources<T>(project: string, operation: () => T): T {
  return legacy.run(project, operation);
}

export async function projectSourceContext(
  project: string,
): Promise<ProjectSourceContext | undefined> {
  if (legacy.getStore()) return undefined;
  const current = context.getStore();
  if (current) return lockedProjectContext(current, project);
  if (projectProvider) return projectProvider(project);
  if (process.env.FARMSLOT_SOURCE_RECEIPT || process.env.FARMSLOT_SOURCE_LOCK_DIGEST) {
    const { executionSourceContext } = await import('./source-environment.js');
    const execution = await executionSourceContext();
    if (!execution) throw new Error('Project does not belong to the admitted source closure');
    return lockedProjectContext(execution, project);
  }
  return undefined;
}

function lockedProjectContext(value: ProjectSourceContext, project: string): ProjectSourceContext {
  if (value.project === project) return value;
  const pack = value.materialization.lock.packBindings[project];
  if (!pack) throw new Error(`Pack is outside the admitted source closure: ${project}`);
  return { ...value, project, pack };
}

export function resolveSourceBinding(
  selection: SourceEntryRef,
  materialization: SourceMaterialization,
): SourceBinding {
  assertSourceEntry(selection);
  const entry = materialization.lock.entries.find((value) => value.sourceId === selection.sourceId);
  const sourceRoot = materialization.roots[selection.sourceId];
  if (!entry || !sourceRoot || materialization.receipt.lockDigest !== materialization.lock.digest)
    throw new Error(`Source has no verified binding: ${selection.sourceId}`);
  const root = realpathSync(path.join(sourceRoot, selection.entry));
  const relative = path.relative(realpathSync(sourceRoot), root);
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
    throw new Error('Source binding escapes its materialization');
  return { ...selection, root, commit: entry.commit, lockDigest: materialization.lock.digest };
}

export async function projectPackRoot(project: string, legacyRoot: string): Promise<string> {
  const selected = await projectSourceContext(project);
  return selected ? resolveSourceBinding(selected.pack, selected.materialization).root : legacyRoot;
}

export function expandSourceBindings(value: string, sources?: ProjectSourceContext): string {
  for (const match of value.matchAll(/\{\{source:[a-zA-Z0-9._-]+\}\}\/([^\s'"`;&|]*)/g))
    assertSourceEntry({ sourceId: 'binding', entry: match[1] });
  if (!sources && /\{\{source:/.test(value))
    throw new Error('Source placeholders require a verified execution lock');
  let result = value;
  if (sources) {
    const materialization = sources.execution ?? sources.materialization;
    const packs = { ...sources.packs, [sources.project]: sources.pack };
    result = result.replace(
      /\{\{(?:farmslot_dir|FARMSLOT_DIR|node_support_dir|NODE_SUPPORT_DIR)\}\}\/projects\/([a-zA-Z0-9._-]+)/g,
      (_match, project: string) => {
        const binding = packs[project];
        if (!binding || !materialization.roots[binding.sourceId])
          throw new Error(`Undeclared pack reference: ${project}`);
        return path.join(materialization.roots[binding.sourceId], binding.entry);
      },
    );
  }
  return result.replace(/\{\{source:([a-zA-Z0-9._-]+)\}\}/g, (_match, sourceId: string) => {
    if (!sources) throw new Error('Missing source binding context');
    const materialization = sources.execution ?? sources.materialization;
    const entry = materialization.lock.entries.find((item) => item.sourceId === sourceId);
    if (!entry || !materialization.roots[sourceId])
      throw new Error(`Undeclared source placeholder: ${sourceId}`);
    return materialization.roots[sourceId];
  });
}

export function freezePlannedRunSources(runId: string): RunSourceProvenance | undefined {
  const sources = currentProjectSources();
  if (!sources) return undefined;
  const { digest: _digest, ...content } = sources.materialization.lock;
  const lock = { ...content, context: { ...content.context, runId } };
  return {
    state: 'locked',
    attemptId: `${runId}:1`,
    lock: { ...lock, digest: sourceLockDigest(lock) },
    workerLock: sources.materialization.lock,
    receiptIds: [],
    attempts: [{ id: `${runId}:1`, receiptIds: [] }],
    bindings: [
      sources.pack,
      ...sources.materialization.lock.entries.flatMap((entry) => entry.dependencies),
    ],
  };
}

export function planRunSources(runId: string, validatedSlotId?: string): RunSourcePlan | undefined {
  const captured = freezePlannedRunSources(runId);
  if (!captured) return undefined;
  return {
    state: 'planned',
    ...(validatedSlotId ? { validatedSlotId } : {}),
    lock: captured.lock,
    workerLock: captured.workerLock,
    bindings: captured.bindings,
  };
}
