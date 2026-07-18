#!/usr/bin/env node
/**
 * Standalone execution-template CLI for ADR-049.
 * Used by `farmslot-agent execution-template` and thin Consensys wrappers.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = resolve(packageRoot, 'dist', 'index.js');

function usage(exitCode = 0) {
  const text = [
    'Usage: execution-template <list|lint|new> [options]',
    '',
    'list   --dir <path> --project-worker <path> --package-templates <path>',
    '       [--project-name name] [--package-id id] [--flow f] [--run-mode m]',
    '       [--platform p] [--no-include-shadowed] [--json]',
    'lint   <file-or-dir> [--json]',
    'new    <path> [--flow f] [--run-mode m] [--platform p] [--title t] [--force] [--json]',
  ].join('\n');
  (exitCode === 0 ? console.log : console.error)(text);
  process.exit(exitCode);
}

function takeValue(args, i, flag) {
  const value = args[i + 1];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

async function loadRuntime() {
  if (!existsSync(distEntry)) {
    throw new Error(
      `compiled package missing at ${distEntry}; run yarn workspace @farmslot/agent-runtime build`,
    );
  }
  return import(pathToFileURL(distEntry).href);
}

function parseRunMode(value) {
  if (value === 'autonomous' || value === 'interactive' || value === 'validation') return value;
  throw new Error(`--run-mode must be autonomous|interactive|validation (got ${value})`);
}

async function cmdList(args, runtime) {
  const opts = {
    dirs: [],
    projectWorker: null,
    projectName: 'project',
    packageTemplates: null,
    packageId: 'shared',
    flow: undefined,
    runMode: undefined,
    platform: undefined,
    includeShadowed: true,
    json: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dir') opts.dirs.push(takeValue(args, i++, arg));
    else if (arg === '--project-worker') opts.projectWorker = takeValue(args, i++, arg);
    else if (arg === '--project-name') opts.projectName = takeValue(args, i++, arg);
    else if (arg === '--package-templates') opts.packageTemplates = takeValue(args, i++, arg);
    else if (arg === '--package-id') opts.packageId = takeValue(args, i++, arg);
    else if (arg === '--flow') opts.flow = takeValue(args, i++, arg);
    else if (arg === '--run-mode') opts.runMode = parseRunMode(takeValue(args, i++, arg));
    else if (arg === '--platform') opts.platform = takeValue(args, i++, arg);
    else if (arg === '--include-shadowed') opts.includeShadowed = true;
    else if (arg === '--no-include-shadowed') opts.includeShadowed = false;
    else if (arg === '--json') opts.json = true;
    else if (arg === '-h' || arg === '--help') usage(0);
    else throw new Error(`unknown option ${arg}`);
  }

  const sources = [];
  for (const [index, dir] of opts.dirs.entries()) {
    const root = resolve(dir);
    if (!existsSync(root)) throw new Error(`--dir not found: ${root}`);
    sources.push(runtime.customTemplateSource(`dir-${index + 1}`, root, 'flow-tree'));
  }
  if (opts.projectWorker) {
    const input = resolve(opts.projectWorker);
    const projectTemplatesDir =
      input.endsWith('/worker') || input.endsWith('\\worker') ? resolve(input, '..') : input;
    // An explicitly named source that does not exist is operator error — a
    // silent empty catalog hides typos (worker/ is appended by the source).
    if (!existsSync(resolve(projectTemplatesDir, 'worker'))) {
      throw new Error(`--project-worker not found: ${resolve(projectTemplatesDir, 'worker')}`);
    }
    sources.push(runtime.projectWorkerTemplateSource(opts.projectName, projectTemplatesDir));
  }
  if (opts.packageTemplates) {
    const root = resolve(opts.packageTemplates);
    if (!existsSync(root)) throw new Error(`--package-templates not found: ${root}`);
    sources.push(runtime.packageFlowTreeTemplateSource(opts.packageId, root));
  }
  if (sources.length === 0) {
    throw new Error('provide --dir, --project-worker, and/or --package-templates');
  }

  const templates = runtime.listExecutionTemplates({
    sources,
    flow: opts.flow,
    runMode: opts.runMode,
    platform: opts.platform,
    includeShadowed: opts.includeShadowed,
  });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ templates }, null, 2)}\n`);
    return;
  }
  for (const entry of templates) {
    const shadow = entry.shadowedBy ? ` (shadowed by ${entry.shadowedBy})` : '';
    process.stdout.write(
      `${entry.id}\t${entry.flow}\t${entry.runMode ?? '-'}\t${entry.platforms.join(',')}\t${entry.sourceId}\t${entry.path}${shadow}\n`,
    );
  }
}

async function cmdLint(args, runtime) {
  let target = null;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') usage(0);
    else if (!arg.startsWith('-') && !target) target = arg;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!target) usage(2);
  const result = runtime.lintExecutionTemplates(target);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`pass ${result.filesChecked} template(s)\n`);
  } else {
    for (const issue of result.issues) {
      process.stderr.write(`${issue.severity} ${issue.path}: ${issue.message}\n`);
    }
  }
  if (!result.ok) process.exitCode = 1;
}

async function cmdNew(args, runtime) {
  let pathArg = null;
  const opts = {
    flow: undefined,
    runMode: undefined,
    platforms: undefined,
    title: undefined,
    force: false,
    json: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--flow') opts.flow = takeValue(args, i++, arg);
    else if (arg === '--run-mode') opts.runMode = parseRunMode(takeValue(args, i++, arg));
    else if (arg === '--platform') {
      opts.platforms = takeValue(args, i++, arg)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
    } else if (arg === '--title') opts.title = takeValue(args, i++, arg);
    else if (arg === '--force') opts.force = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '-h' || arg === '--help') usage(0);
    else if (!arg.startsWith('-') && !pathArg) pathArg = arg;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!pathArg) usage(2);
  const created = runtime.createExecutionTemplate({
    path: pathArg,
    flow: opts.flow,
    runMode: opts.runMode,
    platforms: opts.platforms,
    title: opts.title,
    force: opts.force,
  });
  if (opts.json) process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
  else process.stdout.write(`created ${created.path}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '-h' || command === '--help') usage(0);
  const runtime = await loadRuntime();
  if (command === 'list') await cmdList(rest, runtime);
  else if (command === 'lint') await cmdLint(rest, runtime);
  else if (command === 'new') await cmdNew(rest, runtime);
  else usage(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
