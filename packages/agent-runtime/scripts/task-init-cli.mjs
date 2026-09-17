#!/usr/bin/env node
/**
 * `farmslot-agent task init`: write a task directory from a selected execution
 * template. Thin wrappers (mm-harness) add their own defaults and forward here.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildSources, loadRuntime, parseCatalogArgs } from './execution-template-cli.mjs';

function usage(exitCode = 0) {
  const text = [
    'Usage: task init <task-dir> --flow f --platform p --template id --title t [options]',
    '',
    '  Template sources: --dir <path> --domain-dir <domain=path> --project-worker <path>',
    '                    --package-templates <path> [--package-id id] [--project-name name] [--domain d]',
    '  Run:              [--run-mode m] — run mode used to match project default rules',
    '  Task:             --title t [--task-text s | --task-file path] [--ticket key] [--source-ref url]',
    '  Identity:         [--surface s] [--project name] [--repo owner/name] [--attempt-id id]',
    '  Rendering:        [--var KEY=VALUE]... [--task-dir-label label] [--mode-preamble text]',
    '                    [--addendum-file path] [--mark-command "cmd"] [--json]',
    '',
    'Writes TASK.md, CHECKLIST.md, mark, inputs/handoff.json, inputs/worker-terminal-contract.json.',
  ].join('\n');
  (exitCode === 0 ? console.log : console.error)(text);
  process.exit(exitCode);
}

function takeValue(args, i, flag) {
  const value = args[i + 1];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(args) {
  const opts = {
    taskDir: null,
    template: null,
    title: null,
    taskText: null,
    taskFile: null,
    ticket: null,
    sourceRef: null,
    surface: 'cli',
    project: null,
    repo: null,
    attemptId: null,
    vars: {},
    taskDirLabel: null,
    modePreamble: null,
    addendumFile: null,
    markCommand: null,
    json: false,
  };
  const catalogArgs = [];
  // The task dir is the first positional, before any flag, as the usage line says.
  if (args[0] && !args[0].startsWith('-')) opts.taskDir = args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--template') opts.template = takeValue(args, i++, arg);
    else if (arg === '--title') opts.title = takeValue(args, i++, arg);
    else if (arg === '--task-text') opts.taskText = takeValue(args, i++, arg);
    else if (arg === '--task-file') opts.taskFile = takeValue(args, i++, arg);
    else if (arg === '--ticket') opts.ticket = takeValue(args, i++, arg);
    else if (arg === '--source-ref') opts.sourceRef = takeValue(args, i++, arg);
    else if (arg === '--surface') opts.surface = takeValue(args, i++, arg);
    else if (arg === '--project') opts.project = takeValue(args, i++, arg);
    else if (arg === '--repo') opts.repo = takeValue(args, i++, arg);
    else if (arg === '--attempt-id') opts.attemptId = takeValue(args, i++, arg);
    else if (arg === '--task-dir-label') opts.taskDirLabel = takeValue(args, i++, arg);
    else if (arg === '--mode-preamble') opts.modePreamble = takeValue(args, i++, arg);
    else if (arg === '--addendum-file') opts.addendumFile = takeValue(args, i++, arg);
    else if (arg === '--mark-command') opts.markCommand = takeValue(args, i++, arg);
    else if (arg === '--var') {
      const pair = takeValue(args, i++, arg);
      const eq = pair.indexOf('=');
      if (eq <= 0) throw new Error('--var must use KEY=VALUE');
      opts.vars[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (arg === '--json') {
      opts.json = true;
      catalogArgs.push(arg);
    } else if (arg === '-h' || arg === '--help') usage(0);
    else catalogArgs.push(arg);
  }
  if (!opts.taskDir) throw new Error('task init requires <task-dir>');
  if (!opts.template) throw new Error('task init requires --template <id>');
  if (!opts.title) throw new Error('task init requires --title');
  const catalog = parseCatalogArgs([...catalogArgs, '--id', opts.template]);
  if (!catalog.flow) throw new Error('task init requires --flow');
  if (!catalog.platform) throw new Error('task init requires --platform');
  return { opts, catalog };
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a git checkout, or no remote: identity falls back to the directory name.
    return '';
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') usage(0);
  const { opts, catalog } = parseArgs(args);
  const runtime = await loadRuntime();

  const description = opts.taskFile
    ? readFileSync(path.resolve(opts.taskFile), 'utf8').trim()
    : (opts.taskText ?? '').trim();
  const toplevel = gitOutput(['rev-parse', '--show-toplevel']);
  const originUrl = gitOutput(['remote', 'get-url', 'origin']);
  const repo = opts.repo ?? (originUrl ? runtime.portableRepoIdentity(originUrl) : undefined);
  const project =
    opts.project ??
    (repo ? repo.split('/').pop() : path.basename(toplevel || process.cwd())).toLowerCase();
  // Rendered inside taskInit with the same vars as the checklist, so an addendum
  // that works on the farm works here.
  const addendum = opts.addendumFile ? readFileSync(path.resolve(opts.addendumFile), 'utf8') : null;

  const result = await runtime.taskInit({
    taskDir: path.resolve(opts.taskDir),
    taskDirLabel: opts.taskDirLabel ?? opts.taskDir,
    flow: catalog.flow,
    ...(catalog.runMode ? { runMode: catalog.runMode } : {}),
    platform: catalog.platform,
    ...(catalog.domain ? { domain: catalog.domain } : {}),
    template: { sources: buildSources(catalog, runtime), explicitId: opts.template },
    task: {
      title: opts.title,
      description,
      sourceKind: opts.taskFile ? 'file' : 'text',
      ...(opts.ticket ? { ticket: opts.ticket } : {}),
      ...(opts.sourceRef ? { sourceRef: opts.sourceRef } : {}),
    },
    handoff: {
      surface: opts.surface,
      project,
      ...(repo ? { repo } : {}),
      ...(opts.attemptId ? { attemptId: opts.attemptId } : {}),
    },
    vars: opts.vars,
    ...(opts.modePreamble ? { modePreamble: opts.modePreamble } : {}),
    addendum,
    ...(opts.markCommand ? { markCommand: opts.markCommand } : {}),
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Task document: ${result.taskDocument}\nChecklist: ${result.checklist}\n`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
