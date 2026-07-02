import path from 'node:path';

import { type Command } from 'commander';

import { isRecord, readJsonFile } from '../core/json.js';
import {
  loadRecipeLibraries,
  personalRecipeLibraryRoot,
  type RecipeLibraryResolution,
  resolveRecipeLibrarySources,
} from '../core/library.js';
import { promoteRecipeFlow } from '../core/promote.js';
import type { RecipeLibrarySource } from '../core/types.js';

import { resolveRecipeCliPath } from './support.js';

interface FlowsListOptions {
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
        console.log(JSON.stringify(flowsListDocument(resolution), null, 2));
        return;
      }
      printFlowsList(resolution);
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

function flowsListDocument(resolution: RecipeLibraryResolution) {
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
  };
}

function printFlowsList(resolution: RecipeLibraryResolution): void {
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
}

function flowDescription(raw: Record<string, unknown>): string | undefined {
  return typeof raw.description === 'string' && raw.description ? raw.description : undefined;
}

function requiredParams(raw: Record<string, unknown>): string[] {
  if (!isRecord(raw.paramsSchema) || !Array.isArray(raw.paramsSchema.required)) return [];
  return raw.paramsSchema.required.filter((entry): entry is string => typeof entry === 'string');
}

function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}
