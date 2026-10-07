// recipe-quality — front the @farmslot/agent-runtime recipe-quality builder as
// the host's surface for the recipe-quality artifact. The builder is the
// canonical producer (do not reimplement); it validates the result against
// @farmslot/protocol's RecipeQualityArtifact and throws typed errors, so a
// schema-invalid input never reaches disk.
import fs from 'node:fs';
import path from 'node:path';

import {
  buildRecipeQualityArtifact,
  type RecipeQualityArtifactBuilderInput,
} from '@farmslot/agent-runtime';

import { harnessHost } from '../host.js';
import { type CliOptions, optionFlag, optionString, parseArgs } from '../parse-args.js';
import { EXIT, usageOut } from '../shared.js';

export interface RecipeQualityCommandOptions {
  // Subcommands the host adds beside `build` (an advisor, say), by name. They
  // run with the parsed options.
  subcommands?: Readonly<Record<string, (options: CliOptions) => Promise<number>>>;
  // Options only a host subcommand accepts: given without one, they are a usage
  // error that names the subcommand to use.
  subcommandOptions?: { names: readonly string[]; message: string; userAction: string };
  // The usage error for a missing action (default: build is the only one).
  missingAction?: string;
  // The extra help line the shorthand usage prints.
  usageNote?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildUsage(): string {
  return `${harnessHost().name} recipe-quality build --input <compact.json> --output <path> [--json]`;
}

// Invalid input (unparseable JSON or a builder/schema rejection): exit 5
// (validation) with a teaching escape that names what is invalid — distinct from
// a missing-flag usage error (exit 2).
function invalidOut(json: boolean, message: string, source: string): number {
  const userAction = `fix ${source} (${message}), then re-run: ${buildUsage()}`;
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'recipe-quality',
          action: 'build',
          status: 'fail',
          exitCode: EXIT.validation,
          error: { code: 'RECIPE_QUALITY_INVALID', message, userAction },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`✗ ${harnessHost().name} recipe-quality: ${message}\n  Next: ${userAction}`);
  }
  return EXIT.validation;
}

export async function handleRecipeQuality(
  argv: string[],
  commandOptions: RecipeQualityCommandOptions = {},
): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const json = optionFlag(options, 'json');
  const action = positional[0];
  const subcommand = action === undefined ? undefined : commandOptions.subcommands?.[action];
  if (subcommand) return subcommand(options);
  const only = commandOptions.subcommandOptions;
  if (only && only.names.some((key) => options[key] !== undefined)) {
    return usageOut(json, 'recipe-quality', only.message, only.userAction);
  }
  if (!action && (optionString(options, 'input') || optionString(options, 'output'))) {
    return buildArtifact(options, json);
  }
  if (action !== 'build') {
    const message = action
      ? `unknown action '${action}'`
      : (commandOptions.missingAction ?? 'missing action: use build');
    const usage =
      `${buildUsage()}\n` +
      `  Shorthand: ${harnessHost().name} recipe-quality --input <compact.json> --output <path> [--json]` +
      (commandOptions.usageNote ? `\n  Note: ${commandOptions.usageNote}` : '');
    return usageOut(json, 'recipe-quality', message, usage);
  }
  return buildArtifact(options, json);
}

function buildArtifact(options: CliOptions, json: boolean): number {
  const input = optionString(options, 'input');
  const output = optionString(options, 'output');
  if (!input)
    return usageOut(json, 'recipe-quality', 'missing --input <compact.json>', buildUsage());
  if (!output) return usageOut(json, 'recipe-quality', 'missing --output <path>', buildUsage());

  const inputPath = path.resolve(input);
  let raw: string;
  try {
    raw = fs.readFileSync(inputPath, 'utf8');
  } catch (error) {
    return usageOut(
      json,
      'recipe-quality',
      `cannot read --input ${input}: ${errorMessage(error)}`,
      `write the compact recipe-quality JSON to that path, then: ${buildUsage()}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return invalidOut(
      json,
      `--input ${input} is not valid JSON: ${errorMessage(error)}`,
      `--input ${input}`,
    );
  }

  // The builder validates against RecipeQualityArtifact and throws a typed error
  // naming the offending field; nothing is written unless it returns.
  let artifact;
  try {
    artifact = buildRecipeQualityArtifact(parsed as RecipeQualityArtifactBuilderInput);
  } catch (error) {
    return invalidOut(json, errorMessage(error), `--input ${input}`);
  }

  const outputPath = path.resolve(output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);

  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'recipe-quality',
          action: 'build',
          status: 'ok',
          outputPath: output,
          artifact,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`✓ recipe-quality build → ${output} (verdict: ${artifact.verdict})`);
  }
  return EXIT.ok;
}
