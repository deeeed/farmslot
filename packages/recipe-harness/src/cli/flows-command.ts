import { type Command } from 'commander';

import { isRecord } from '../core/json.js';
import {
  loadRecipeLibraries,
  type RecipeLibraryResolution,
  resolveRecipeLibrarySources,
} from '../core/library.js';

interface FlowsListOptions {
  library: string[];
  json?: boolean;
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
