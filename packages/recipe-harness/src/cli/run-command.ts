import { type Command } from 'commander';

import {
  getRecipeActionManifestActionNames,
  isRecord,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../adapters/core.js';
import {
  applyTaskLocalInvocationTrust,
  loadRecipeLibraries,
  type ResolvedLibraryRecipe,
  resolveRecipeLibrarySources,
} from '../core/library.js';
import { RecipeResolutionError } from '../core/resolution-error.js';
import { createRecipeRunner } from '../core/runner.js';
import { RecipeTrustError } from '../core/trust-error.js';
import { resolveRecipeTrustInput } from '../core/trust-input.js';
import type { RecipeVideoRecordingOptions } from '../core/types.js';

import {
  parsePositiveInteger,
  parseRecipeParamAssignments,
  parseRecordingTarget,
  readRecipeCliJsonFile,
  resolveRecipeCliPath,
} from './support.js';

interface RunCommandOptions {
  artifactsDir?: string;
  actionManifest?: string;
  projectRoot?: string;
  library: string[];
  json?: boolean;
  recordVideo?: boolean | string;
  recordMaxFps?: string;
  recordMaxSize?: string;
  recordAppName?: string;
  recordWindowName?: string;
  recordWindowId?: string;
  recordPid?: string;
  sourceTrust?: string;
  sourceKind?: string;
  sourceName?: string;
  sourceDigest?: string;
  approvePlan?: string;
  adapter?: string;
  list?: boolean;
  describe?: boolean;
}

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a recipe and write a v1 artifact package')
    .argument('[recipe]', 'Recipe id from the active libraries, or a recipe.json path')
    .argument('[params...]', 'Recipe parameters as key=value')
    .option('--artifacts-dir <dir>', 'Directory where artifacts are written')
    .option('--action-manifest <manifest>', 'Runner action manifest JSON')
    .option('--project-root <dir>', 'Project root used by command/artifact adapters')
    .option(
      '--library <entry>',
      'Recipe library source as name=path or path (repeatable; order is precedence, first wins). Defaults to RECIPE_LIBRARY_PATH, then the personal library under the farmslot home.',
      collectRepeatable,
      [] as string[],
    )
    .option('--record-video [mode]', 'Record one whole-recipe MP4 when visual motion proof helps')
    .option('--record-max-fps <fps>', 'Maximum video frame rate')
    .option('--record-max-size <px>', 'Maximum recorded video dimension')
    .option('--record-app-name <name>', 'macOS app name for recording target')
    .option('--record-window-name <substring>', 'macOS window title substring for recording target')
    .option('--record-window-id <id>', 'macOS window id from `capture-helper list --json`')
    .option('--record-pid <pid>', 'macOS process id for recording target')
    .option('--source-trust <trust>', 'Recipe source trust: trusted, untrusted, or unknown')
    .option('--source-kind <kind>', 'Recipe source kind supplied by the caller')
    .option('--source-name <name>', 'Human-readable recipe source name')
    .option('--source-digest <digest>', 'Caller-computed source digest')
    .option('--approve-plan <digest>', 'Approve exactly one resolved execution-plan digest')
    .option('--adapter <name>', 'Select adapter-specific recipe variants')
    .option('--list', 'List runnable recipes from the active libraries')
    .option('--describe', 'Describe the selected recipe and its parameters without running it')
    .option('--json', 'Print run result as JSON')
    .action(
      async (recipeInput: string | undefined, params: string[], options: RunCommandOptions) => {
        try {
          let librarySources = await resolveRecipeLibrarySources({
            cliEntries: options.library,
          });
          let library = await loadRecipeLibraries(librarySources, {
            adapter: options.adapter,
          });
          if (recipeInput && !library.recipes.has(recipeInput)) {
            librarySources = await resolveRecipeLibrarySources({
              cliEntries: options.library,
              recipePath: resolveRecipeCliPath(recipeInput),
            });
            library = await loadRecipeLibraries(librarySources, {
              adapter: options.adapter,
            });
          }
          librarySources = librarySources.map((source) => ({
            ...source,
            provenance: source.provenance ?? {
              kind: 'library' as const,
              trust: 'unknown' as const,
              name: source.name,
              path: source.root,
            },
          }));
          if (options.list) {
            printRecipeList(library.recipes, options.json === true);
            return;
          }
          if (!recipeInput) throw new Error('Missing recipe. Use --list to discover recipes.');
          const selected = library.recipes.get(recipeInput);
          if (options.describe) {
            const document = selected
              ? selected.document
              : await readRecipeCliJsonFile(recipeInput);
            printRecipeDescription(recipeInput, document, selected, options.json === true);
            return;
          }
          if (!options.artifactsDir) throw new Error('Missing --artifacts-dir.');
          if (!options.actionManifest) throw new Error('Missing --action-manifest.');
          const manifest = await readRecipeCliJsonFile(options.actionManifest);
          const runner = createRecipeRunner({
            actionManifest: manifest as RecipeActionManifestDocument,
            adapters: createStandardCoreAdapters({
              actions: getRecipeActionManifestActionNames(manifest),
            }),
            defaultSource: {
              kind: 'operator',
              trust: 'trusted',
              name: '@farmslot/recipe-harness CLI',
            },
            logger: console,
          });
          const trust = resolveRecipeTrustInput({
            sourceTrust: options.sourceTrust,
            sourceKind: options.sourceKind,
            sourceName: options.sourceName,
            sourceDigest: options.sourceDigest,
            approvalDigest: options.approvePlan,
          });
          const invocationTrust = trust.source?.trust ?? 'trusted';
          const executionLibrarySources = applyTaskLocalInvocationTrust(
            librarySources,
            invocationTrust,
          );
          const result = await runner.run({
            recipePath: selected ? selected.path : resolveRecipeCliPath(recipeInput),
            artifactsDir: resolveRecipeCliPath(options.artifactsDir),
            projectRoot: options.projectRoot
              ? resolveRecipeCliPath(options.projectRoot)
              : resolveRecipeCliPath('.'),
            recordVideo: parseRecordVideoOptions(options),
            params: parseRecipeParamAssignments(params),
            ...(options.adapter ? { adapter: options.adapter } : {}),
            ...trust,
            ...(!trust.source && selected ? { source: selected.provenance } : {}),
            ...(executionLibrarySources.length > 0
              ? { librarySources: executionLibrarySources }
              : {}),
          });
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`Recipe run: ${result.status}`);
            console.log(`Artifacts: ${result.artifactManifestPath}`);
          }
          if (result.status !== 'pass') process.exitCode = 1;
        } catch (error) {
          if (!(error instanceof RecipeTrustError) && !(error instanceof RecipeResolutionError)) {
            throw error;
          }
          if (options.json) {
            console.log(
              JSON.stringify(
                error instanceof RecipeTrustError
                  ? error.failure
                  : { code: error.code, message: error.message, userAction: error.userAction },
                null,
                2,
              ),
            );
          } else {
            console.error(`Error [${error.code}]: ${error.message}`);
            console.error(`Next: ${error.userAction}`);
          }
          process.exitCode = 1;
        }
      },
    );
}

interface RecipeParameterSummary {
  name: string;
  type?: string;
  required: boolean;
  default?: unknown;
  description?: string;
}

function recipeParameters(document: unknown): RecipeParameterSummary[] {
  if (!isRecord(document) || !isRecord(document.paramsSchema)) return [];
  const schema = document.paramsSchema;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  if (!isRecord(schema.properties)) return [];
  return Object.entries(schema.properties).map(([name, value]) => {
    const property = isRecord(value) ? value : {};
    return {
      name,
      ...(typeof property.type === 'string' ? { type: property.type } : {}),
      required: required.has(name),
      ...(Object.hasOwn(property, 'default') ? { default: property.default } : {}),
      ...(typeof property.description === 'string' ? { description: property.description } : {}),
    };
  });
}

function recipeSummary(ref: string, document: unknown, selected?: ResolvedLibraryRecipe) {
  const record = isRecord(document) ? document : {};
  return {
    ref,
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    parameters: recipeParameters(document),
    ...(selected
      ? {
          source: selected.source,
          file: selected.file,
          adapter: selected.adapter ?? null,
          shadows: selected.shadows,
        }
      : {}),
  };
}

function printRecipeList(recipes: ReadonlyMap<string, ResolvedLibraryRecipe>, json: boolean): void {
  const entries = [...recipes.values()]
    .sort((left, right) => left.ref.localeCompare(right.ref))
    .map((entry) => recipeSummary(entry.ref, entry.document, entry));
  if (json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  console.log(`Runnable recipes (${entries.length})`);
  for (const entry of entries) {
    const shadows = entry.shadows?.length ? ` (shadows: ${entry.shadows.join(', ')})` : '';
    console.log(`  ${entry.ref}${entry.description ? ` — ${entry.description}` : ''}${shadows}`);
  }
}

function printRecipeDescription(
  ref: string,
  document: unknown,
  selected: ResolvedLibraryRecipe | undefined,
  json: boolean,
): void {
  const entry = recipeSummary(ref, document, selected);
  if (json) {
    console.log(JSON.stringify(entry, null, 2));
    return;
  }
  console.log(entry.title ? `${entry.ref} — ${entry.title}` : entry.ref);
  if (entry.description) console.log(entry.description);
  if (entry.shadows?.length) console.log(`Shadows: ${entry.shadows.join(', ')}`);
  if (entry.parameters.length === 0) {
    console.log('Parameters: none');
    return;
  }
  console.log('Parameters:');
  for (const parameter of entry.parameters) {
    const defaultValue = Object.hasOwn(parameter, 'default')
      ? ` default=${JSON.stringify(parameter.default)}`
      : '';
    const requirement = parameter.required ? ' required' : '';
    console.log(
      `  ${parameter.name}${parameter.type ? ` (${parameter.type})` : ''}${requirement}${defaultValue}${parameter.description ? ` — ${parameter.description}` : ''}`,
    );
  }
}

function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseRecordVideoOptions(options: RunCommandOptions): false | RecipeVideoRecordingOptions {
  if (!options.recordVideo) return false;
  const mode =
    typeof options.recordVideo === 'string' && options.recordVideo !== 'true'
      ? options.recordVideo
      : 'full-run';
  if (mode === 'proof-window' || mode === 'proof_window') {
    throw new Error(
      '--record-video=proof-window is reserved for future focused clips; use --record-video=full-run for phase 1.',
    );
  }
  if (mode !== 'full-run' && mode !== 'off') {
    throw new Error('--record-video must be full-run or off.');
  }
  const target = parseRecordingTarget(options);
  return {
    mode,
    ...(options.recordMaxFps ? { maxFps: parsePositiveInteger(options.recordMaxFps) } : {}),
    ...(options.recordMaxSize ? { maxSize: parsePositiveInteger(options.recordMaxSize) } : {}),
    ...(target ? { target } : {}),
  };
}
