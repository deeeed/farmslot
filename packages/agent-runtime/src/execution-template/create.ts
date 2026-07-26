import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { inferFlowFromPath, inferRunModeFromBasename } from './infer.js';
import { lintExecutionTemplateText } from './lint.js';
import type { CreateExecutionTemplateOptions, ExecutionRunMode } from './types.js';

function defaultTitle(flow: string, runMode: ExecutionRunMode | null): string {
  const modeLabel = runMode ? ` (${runMode})` : '';
  return `${flow} execution template${modeLabel}`;
}

function renderTemplate(input: {
  flow: string;
  runMode: ExecutionRunMode | null;
  platforms: string[];
  title: string;
  description?: string;
}): string {
  const meta: string[] = [];
  if (input.description) meta.push(`description: ${JSON.stringify(input.description)}`);
  if (input.runMode) meta.push(`runMode: ${input.runMode}`);
  if (input.platforms.length > 0 && !(input.platforms.length === 1 && input.platforms[0] === '*')) {
    meta.push(`platforms: [${input.platforms.join(', ')}]`);
  }
  // No metadata → no frontmatter block: an empty fence pair is pointless and
  // easy for permissive parsers to misread as an unterminated block.
  const lines: string[] = meta.length > 0 ? ['---', ...meta, '---', ''] : [];
  lines.push(`# ${input.title}`, '', 'Checklist:', '');
  lines.push(
    '- [ ] Read the task prompt and confirm acceptance criteria.',
    '- [ ] Implement the smallest correct change.',
    '- [ ] Run focused validation and attach evidence under `artifacts/`.',
    '- [ ] Mark the task complete, blocked, or no-change.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

/** Create a starter Markdown execution template with minimal optional frontmatter. */
export function createExecutionTemplate(options: CreateExecutionTemplateOptions): {
  path: string;
  created: boolean;
} {
  const absolute = path.resolve(options.path);
  if (existsSync(absolute) && !options.force) {
    throw new Error(`refusing to overwrite existing file: ${absolute} (pass force: true)`);
  }

  const basename = path.basename(absolute);
  if (!basename.endsWith('.md')) {
    throw new Error('template path must end with .md');
  }

  // Resolve and cross-check flow BEFORE anything touches the filesystem: the
  // catalog derives flow from the filename, so a --flow that the filename does
  // not encode (or contradicts) would create a template that resolves as a
  // different flow than requested.
  const fileFlow = inferFlowFromPath(absolute);
  const flow = options.flow ?? fileFlow;
  if (!flow) {
    throw new Error(
      'could not infer flow from the path; use a flow-prefixed filename (dev-autonomous.mobile.md) or a flow directory (fix-bug/core.md)',
    );
  }
  if (options.flow && fileFlow && options.flow !== fileFlow) {
    throw new Error(
      `requested flow '${options.flow}' contradicts the path's flow '${fileFlow}'; rename the file or drop --flow`,
    );
  }
  if (options.flow && !fileFlow) {
    throw new Error(
      `the path must encode the flow ('${options.flow}') for the catalog to resolve it — flow-prefixed filename or a ${options.flow}/ directory`,
    );
  }

  const runMode = options.runMode ?? inferRunModeFromBasename(basename);
  const platforms = options.platforms ?? ['*'];
  const title = options.title ?? defaultTitle(flow, runMode);
  const body = renderTemplate({
    flow,
    runMode,
    platforms,
    title,
    description: options.description?.trim() || undefined,
  });

  // Lint the rendered TEXT before writing — a failed creation must leave no
  // file behind (and must never destroy an existing file via force).
  const issues = lintExecutionTemplateText(absolute, body).filter(
    (issue) => issue.severity === 'error',
  );
  if (issues.length > 0) {
    const detail = issues.map((issue) => issue.message).join('; ');
    throw new Error(`template would fail lint: ${detail}`);
  }

  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, body, 'utf8');

  return { path: absolute, created: true };
}
