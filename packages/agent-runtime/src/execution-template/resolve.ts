import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { inferTemplateMetadata } from './infer.js';
import type {
  ExecutionTemplateEntry,
  ExecutionTemplateSource,
  ListExecutionTemplatesOptions,
} from './types.js';

const SOURCE_KIND_RANK: Record<ExecutionTemplateSource['kind'], number> = {
  custom: 0,
  project: 1,
  workspace: 2,
  user: 3,
  package: 4,
  fallback: 5,
};

function listMarkdownFiles(root: string, layout: ExecutionTemplateSource['layout']): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: string[] = [];

  if (layout === 'worker-flat') {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(path.join(root, entry.name));
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  // flow-tree: <root>/<flow>/*.md (one level under each flow dir)
  for (const flowEntry of readdirSync(root, { withFileTypes: true })) {
    if (!flowEntry.isDirectory()) continue;
    const flowDir = path.join(root, flowEntry.name);
    for (const fileEntry of readdirSync(flowDir, { withFileTypes: true })) {
      if (fileEntry.isFile() && fileEntry.name.endsWith('.md')) {
        out.push(path.join(flowDir, fileEntry.name));
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function matchesFilters(
  entry: ExecutionTemplateEntry,
  options: ListExecutionTemplatesOptions,
): boolean {
  if (options.flow && entry.flow !== options.flow) return false;
  if (options.runMode && entry.runMode !== options.runMode) return false;
  if (options.platform) {
    const platforms = entry.platforms;
    if (!platforms.includes('*') && !platforms.includes(options.platform)) return false;
  }
  return true;
}

/**
 * List execution templates across sources.
 * Higher-precedence kinds win when ids collide; losers are marked `shadowedBy`.
 */
export function listExecutionTemplates(
  options: ListExecutionTemplatesOptions,
): ExecutionTemplateEntry[] {
  const includeShadowed = options.includeShadowed !== false;
  // Same-kind ties break by CALLER order (the order sources were provided),
  // not alphabetical ids — the caller's ordering is the intent.
  const sources = options.sources
    .map((source, callerIndex) => ({ source, callerIndex }))
    .sort((a, b) => {
      const rank = SOURCE_KIND_RANK[a.source.kind] - SOURCE_KIND_RANK[b.source.kind];
      if (rank !== 0) return rank;
      return a.callerIndex - b.callerIndex;
    })
    .map(({ source }) => source);

  const winners = new Map<string, ExecutionTemplateEntry>();
  const shadowed: ExecutionTemplateEntry[] = [];

  // Shadowing resolves BEFORE filters: a filtered-out winner must not let a
  // lower-precedence duplicate become effective through the filter.
  for (const source of sources) {
    for (const absolutePath of listMarkdownFiles(source.root, source.layout)) {
      const relativePath = path.relative(source.root, absolutePath);
      const text = readFileSync(absolutePath, 'utf8');
      const entry = inferTemplateMetadata({
        absolutePath,
        relativePath,
        source,
        text,
      });

      const existing = winners.get(entry.id);
      if (!existing) {
        winners.set(entry.id, entry);
        continue;
      }
      shadowed.push({ ...entry, shadowedBy: existing.sourceId });
    }
  }

  const result = [...winners.values()].filter((entry) => matchesFilters(entry, options));
  if (includeShadowed) {
    result.push(...shadowed.filter((entry) => matchesFilters(entry, options)));
  }
  return result.sort((a, b) => {
    if (a.flow !== b.flow) return a.flow.localeCompare(b.flow);
    if (Boolean(a.shadowedBy) !== Boolean(b.shadowedBy)) return a.shadowedBy ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

/** Convenience: build a project worker-flat source. */
export function projectWorkerTemplateSource(
  projectName: string,
  projectTemplatesDir: string,
): ExecutionTemplateSource {
  return {
    id: `project:${projectName}`,
    kind: 'project',
    root: path.join(projectTemplatesDir, 'worker'),
    layout: 'worker-flat',
  };
}

/** Convenience: build a package flow-tree source (e.g. recipe-cook references/templates). */
export function packageFlowTreeTemplateSource(
  packageId: string,
  templatesRoot: string,
): ExecutionTemplateSource {
  return {
    id: `package:${packageId}`,
    kind: 'package',
    root: templatesRoot,
    layout: 'flow-tree',
  };
}

export function customTemplateSource(
  customId: string,
  root: string,
  layout: ExecutionTemplateSource['layout'] = 'flow-tree',
): ExecutionTemplateSource {
  return {
    id: `custom:${customId}`,
    kind: 'custom',
    root,
    layout,
  };
}
