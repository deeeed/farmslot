import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type {
  ConfiguredExecutionTemplateSource,
  ProjectExecutionTemplatesConfig,
  UnavailableExecutionTemplateSource,
} from '@farmslot/protocol';

import type { ExecutionTemplateSource } from './types.js';

export type { UnavailableExecutionTemplateSource } from '@farmslot/protocol';

export interface ResolvedExecutionTemplateSources {
  sources: ExecutionTemplateSource[];
  unavailable: UnavailableExecutionTemplateSource[];
}

export interface ResolveConfiguredExecutionTemplateSourcesOptions {
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

export function executionTemplateSourceRevision(root: string): string | undefined {
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return undefined;
  const revision = result.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(revision) ? revision : undefined;
}

export function executionTemplateSourceDirty(root: string): boolean | undefined {
  const result = spawnSync('git', ['-C', root, 'status', '--porcelain', '--', '.'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim().length > 0;
}

function configuredRoot(
  source: ConfiguredExecutionTemplateSource,
  options: ResolveConfiguredExecutionTemplateSourcesOptions,
): { path?: string; reason?: UnavailableExecutionTemplateSource['reason'] } {
  if (typeof source.root.env === 'string') {
    const value = (options.env ?? process.env)[source.root.env]?.trim();
    if (!value) return { reason: 'missing-environment' };
    if (!path.isAbsolute(value)) return { reason: 'invalid-root' };
    return { path: value };
  }
  return { path: path.resolve(options.projectPackRoot, source.root.projectPath) };
}

/**
 * Resolve optional configured sources only when catalog options are requested.
 * Missing roots are diagnostics, not project-load failures.
 */
export function resolveConfiguredExecutionTemplateSources(
  config: ProjectExecutionTemplatesConfig | undefined,
  options: ResolveConfiguredExecutionTemplateSourcesOptions,
): ResolvedExecutionTemplateSources {
  const resolved: ExecutionTemplateSource[] = [];
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
    const sourceRevision = executionTemplateSourceRevision(canonicalScanPath);
    const sourceDirty = executionTemplateSourceDirty(canonicalScanPath);

    resolved.push({
      id: source.id,
      kind: source.kind,
      root: canonicalScanPath,
      layout: 'flow-tree',
      ...(source.domains ? { domains: source.domains } : {}),
      ...(sourceRevision ? { sourceRevision } : {}),
      ...(sourceDirty === undefined ? {} : { sourceDirty }),
    });
  }

  return { sources: resolved, unavailable };
}
