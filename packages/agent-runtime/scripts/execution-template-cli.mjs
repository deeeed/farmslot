#!/usr/bin/env node
/**
 * Standalone execution-template CLI for ADR-049.
 * Used by `farmslot-agent execution-template` and thin Consensys wrappers.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = resolve(packageRoot, 'dist', 'index.js');

function usage(exitCode = 0) {
  const text = [
    'Usage: execution-template <list|materialize|lint|new> [options]',
    '',
    'list   --dir <path> --domain-dir <domain=path> --project-worker <path> --package-templates <path>',
    '       [--project-name name] [--package-id id] [--flow f] [--run-mode m]',
    '       [--platform p] [--domain d] [--no-include-shadowed] [--json]',
    'materialize <output> --flow f --run-mode m --platform p [--domain d] [--id id]',
    '       [the same source options as list] [--provenance path] [--json]',
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

function parseDomainDir(value) {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('--domain-dir must use domain=path');
  }
  const domain = value.slice(0, separator);
  if (!/^[a-z][a-z0-9-]*$/.test(domain)) {
    throw new Error(`--domain-dir domain must be a lowercase slug (got ${domain})`);
  }
  return { domain, root: value.slice(separator + 1) };
}

function parseCatalogArgs(args, { materialize = false } = {}) {
  const opts = {
    dirs: [],
    domainDirs: [],
    projectWorker: null,
    projectName: 'project',
    packageTemplates: null,
    packageId: 'shared',
    flow: undefined,
    runMode: undefined,
    platform: undefined,
    domain: undefined,
    id: undefined,
    includeShadowed: true,
    output: null,
    provenance: null,
    json: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dir') opts.dirs.push(takeValue(args, i++, arg));
    else if (arg === '--domain-dir')
      opts.domainDirs.push(parseDomainDir(takeValue(args, i++, arg)));
    else if (arg === '--project-worker') opts.projectWorker = takeValue(args, i++, arg);
    else if (arg === '--project-name') opts.projectName = takeValue(args, i++, arg);
    else if (arg === '--package-templates') opts.packageTemplates = takeValue(args, i++, arg);
    else if (arg === '--package-id') opts.packageId = takeValue(args, i++, arg);
    else if (arg === '--flow') opts.flow = takeValue(args, i++, arg);
    else if (arg === '--run-mode') opts.runMode = parseRunMode(takeValue(args, i++, arg));
    else if (arg === '--platform') opts.platform = takeValue(args, i++, arg);
    else if (arg === '--domain') opts.domain = takeValue(args, i++, arg);
    else if (arg === '--id') opts.id = takeValue(args, i++, arg);
    else if (arg === '--provenance' && materialize) opts.provenance = takeValue(args, i++, arg);
    else if (arg === '--include-shadowed') opts.includeShadowed = true;
    else if (arg === '--no-include-shadowed') opts.includeShadowed = false;
    else if (arg === '--json') opts.json = true;
    else if (arg === '-h' || arg === '--help') usage(0);
    else if (materialize && !arg.startsWith('-') && !opts.output) opts.output = arg;
    else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

function buildSources(opts, runtime) {
  const sources = [];
  const domainSourceIds = new Set();
  for (const [index, dir] of opts.dirs.entries()) {
    const root = resolve(dir);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`--dir is not a directory: ${root}`);
    }
    const source = runtime.customTemplateSource(`dir-${index + 1}`, root, 'flow-tree');
    source.sourceRevision = runtime.executionTemplateSourceRevision(root);
    source.sourceDirty = runtime.executionTemplateSourceDirty(root);
    sources.push(source);
  }
  for (const item of opts.domainDirs) {
    const root = resolve(item.root);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`--domain-dir is not a directory: ${root}`);
    }
    const sourceId = `team:${item.domain}`;
    if (domainSourceIds.has(sourceId)) {
      throw new Error(`--domain-dir repeats domain ${item.domain}`);
    }
    domainSourceIds.add(sourceId);
    sources.push({
      id: sourceId,
      kind: 'workspace',
      root,
      layout: 'flow-tree',
      domains: [item.domain],
      sourceRevision: runtime.executionTemplateSourceRevision(root),
      sourceDirty: runtime.executionTemplateSourceDirty(root),
    });
  }
  if (opts.projectWorker) {
    const input = resolve(opts.projectWorker);
    const projectTemplatesDir =
      input.endsWith('/worker') || input.endsWith('\\worker') ? resolve(input, '..') : input;
    // An explicitly named source that does not exist is operator error — a
    // silent empty catalog hides typos (worker/ is appended by the source).
    const workerRoot = resolve(projectTemplatesDir, 'worker');
    if (!existsSync(workerRoot) || !statSync(workerRoot).isDirectory()) {
      throw new Error(`--project-worker is not a directory: ${workerRoot}`);
    }
    sources.push(
      runtime.projectWorkerTemplateSource(
        opts.projectName,
        projectTemplatesDir,
        runtime.executionTemplateSourceRevision(projectTemplatesDir),
        runtime.executionTemplateSourceDirty(projectTemplatesDir),
      ),
    );
  }
  if (opts.packageTemplates) {
    const root = resolve(opts.packageTemplates);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`--package-templates is not a directory: ${root}`);
    }
    const source = runtime.packageFlowTreeTemplateSource(opts.packageId, root);
    source.sourceRevision = runtime.executionTemplateSourceRevision(root);
    source.sourceDirty = runtime.executionTemplateSourceDirty(root);
    sources.push(source);
  }
  if (sources.length === 0) {
    throw new Error('provide --dir, --domain-dir, --project-worker, and/or --package-templates');
  }
  return sources;
}

async function cmdList(args, runtime) {
  const opts = parseCatalogArgs(args);
  if (opts.id) throw new Error('--id is only valid with materialize');
  const sources = buildSources(opts, runtime);
  const templates =
    opts.flow && opts.platform && opts.runMode
      ? runtime.listCompatibleExecutionTemplates({
          sources,
          flow: opts.flow,
          platform: opts.platform,
          runMode: opts.runMode,
          ...(opts.domain ? { domain: opts.domain } : {}),
        })
      : runtime.listExecutionTemplates({
          sources,
          flow: opts.flow,
          runMode: opts.runMode,
          platform: opts.platform,
          domain: opts.domain,
          includeShadowed: opts.includeShadowed,
        });
  const catalog = templates.map((entry) => ({
    ...runtime.executionTemplateReference(entry),
    title: entry.title,
    sourceKind: entry.sourceKind,
    ...(entry.shadowedBy ? { shadowedBy: entry.shadowedBy } : {}),
  }));
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ templates: catalog }, null, 2)}\n`);
    return;
  }
  for (const entry of catalog) {
    const shadow = entry.shadowedBy ? ` (shadowed by ${entry.shadowedBy})` : '';
    process.stdout.write(
      `${entry.id}\t${entry.flow}\t${entry.runMode ?? '-'}\t${entry.platforms.join(',')}\t${entry.sourceId}${shadow}\n`,
    );
  }
}

async function cmdMaterialize(args, runtime) {
  const opts = parseCatalogArgs(args, { materialize: true });
  if (!opts.output) throw new Error('materialize requires <output>');
  if (!opts.flow) throw new Error('materialize requires --flow');
  if (!opts.runMode) throw new Error('materialize requires --run-mode');
  if (!opts.platform) throw new Error('materialize requires --platform');
  const output = resolve(opts.output);
  if (existsSync(output)) {
    throw new Error(`Execution-template destination already exists: ${output}`);
  }
  if (opts.provenance && existsSync(resolve(opts.provenance))) {
    throw new Error(
      `Execution-template provenance destination already exists: ${resolve(opts.provenance)}`,
    );
  }
  const selected = runtime.selectExecutionTemplate({
    sources: buildSources(opts, runtime),
    flow: opts.flow,
    platform: opts.platform,
    runMode: opts.runMode,
    ...(opts.domain ? { domain: opts.domain } : {}),
    ...(opts.id ? { explicitId: opts.id } : {}),
  });
  const materialized = runtime.materializeExecutionTemplate(selected.entry, output);
  const provenance = {
    schemaVersion: 1,
    selectionReason: selected.reason,
    executionTemplate: materialized.reference,
  };
  if (opts.provenance) {
    const destination = resolve(opts.provenance);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(provenance, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  }
  const result = { ...materialized, provenance };
  if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(
      `materialized ${selected.entry.id} from ${selected.entry.sourceId} -> ${materialized.path}\n`,
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
  else if (command === 'materialize') await cmdMaterialize(rest, runtime);
  else if (command === 'lint') await cmdLint(rest, runtime);
  else if (command === 'new') await cmdNew(rest, runtime);
  else usage(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
