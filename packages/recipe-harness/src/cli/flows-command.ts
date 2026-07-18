import path from 'node:path';

import { type Command } from 'commander';

import { isRecord, readJsonFile } from '../core/json.js';
import {
  loadRecipeLibraries,
  personalRecipeLibraryRoot,
  type RecipeLibraryResolution,
  type ResolvedLibraryFlow,
  resolveRecipeLibrarySources,
} from '../core/library.js';
import { promoteRecipeFlow } from '../core/promote.js';
import type { RecipeLibrarySource } from '../core/types.js';

import { resolveRecipeCliPath } from './support.js';

interface FlowsListOptions {
  library: string[];
  json?: boolean;
}

interface FlowsDescribeOptions {
  library: string[];
  json?: boolean;
}

interface FlowsPromoteOptions {
  from: string;
  flow: string;
  to: string;
  library: string[];
  domain?: string;
  run?: string;
  force?: boolean;
}

export function registerFlowsCommand(program: Command): void {
  const cliName = program.name();
  const flows = program
    .command('flows')
    .description('Inspect flows available from configured recipe library sources');

  flows
    .command('list')
    .description('List every library flow with its source, in precedence order')
    .option(
      '--library <entry>',
      'Recipe library source as name=path or path (repeatable; order is precedence, first wins). Defaults to RECIPE_LIBRARY_PATH, then the personal library under the farmslot home.',
      collectRepeatable,
      [] as string[],
    )
    .option('--json', 'Print the flow list as JSON')
    .action(async (options: FlowsListOptions) => {
      const sources = await resolveRecipeLibrarySources({ cliEntries: options.library });
      if (sources.length === 0) {
        const message =
          'No recipe library sources configured. Pass --library name=path, set RECIPE_LIBRARY_PATH, or create a personal library under the farmslot home (recipe-library/library.json).';
        if (options.json) {
          console.log(JSON.stringify({ sources: [], flows: [] }, null, 2));
        }
        console.error(message);
        process.exitCode = 1;
        return;
      }
      const resolution = await loadRecipeLibraries(sources, options.json ? undefined : console);
      if (options.json) {
        console.log(JSON.stringify(flowsListDocument(resolution, cliName), null, 2));
        return;
      }
      printFlowsList(resolution, cliName);
    });

  flows
    .command('describe <ref>')
    .description(
      'Describe one resolved flow with its source, parameters, definition, and call node',
    )
    .option(
      '--library <entry>',
      'Recipe library source as name=path or path (repeatable; order is precedence, first wins). Defaults to RECIPE_LIBRARY_PATH, then the personal library under the farmslot home.',
      collectRepeatable,
      [] as string[],
    )
    .option('--json', 'Print the resolved flow contract as JSON')
    .action(async (ref: string, options: FlowsDescribeOptions) => {
      const sources = await resolveRecipeLibrarySources({ cliEntries: options.library });
      if (sources.length === 0) {
        describeFailure(
          options.json,
          'FLOW_LIBRARY_NOT_CONFIGURED',
          'No recipe library sources are configured.',
          'Pass --library name=path, set RECIPE_LIBRARY_PATH, or create a personal recipe library.',
        );
        return;
      }
      const resolution = await loadRecipeLibraries(sources, options.json ? undefined : console);
      const flow = resolution.flows.get(ref);
      if (!flow) {
        const availableFlows = [...resolution.flows.keys()].sort();
        describeFailure(
          options.json,
          'FLOW_NOT_FOUND',
          `Flow ${ref} is not available from the configured recipe libraries.`,
          `Run ${cliName} flows list${options.json ? ' --json' : ''} to inspect ${availableFlows.length} available flow(s).`,
          availableFlows,
        );
        return;
      }
      const document = flowDescribeDocument(resolution, flow, cliName);
      if (options.json) {
        console.log(JSON.stringify(document, null, 2));
        return;
      }
      printFlowDescription(document.flow, document.nextCommand);
    });

  flows
    .command('promote')
    .description(
      'Promote an inline flow from a per-change recipe into a recipe library (the durable keep behind throwaway proofs)',
    )
    .requiredOption('--from <recipe>', 'Per-change recipe declaring the flow inline')
    .requiredOption('--flow <ref>', 'Flow ref to promote')
    .option('--to <name>', 'Target library source name', 'personal')
    .option(
      '--library <entry>',
      'Recipe library source as name=path or path (repeatable; order is precedence, first wins). Defaults to RECIPE_LIBRARY_PATH, then the personal library under the farmslot home.',
      collectRepeatable,
      [] as string[],
    )
    .option('--domain <stem>', 'Catalog file stem (defaults to the ref minus its last segment)')
    .option(
      '--run <artifactsDir>',
      'Artifacts directory of a passing run that exercised the flow; stamps provenance.lastVerified',
    )
    .option('--force', 'Overwrite an existing declaration of the same ref')
    .action(async (options: FlowsPromoteOptions) => {
      const target = await resolvePromoteTarget(options.to, options.library);
      const result = await promoteRecipeFlow({
        recipePath: resolveRecipeCliPath(options.from),
        flowRef: options.flow,
        targetRoot: target.root,
        targetName: target.name ?? options.to,
        domain: options.domain,
        runArtifactsDir: options.run ? resolveRecipeCliPath(options.run) : undefined,
        force: options.force,
        logger: console,
      });
      if (result.createdLibrary) {
        console.log(`Created recipe library ${options.to} at ${target.root}`);
      }
      console.log(`Promoted ${result.ref} to ${result.catalogPath}`);
      console.log(
        result.lastVerified
          ? `lastVerified stamped from run evidence: ${result.lastVerified}`
          : 'No run evidence provided (--run); the flow carries no lastVerified stamp.',
      );
      if (options.to === 'personal') {
        console.log('Share it with your team by opening a PR to the team recipe library.');
      }
    });
}

function flowDescribeDocument(
  resolution: RecipeLibraryResolution,
  flow: ResolvedLibraryFlow,
  cliName: string,
) {
  const sourceIndex = resolution.sources.findIndex((source) => source.name === flow.source);
  const source = resolution.sources[sourceIndex];
  if (!source)
    throw new Error(`Resolved flow ${flow.ref} refers to unknown source ${flow.source}.`);
  const shadows = flow.shadows.map((name) => {
    const index = resolution.sources.findIndex((candidate) => candidate.name === name);
    const shadowedSource = resolution.sources[index];
    return {
      name,
      ...(shadowedSource ? { root: shadowedSource.root, precedence: index + 1 } : {}),
    };
  });
  const authoredCallNode = exampleCallNode(flow.raw);
  return {
    schemaVersion: 1,
    command: 'flows describe',
    status: 'pass',
    flow: {
      ref: flow.ref,
      ...(flowDescription(flow.raw) ? { description: flowDescription(flow.raw) } : {}),
      source: flow.source,
      sourceRoot: source.root,
      sourcePrecedence: sourceIndex + 1,
      file: flow.file,
      path: path.join(source.root, flow.file),
      parameters: {
        schema: isRecord(flow.raw.paramsSchema) ? flow.raw.paramsSchema : null,
        required: requiredParams(flow.raw),
        defaults: parameterDefaults(flow.raw),
      },
      ...(shadows.length > 0 ? { shadows } : {}),
      ...(flow.lastVerified ? { lastVerified: flow.lastVerified } : {}),
      definition: flow.raw,
      callNode: authoredCallNode ?? callNodeTemplate(flow.ref, flow.raw),
      callNodeSource: authoredCallNode ? 'authored-example' : 'generated-template',
    },
    nextCommand: flowDescribeCommand(resolution, cliName, flow.ref, true),
  };
}

type FlowDescriptionDocument = ReturnType<typeof flowDescribeDocument>;

function printFlowDescription(flow: FlowDescriptionDocument['flow'], nextCommand: string): void {
  console.log(flow.ref);
  if (flow.description) console.log(`  ${flow.description}`);
  console.log(`  source: ${flow.source} (precedence ${flow.sourcePrecedence})`);
  console.log(`  file: ${flow.path}`);
  if (flow.shadows?.length) {
    console.log(`  shadows: ${flow.shadows.map((source) => source.name).join(', ')}`);
  }
  if (flow.parameters.required.length > 0) {
    console.log(`  required params: ${flow.parameters.required.join(', ')}`);
  } else {
    console.log('  required params: none');
  }
  const defaults = Object.entries(flow.parameters.defaults);
  if (defaults.length > 0) {
    console.log(
      `  defaults: ${defaults.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(', ')}`,
    );
  }
  console.log(
    flow.callNodeSource === 'authored-example'
      ? '  recipe node (authored example):'
      : '  recipe node template (replace placeholder values):',
  );
  for (const line of JSON.stringify(flow.callNode, null, 2).split('\n')) {
    console.log(`    ${line}`);
  }
  console.log(`  Full definition: ${nextCommand}`);
}

function describeFailure(
  json: boolean | undefined,
  code: string,
  message: string,
  userAction: string,
  availableFlows?: string[],
): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'flows describe',
          status: 'error',
          error: { code, message, userAction },
          ...(availableFlows ? { availableFlows } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    console.error(message);
    console.error(`Next: ${userAction}`);
  }
  process.exitCode = 1;
}

async function resolvePromoteTarget(
  to: string,
  cliEntries: string[],
): Promise<RecipeLibrarySource> {
  const sources = await resolveRecipeLibrarySources({ cliEntries });
  const resolved = await Promise.all(
    sources.map(async (source) => ({
      ...source,
      name: source.name ?? (await libraryManifestName(source.root)),
    })),
  );
  const named = resolved.find((source) => source.name === to);
  if (named) return named;
  if (to === 'personal') return { name: 'personal', root: personalRecipeLibraryRoot() };
  const available = resolved.map((source) => source.name ?? source.root).join(', ') || 'none';
  throw new Error(
    `No recipe library source named ${to} is configured (available: ${available}). Pass --library ${to}=path or set RECIPE_LIBRARY_PATH.`,
  );
}

// Bare-path sources get their name from library.json, matching how run
// resolution names them.
async function libraryManifestName(root: string): Promise<string | undefined> {
  try {
    const manifest = await readJsonFile(path.join(root, 'library.json'));
    if (isRecord(manifest) && typeof manifest.name === 'string' && manifest.name) {
      return manifest.name;
    }
  } catch {
    // not a readable library; leave the source unnamed
  }
  return undefined;
}

function flowsListDocument(resolution: RecipeLibraryResolution, cliName: string) {
  const firstRef = [...resolution.flows.keys()].sort()[0];
  return {
    sources: resolution.sources,
    flows: [...resolution.flows.values()]
      .sort((a, b) => a.ref.localeCompare(b.ref))
      .map((flow) => ({
        ref: flow.ref,
        source: flow.source,
        file: flow.file,
        ...(flowDescription(flow.raw) ? { description: flowDescription(flow.raw) } : {}),
        ...(requiredParams(flow.raw).length > 0
          ? { requiredParams: requiredParams(flow.raw) }
          : {}),
        ...(flow.shadows.length > 0 ? { shadows: flow.shadows } : {}),
        ...(flow.lastVerified ? { lastVerified: flow.lastVerified } : {}),
      })),
    ...(firstRef ? { nextCommand: flowDescribeCommand(resolution, cliName, firstRef, true) } : {}),
  };
}

function printFlowsList(resolution: RecipeLibraryResolution, cliName: string): void {
  if (resolution.flows.size === 0) {
    console.log('No flows found in the configured recipe libraries.');
    return;
  }
  for (const flow of [...resolution.flows.values()].sort((a, b) => a.ref.localeCompare(b.ref))) {
    const details = [
      `source=${flow.source}`,
      `file=${flow.file}`,
      ...(flow.lastVerified ? [`lastVerified=${flow.lastVerified}`] : []),
      ...(flow.shadows.length > 0 ? [`shadows=${flow.shadows.join(',')}`] : []),
    ];
    console.log(`${flow.ref}  ${details.join('  ')}`);
    const description = flowDescription(flow.raw);
    if (description) console.log(`  ${description}`);
    const params = requiredParams(flow.raw);
    if (params.length > 0) console.log(`  params: ${params.join(', ')}`);
  }
  const firstRef = [...resolution.flows.keys()].sort()[0];
  if (firstRef) console.log(`Inspect one: ${flowDescribeCommand(resolution, cliName, firstRef)}`);
}

function flowDescription(raw: Record<string, unknown>): string | undefined {
  return typeof raw.description === 'string' && raw.description ? raw.description : undefined;
}

function requiredParams(raw: Record<string, unknown>): string[] {
  if (!isRecord(raw.paramsSchema) || !Array.isArray(raw.paramsSchema.required)) return [];
  return raw.paramsSchema.required.filter((entry): entry is string => typeof entry === 'string');
}

function parameterDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(raw.paramsSchema) || !isRecord(raw.paramsSchema.properties)) return {};
  return Object.fromEntries(
    Object.entries(raw.paramsSchema.properties).flatMap(([name, schema]) =>
      isRecord(schema) && Object.hasOwn(schema, 'default') ? [[name, schema.default]] : [],
    ),
  );
}

function exampleCallNode(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(raw.examples)) return undefined;
  for (const example of raw.examples) {
    if (isRecord(example) && isRecord(example.node) && example.node.action === 'call') {
      return example.node;
    }
  }
  return undefined;
}

function callNodeTemplate(ref: string, raw: Record<string, unknown>): Record<string, unknown> {
  const defaults = parameterDefaults(raw);
  const params = Object.fromEntries(
    requiredParams(raw).map((name) => [
      name,
      Object.hasOwn(defaults, name) ? defaults[name] : `<${name}>`,
    ]),
  );
  return {
    action: 'call',
    ref,
    ...(Object.keys(params).length > 0 ? { params } : {}),
    intent: flowDescription(raw) ?? `Run ${ref}`,
    next: 'done',
  };
}

function flowDescribeCommand(
  resolution: RecipeLibraryResolution,
  cliName: string,
  ref: string,
  json = false,
): string {
  const args = [
    cliName,
    'flows',
    'describe',
    ref,
    ...resolution.sources.flatMap((source) => ['--library', `${source.name}=${source.root}`]),
    ...(json ? ['--json'] : []),
  ];
  return args.map(shellQuoteArg).join(' ');
}

function shellQuoteArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}
