import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type {
  ConfiguredExecutionTemplateSource,
  ProjectExecutionTemplatesConfig,
  SourceEntryRef,
  UnavailableExecutionTemplateSource,
} from '@farmslot/protocol';

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
  env?: NodeJS.ProcessEnv;
}

function isWithin(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** One `git` call's answer, as `spawnSync` reports it: exit status (null if it did not run) and stdout. */
export interface ExecutionTemplateGitResult {
  status: number | null;
  stdout: string;
}

/** Runs `git` with these arguments. The gateway passes one that does not block its event loop. */
export type ExecutionTemplateGitRunner = (args: string[]) => Promise<ExecutionTemplateGitResult>;

const revisionArgs = (root: string) => ['-C', root, 'rev-parse', 'HEAD'];
const dirtyArgs = (root: string) => ['-C', root, 'status', '--porcelain', '--', '.'];

function gitSync(args: string[]): ExecutionTemplateGitResult {
  const result = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return { status: result.status, stdout: result.stdout ?? '' };
}

function sourceRevision(result: ExecutionTemplateGitResult): string | undefined {
  if (result.status !== 0) return undefined;
  const revision = result.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(revision) ? revision : undefined;
}

function sourceDirty(result: ExecutionTemplateGitResult): boolean | undefined {
  if (result.status !== 0) return undefined;
  return result.stdout.trim().length > 0;
}

export function executionTemplateSourceRevision(root: string): string | undefined {
  return sourceRevision(gitSync(revisionArgs(root)));
}

export function executionTemplateSourceDirty(root: string): boolean | undefined {
  return sourceDirty(gitSync(dirtyArgs(root)));
}

/** `executionTemplateSourceRevision` with its `git` call run by `git`. */
export async function executionTemplateSourceRevisionAsync(
  root: string,
  git: ExecutionTemplateGitRunner,
): Promise<string | undefined> {
  return sourceRevision(await git(revisionArgs(root)));
}

/** `executionTemplateSourceDirty` with its `git` call run by `git`. */
export async function executionTemplateSourceDirtyAsync(
  root: string,
  git: ExecutionTemplateGitRunner,
): Promise<boolean | undefined> {
  return sourceDirty(await git(dirtyArgs(root)));
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

interface ConfiguredSourceRoot {
  source: ConfiguredExecutionTemplateSource;
  root: string;
}

/** The configured sources whose roots exist and stay inside their bounds, in configured order. */
function configuredSourceRoots(
  config: ProjectExecutionTemplatesConfig | undefined,
  options: ResolveConfiguredExecutionTemplateSourcesOptions,
): { roots: ConfiguredSourceRoot[]; unavailable: UnavailableExecutionTemplateSource[] } {
  const roots: ConfiguredSourceRoot[] = [];
  const unavailable: UnavailableExecutionTemplateSource[] = [];

  for (const source of config?.sources ?? []) {
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
    roots.push({ source, root: canonicalScanPath });
  }

  return { roots, unavailable };
}

function configuredSource(
  { source, root }: ConfiguredSourceRoot,
  sourceRevision: string | undefined,
  sourceDirty: boolean | undefined,
): ExecutionTemplateSource {
  return {
    id: source.id,
    kind: source.kind,
    root,
    layout: 'flow-tree',
    ...(source.domains ? { domains: source.domains } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(sourceDirty === undefined ? {} : { sourceDirty }),
  };
}

/**
 * Resolve optional configured sources only when catalog options are requested.
 * Missing roots are diagnostics, not project-load failures.
 */
export function resolveConfiguredExecutionTemplateSources(
  config: ProjectExecutionTemplatesConfig | undefined,
  options: ResolveConfiguredExecutionTemplateSourcesOptions,
): ResolvedExecutionTemplateSources {
  const { roots, unavailable } = configuredSourceRoots(config, options);
  return {
    sources: roots.map((entry) =>
      configuredSource(
        entry,
        executionTemplateSourceRevision(entry.root),
        executionTemplateSourceDirty(entry.root),
      ),
    ),
    unavailable,
  };
}

/** `resolveConfiguredExecutionTemplateSources` with its `git` calls run by `git`. */
export async function resolveConfiguredExecutionTemplateSourcesAsync(
  config: ProjectExecutionTemplatesConfig | undefined,
  options: ResolveConfiguredExecutionTemplateSourcesOptions,
  git: ExecutionTemplateGitRunner,
): Promise<ResolvedExecutionTemplateSources> {
  const { roots, unavailable } = configuredSourceRoots(config, options);
  const sources: ExecutionTemplateSource[] = [];
  for (const entry of roots)
    sources.push(
      configuredSource(
        entry,
        await executionTemplateSourceRevisionAsync(entry.root, git),
        await executionTemplateSourceDirtyAsync(entry.root, git),
      ),
    );
  return { sources, unavailable };
}
