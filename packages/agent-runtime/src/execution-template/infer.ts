import path from 'node:path';

import {
  frontmatterPlatforms,
  frontmatterRunMode,
  type ParsedMarkdownDocument,
  parseMarkdownDocument,
} from './frontmatter.js';
import type {
  ExecutionRunMode,
  ExecutionTemplateEntry,
  ExecutionTemplateFrontmatter,
  ExecutionTemplateLayout,
  ExecutionTemplateSource,
} from './types.js';

/** Longest-first so `fix-bug` / `pr-complete` / `self-review` win over shorter prefixes. */
export const FARMSLOT_FLOW_PREFIXES = [
  'self-review-fix',
  'pr-complete',
  'fix-bug',
  'review-pr',
  'update-branch',
  'self-review',
  'validate-dep',
  'ci-fix',
  'dev',
] as const;

const PLATFORM_SUFFIXES = ['mobile', 'extension', 'core'] as const;

export function humanizeBasename(basename: string): string {
  return basename
    .replace(/\.md$/i, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .trim();
}

export function inferFlowFromBasename(basename: string): string | null {
  const stem = basename.replace(/\.md$/i, '').toLowerCase();
  for (const flow of FARMSLOT_FLOW_PREFIXES) {
    if (stem === flow || stem.startsWith(`${flow}-`) || stem.startsWith(`${flow}.`)) {
      return flow;
    }
  }
  return null;
}

export function inferRunModeFromBasename(basename: string): ExecutionRunMode | null {
  const stem = basename.replace(/\.md$/i, '').toLowerCase();
  if (/(?:^|[.-])interactive(?:[.-]|$)/.test(stem) || stem.includes('-interactive')) {
    return 'interactive';
  }
  if (/(?:^|[.-])autonomous(?:[.-]|$)/.test(stem) || stem.includes('-autonomous')) {
    return 'autonomous';
  }
  if (/(?:^|[.-])validation(?:[.-]|$)/.test(stem)) {
    return 'validation';
  }
  // A bare flow name encodes no mode: dispatch mode is a run property, and
  // flows like review-pr run interactive as often as autonomous — defaulting
  // here would misclassify them, so leave the mode unresolved.
  return null;
}

export function inferPlatformsFromBasename(basename: string): string[] | null {
  const stem = basename.replace(/\.md$/i, '').toLowerCase();
  for (const platform of PLATFORM_SUFFIXES) {
    if (stem.endsWith(`.${platform}`)) return [platform];
  }
  return null;
}

/**
 * Canonical catalog id. Both layouts normalize to `<flow>/<variant>` so a
 * project worker-flat `fix-bug.core.md` and a package flow-tree
 * `fix-bug/core.md` collide — precedence/shadowing cannot work otherwise.
 */
export function catalogRelativeId(relativePath: string, layout: ExecutionTemplateLayout): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const withoutExt = normalized.replace(/\.md$/i, '');
  if (layout !== 'worker-flat') return withoutExt;
  const stem = path.basename(withoutExt);
  const flow = inferFlowFromBasename(`${stem}.md`);
  if (!flow) return stem;
  const variant = stem.slice(flow.length).replace(/^[._-]+/, '');
  return `${flow}/${variant || 'default'}`;
}

export function inferTemplateMetadata(input: {
  absolutePath: string;
  relativePath: string;
  source: ExecutionTemplateSource;
  text: string;
}): Omit<ExecutionTemplateEntry, 'shadowedBy'> {
  const basename = path.basename(input.absolutePath);
  const parsed: ParsedMarkdownDocument = parseMarkdownDocument(input.text);
  const fm: ExecutionTemplateFrontmatter | null = parsed.frontmatter;

  const flowFromFm = typeof fm?.flow === 'string' ? fm.flow.trim() : '';
  const flowFromDir =
    input.source.layout === 'flow-tree'
      ? input.relativePath.replace(/\\/g, '/').split('/')[0] || ''
      : '';
  const flow = flowFromFm || flowFromDir || inferFlowFromBasename(basename) || 'unknown';

  const idFromFm = typeof fm?.id === 'string' ? fm.id.trim() : '';
  const id = idFromFm || catalogRelativeId(input.relativePath, input.source.layout);

  const titleFromFm = typeof fm?.title === 'string' ? fm.title.trim() : '';
  const title = titleFromFm || parsed.heading || humanizeBasename(basename);

  const versionRaw = fm?.version;
  const version = versionRaw == null || versionRaw === '' ? '1' : String(versionRaw);

  const runMode = frontmatterRunMode(fm) ?? inferRunModeFromBasename(basename);

  const platforms = frontmatterPlatforms(fm) ?? inferPlatformsFromBasename(basename) ?? ['*'];

  const labels = Array.isArray(fm?.labels)
    ? fm.labels.filter((item): item is string => typeof item === 'string')
    : [];

  return {
    id,
    title,
    flow,
    version,
    runMode,
    platforms,
    labels,
    path: input.absolutePath,
    relativePath: input.relativePath.replace(/\\/g, '/'),
    sourceId: input.source.id,
    sourceKind: input.source.kind,
    frontmatter: fm,
    heading: parsed.heading,
  };
}
