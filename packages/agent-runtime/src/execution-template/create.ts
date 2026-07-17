import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { inferFlowFromBasename, inferRunModeFromBasename } from './infer.js';
import { lintExecutionTemplates } from './lint.js';
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
}): string {
  const lines: string[] = ['---'];
  if (input.runMode) lines.push(`runMode: ${input.runMode}`);
  if (input.platforms.length > 0 && !(input.platforms.length === 1 && input.platforms[0] === '*')) {
    lines.push(`platforms: [${input.platforms.join(', ')}]`);
  }
  lines.push('---', '', `# ${input.title}`, '', 'Checklist:', '');
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

  const flow = options.flow ?? inferFlowFromBasename(basename);
  if (!flow) {
    throw new Error(
      'could not infer flow from filename; pass flow explicitly or use a flow-prefixed name (e.g. dev-autonomous.mobile.md)',
    );
  }

  const runMode = options.runMode ?? inferRunModeFromBasename(basename);
  const platforms = options.platforms ?? ['*'];
  const title = options.title ?? defaultTitle(flow, runMode);
  const body = renderTemplate({ flow, runMode, platforms, title });

  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, body, 'utf8');

  const lint = lintExecutionTemplates(absolute);
  if (!lint.ok) {
    const detail = lint.issues.map((issue) => issue.message).join('; ');
    throw new Error(`created template failed lint: ${detail}`);
  }

  return { path: absolute, created: true };
}
