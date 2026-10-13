import {
  assertSourceEntry,
  canonicalSourceRepo,
  isContainedSourceEntry,
  type SourceLock,
} from '@farmslot/protocol';

import { sourceDigest } from './git.js';

export function sourceLockDigest(lock: Omit<SourceLock, 'digest'>): string {
  return sourceDigest(lock);
}

/** Execution inputs stay identical when only ref, scope or ownership audit changes. */
export function sourceInputsDigest(lock: SourceLock): string {
  assertSourceLock(lock);
  return sourceDigest({
    schemaVersion: lock.schemaVersion,
    project: lock.context.project,
    packBindings: lock.packBindings,
    entries: lock.entries
      .map(({ sourceId, kind, repo, commit, objectFormat, treeDigest, dependencies }) => ({
        sourceId,
        kind,
        repo,
        commit,
        objectFormat,
        treeDigest,
        dependencies,
      }))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
  });
}

export function assertSourceLock(lock: SourceLock): void {
  const { digest, ...content } = lock;
  if (
    lock.schemaVersion !== 1 ||
    sourceLockDigest(content) !== digest ||
    !Number.isSafeInteger(lock.generation) ||
    lock.generation < 1 ||
    !Number.isSafeInteger(lock.declarationRevision) ||
    lock.declarationRevision < 1 ||
    !Number.isSafeInteger(lock.pinRevision) ||
    lock.pinRevision < 0 ||
    !lock.context?.project ||
    Object.keys(lock.context).some((key) => !['project', 'nodeId', 'runId'].includes(key)) ||
    !lock.packBindings ||
    !Number.isFinite(Date.parse(lock.resolvedAt)) ||
    !Array.isArray(lock.entries) ||
    !lock.entries.length ||
    Object.keys(lock).some(
      (key) =>
        ![
          'schemaVersion',
          'context',
          'generation',
          'declarationRevision',
          'pinRevision',
          'resolvedAt',
          'entries',
          'packBindings',
          'digest',
        ].includes(key),
    )
  )
    throw new Error('Invalid or unsupported source lock');
  const ids = new Set<string>();
  for (const entry of lock.entries) {
    if (
      ids.has(entry.sourceId) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.sourceId) ||
      canonicalSourceRepo(entry.repo) !== entry.repo ||
      !['pack', 'recipe-library', 'helper'].includes(entry.kind) ||
      !['sha1', 'sha256'].includes(entry.objectFormat) ||
      !(entry.objectFormat === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/).test(entry.commit) ||
      !/^[0-9a-f]{64}$/.test(entry.treeDigest) ||
      !Array.isArray(entry.dependencies) ||
      !entry.declaredRef ||
      !entry.effectiveRef ||
      Object.keys(entry).some(
        (key) =>
          ![
            'sourceId',
            'kind',
            'repo',
            'declaredRef',
            'effectiveRef',
            'commit',
            'objectFormat',
            'treeDigest',
            'resolutionGeneration',
            'scope',
            'pin',
            'dependencies',
          ].includes(key),
      )
    )
      throw new Error('Invalid source lock entry');
    ids.add(entry.sourceId);
  }
  const visited = new Set<string>();
  const visit = (id: string, stack: string[]): void => {
    if (stack.includes(id)) throw new Error('Cyclic source closure');
    if (visited.has(id)) return;
    const entry = lock.entries.find((value) => value.sourceId === id);
    if (!entry) throw new Error(`Incomplete source closure: ${id}`);
    for (const dependency of entry.dependencies) {
      if (!isContainedSourceEntry(dependency.entry))
        throw new Error('Source dependency escapes its tree');
      visit(dependency.sourceId, [...stack, id]);
    }
    visited.add(id);
  };
  for (const id of ids) visit(id, []);
  for (const binding of Object.values(lock.packBindings)) {
    assertSourceEntry(binding);
    if (!lock.entries.some((entry) => entry.sourceId === binding.sourceId && entry.kind === 'pack'))
      throw new Error('Pack binding is not in the locked closure');
  }
  if (!lock.packBindings[lock.context.project])
    throw new Error('Admission context has no locked pack binding');
}
