import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type {
  ConfiguredExecutionTemplateSource,
  ProjectExecutionTemplatesConfig,
  SourceEntryRef,
  UnavailableExecutionTemplateSource,
} from '@farmslot/protocol';

import {
  bundledExecutionTemplateSource,
  readBundledExecutionTemplateCatalog,
} from './bundled-catalog.js';
import type { ExecutionTemplateSource } from './types.js';

export type { UnavailableExecutionTemplateSource } from '@farmslot/protocol';

export interface ResolvedExecutionTemplateSources {
  sources: ExecutionTemplateSource[];
  unavailable: UnavailableExecutionTemplateSource[];
}

export interface ResolveConfiguredExecutionTemplateSourcesOptions {
  resolveSourceBinding?: (selection: SourceEntryRef) => {
    root: string;
    commit: string;
    lockDigest: string;
  };
  projectPackRoot: string;
  /** Runtime-selected bundle project root, independent of an installed pack's location. */
  catalogRoot?: string;
  env?: NodeJS.ProcessEnv;
}

function isWithin(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** A git answer matches spawnSync, including unavailable status on launch/output failure. */
export interface ExecutionTemplateGitResult {
  status: number | null;
  stdout: string;
}
export type ExecutionTemplateGitRunner = (args: string[]) => Promise<ExecutionTemplateGitResult>;
type SourceWalk<T> = Generator<string[], T, ExecutionTemplateGitResult>;

function runSourceWalk<T>(walk: SourceWalk<T>): T {
  let step = walk.next();
  while (!step.done) {
    let result: ExecutionTemplateGitResult;
    try {
      result = spawnSync('git', step.value, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      step = walk.throw(error);
      continue;
    }
    step = walk.next(result);
  }
  return step.value;
}
async function runSourceWalkAsync<T>(
  walk: SourceWalk<T>,
  git: ExecutionTemplateGitRunner,
): Promise<T> {
  let step = walk.next();
  while (!step.done) {
    let result: ExecutionTemplateGitResult;
    try {
      result = await git(step.value);
    } catch (error) {
      step = walk.throw(error);
      continue;
    }
    step = walk.next(result);
  }
  return step.value;
}
function* sourceRevision(root: string): SourceWalk<string | undefined> {
  const result = yield ['-C', root, 'rev-parse', 'HEAD'];
  if (result.status !== 0) return undefined;
  const revision = result.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(revision) ? revision : undefined;
}
function* sourceDirty(root: string): SourceWalk<boolean | undefined> {
  const result = yield ['-C', root, 'status', '--porcelain', '--', '.'];
  if (result.status !== 0) return undefined;
  return result.stdout.trim().length > 0;
}
export function executionTemplateSourceRevision(root: string): string | undefined {
  return runSourceWalk(sourceRevision(root));
}
export function executionTemplateSourceRevisionAsync(
  root: string,
  git: ExecutionTemplateGitRunner,
): Promise<string | undefined> {
  return runSourceWalkAsync(sourceRevision(root), git);
}
export function executionTemplateSourceDirty(root: string): boolean | undefined {
  return runSourceWalk(sourceDirty(root));
}
export function executionTemplateSourceDirtyAsync(
  root: string,
  git: ExecutionTemplateGitRunner,
): Promise<boolean | undefined> {
  return runSourceWalkAsync(sourceDirty(root), git);
}

function configuredRoot(
  source: ConfiguredExecutionTemplateSource,
  options: ResolveConfiguredExecutionTemplateSourcesOptions,
): { path?: string; reason?: UnavailableExecutionTemplateSource['reason'] } {
  if (source.root.sourceId) {
    if (!options.resolveSourceBinding) return { reason: 'invalid-root' };
    return {
      path: options.resolveSourceBinding({
        sourceId: source.root.sourceId,
        entry: source.root.entry,
      }).root,
    };
  }
  if (typeof source.root.env === 'string') {
    if (options.resolveSourceBinding) return { reason: 'invalid-root' };
    const value = (options.env ?? process.env)[source.root.env]?.trim();
    if (!value) return { reason: 'missing-environment' };
    if (!path.isAbsolute(value)) return { reason: 'invalid-root' };
    return { path: value };
  }
  return source.root.projectPath
    ? { path: path.resolve(options.projectPackRoot, source.root.projectPath) }
    : { reason: 'invalid-root' };
}

/**
 * Resolve optional configured sources only when catalog options are requested.
 * Missing roots are diagnostics, not project-load failures.
 */
export function resolveConfiguredExecutionTemplateSources(
  config: ProjectExecutionTemplatesConfig | undefined,
  options: ResolveConfiguredExecutionTemplateSourcesOptions,
): ResolvedExecutionTemplateSources {
  return runSourceWalk(configuredSources(config, options));
}

/** The same ordered source resolution, with git supplied by the async host driver. */
export function resolveConfiguredExecutionTemplateSourcesAsync(
  config: ProjectExecutionTemplatesConfig | undefined,
  options: ResolveConfiguredExecutionTemplateSourcesOptions,
  git: ExecutionTemplateGitRunner,
): Promise<ResolvedExecutionTemplateSources> {
  return runSourceWalkAsync(configuredSources(config, options), git);
}

function* configuredSources(
  config: ProjectExecutionTemplatesConfig | undefined,
  options: ResolveConfiguredExecutionTemplateSourcesOptions,
): SourceWalk<ResolvedExecutionTemplateSources> {
  const resolved: ExecutionTemplateSource[] = [];
  const unavailable: UnavailableExecutionTemplateSource[] = [];
  const bundled = options.resolveSourceBinding
    ? undefined
    : readBundledExecutionTemplateCatalog(options.catalogRoot ?? options.projectPackRoot);

  for (const source of config?.sources ?? []) {
    if (bundled && source.root.env) {
      const selected = bundledExecutionTemplateSource(source, bundled);
      if ('reason' in selected) unavailable.push(selected);
      else resolved.push(selected);
      continue;
    }
    const rootResult = configuredRoot(source, options);
    if (!rootResult.path) {
      unavailable.push({ id: source.id, reason: rootResult.reason ?? 'invalid-root' });
      continue;
    }
    if (!existsSync(rootResult.path) || !statSync(rootResult.path).isDirectory()) {
      unavailable.push({ id: source.id, reason: 'missing-root' });
      continue;
    }

    const canonicalRoot = realpathSync(rootResult.path);
    if (
      'projectPath' in source.root &&
      !isWithin(realpathSync(options.projectPackRoot), canonicalRoot)
    ) {
      unavailable.push({ id: source.id, reason: 'invalid-root' });
      continue;
    }
    const scanPath = path.resolve(canonicalRoot, source.subpath ?? '.');
    if (!isWithin(canonicalRoot, scanPath)) {
      unavailable.push({ id: source.id, reason: 'invalid-root' });
      continue;
    }
    if (!existsSync(scanPath) || !statSync(scanPath).isDirectory()) {
      unavailable.push({ id: source.id, reason: 'missing-root' });
      continue;
    }
    const canonicalScanPath = realpathSync(scanPath);
    if (!isWithin(canonicalRoot, canonicalScanPath)) {
      unavailable.push({ id: source.id, reason: 'invalid-root' });
      continue;
    }
    const revision = yield* sourceRevision(canonicalScanPath);
    const dirty = yield* sourceDirty(canonicalScanPath);

    resolved.push({
      id: source.id,
      kind: source.kind,
      root: canonicalScanPath,
      layout: 'flow-tree',
      ...(source.domains ? { domains: source.domains } : {}),
      ...(revision ? { sourceRevision: revision } : {}),
      ...(dirty === undefined ? {} : { sourceDirty: dirty }),
    });
  }

  return { sources: resolved, unavailable };
}
