import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Command } from 'commander';

import {
  createExecutionTemplate,
  customTemplateSource,
  type ExecutionRunMode,
  type ExecutionTemplateSource,
  lintExecutionTemplates,
  listExecutionTemplates,
  packageFlowTreeTemplateSource,
  projectWorkerTemplateSource,
} from '@farmslot/agent-runtime';

import { dim, green, red, yellow } from '../colors.js';
import { OutputContext } from '../output.js';

interface ListOptions {
  dir?: string[];
  projectWorker?: string;
  projectName?: string;
  packageTemplates?: string;
  packageId?: string;
  flow?: string;
  runMode?: string;
  platform?: string;
  includeShadowed?: boolean;
  json?: boolean;
}

interface LintOptions {
  json?: boolean;
}

interface NewOptions {
  flow?: string;
  runMode?: string;
  platform?: string;
  title?: string;
  force?: boolean;
  json?: boolean;
}

function parseRunMode(value: string | undefined): ExecutionRunMode | undefined {
  if (!value) return undefined;
  if (value === 'autonomous' || value === 'interactive' || value === 'validation') return value;
  throw new Error(`--run-mode must be autonomous|interactive|validation (got ${value})`);
}

function buildSources(opts: ListOptions): ExecutionTemplateSource[] {
  const sources: ExecutionTemplateSource[] = [];
  for (const [index, dir] of (opts.dir ?? []).entries()) {
    const root = resolve(dir);
    if (!existsSync(root)) throw new Error(`--dir not found: ${root}`);
    sources.push(customTemplateSource(`dir-${index + 1}`, root, 'flow-tree'));
  }
  if (opts.projectWorker) {
    const input = resolve(opts.projectWorker);
    const projectTemplatesDir =
      input.endsWith('/worker') || input.endsWith('\\worker') ? resolve(input, '..') : input;
    // The source appends worker/ — validate the directory that will actually
    // be scanned, or a typo silently yields an empty catalog.
    if (!existsSync(resolve(projectTemplatesDir, 'worker'))) {
      throw new Error(`--project-worker not found: ${resolve(projectTemplatesDir, 'worker')}`);
    }
    sources.push(projectWorkerTemplateSource(opts.projectName ?? 'project', projectTemplatesDir));
  }
  if (opts.packageTemplates) {
    const root = resolve(opts.packageTemplates);
    if (!existsSync(root)) throw new Error(`--package-templates not found: ${root}`);
    sources.push(packageFlowTreeTemplateSource(opts.packageId ?? 'shared', root));
  }
  if (sources.length === 0) {
    throw new Error(
      'provide at least one source: --dir, --project-worker, and/or --package-templates',
    );
  }
  return sources;
}

function formatListHuman(entries: ReturnType<typeof listExecutionTemplates>): string {
  if (entries.length === 0) return `${dim('no templates found')}\n`;
  const lines: string[] = [];
  for (const entry of entries) {
    const mode = entry.runMode ?? '-';
    const platforms = entry.platforms.join(',');
    const shadow = entry.shadowedBy ? ` ${yellow(`(shadowed by ${entry.shadowedBy})`)}` : '';
    lines.push(
      `${entry.id}\t${entry.flow}\t${mode}\t${platforms}\t${entry.sourceId}\t${entry.path}${shadow}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function registerExecutionTemplateCommand(program: Command): void {
  const cmd = program
    .command('execution-template')
    .description('Shared Markdown execution-template catalog (ADR-049)');

  cmd
    .command('list')
    .description('List effective templates with inferred metadata and shadowing')
    .option(
      '--dir <path>',
      'Custom flow-tree template directory (repeatable)',
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .option(
      '--project-worker <path>',
      'Farm project templates dir (…/templates or …/templates/worker)',
    )
    .option('--project-name <name>', 'Label for --project-worker source', 'project')
    .option('--package-templates <path>', 'Shared package flow-tree templates root')
    .option('--package-id <id>', 'Label for --package-templates source', 'shared')
    .option('--flow <flow>', 'Filter by flow (e.g. dev, fix-bug)')
    .option('--run-mode <mode>', 'Filter by runMode (autonomous|interactive|validation)')
    .option('--platform <platform>', 'Filter by platform (mobile|extension|core)')
    .option('--include-shadowed', 'Include shadowed duplicates (default true)', true)
    .option('--no-include-shadowed', 'Hide shadowed duplicates')
    .action((opts: ListOptions, command: Command) => {
      const json = Boolean(command.optsWithGlobals().json ?? opts.json);
      const output = new OutputContext(json);
      try {
        const entries = listExecutionTemplates({
          sources: buildSources(opts),
          flow: opts.flow,
          runMode: parseRunMode(opts.runMode),
          platform: opts.platform,
          includeShadowed: opts.includeShadowed !== false,
        });
        if (json) {
          output.writeJson({ templates: entries });
          return;
        }
        output.write(formatListHuman(entries));
      } catch (err) {
        output.failure(err);
        process.exitCode = 1;
      }
    });

  cmd
    .command('lint')
    .description('Lint optional frontmatter and parseable checkbox lines')
    .argument('<target>', 'Template file or directory')
    .action((target: string, opts: LintOptions, command: Command) => {
      const json = Boolean(command.optsWithGlobals().json ?? opts.json);
      const output = new OutputContext(json);
      try {
        const result = lintExecutionTemplates(target);
        if (json) {
          output.writeJson(result);
        } else if (result.ok) {
          output.write(`${green('pass')} ${result.filesChecked} template(s)\n`);
        } else {
          for (const issue of result.issues) {
            const color = issue.severity === 'error' ? red : yellow;
            output.write(`${color(issue.severity)} ${issue.path}: ${issue.message}\n`);
          }
        }
        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        output.failure(err);
        process.exitCode = 1;
      }
    });

  cmd
    .command('new')
    .description('Create a starter Markdown execution template')
    .argument('<path>', 'Destination .md path')
    .option('--flow <flow>', 'Flow name when not inferable from filename')
    .option('--run-mode <mode>', 'autonomous|interactive|validation')
    .option('--platform <platform>', 'Single platform for frontmatter (repeat via comma)')
    .option('--title <title>', 'Template title')
    .option('--force', 'Overwrite an existing file')
    .action((pathArg: string, opts: NewOptions, command: Command) => {
      const json = Boolean(command.optsWithGlobals().json ?? opts.json);
      const output = new OutputContext(json);
      try {
        const platforms = opts.platform
          ? opts.platform
              .split(',')
              .map((p) => p.trim())
              .filter(Boolean)
          : undefined;
        const created = createExecutionTemplate({
          path: pathArg,
          flow: opts.flow,
          runMode: parseRunMode(opts.runMode),
          platforms,
          title: opts.title,
          force: Boolean(opts.force),
        });
        if (json) {
          output.writeJson(created);
          return;
        }
        output.write(`${green('created')} ${created.path}\n`);
      } catch (err) {
        output.failure(err);
        process.exitCode = 1;
      }
    });
}
