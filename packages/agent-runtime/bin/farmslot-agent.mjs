#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function usage(exitCode = 0) {
  const text = [
    'Usage: farmslot-agent <command> [options]',
    '',
    'Commands:',
    '  mark <task-md> <signal-json> <args...>',
    '  artifact-check <task-dir> [args...]',
    '  install-mark <task-dir> [--task TASK.md] [--signal SIGNAL.json]',
    '  recipe-quality build [--input input.json] [--output artifacts/recipe-quality.json]',
    '  contract resolve --flow <flow> [--project-config path] [--mode mode]',
  ].join('\n');
  (exitCode === 0 ? console.log : console.error)(text);
  process.exit(exitCode);
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(path.resolve(filePath), 'utf8'));
}

function readJsonInput(inputPath) {
  if (!inputPath || inputPath === '-') {
    return JSON.parse(readFileSync(0, 'utf8'));
  }
  return readJsonFile(inputPath);
}

function parseBooleanFlag(name, value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function pushFlagValue(target, key, value) {
  const current = target[key];
  if (current == null) target[key] = [value];
  else current.push(value);
}

const RECIPE_QUALITY_INPUT_KEYS = new Set([
  'verdict',
  'reasons',
  'compact',
  'betterVersionGuidance',
  'better_version_guidance',
  'dimensions',
  'structuralFindings',
  'structural_findings',
  'contextualFindings',
  'contextual_findings',
  'suggestedRecipeDelta',
  'suggested_recipe_delta',
  'trainingFields',
  'training_fields',
  'producer',
  'fallbackUsed',
  'fallback_used',
  'fallbackSource',
  'fallback_source',
  'legacyTask',
  'legacy_task',
  'artifactRequired',
  'artifact_required',
  'sourceSignals',
  'source_signals',
  'meta',
  'extra',
]);

const RECIPE_QUALITY_COMPACT_KEYS = new Set(['verdict', 'reasons', 'better_version_guidance']);

const RECIPE_QUALITY_META_KEYS = new Set([
  'producer',
  'fallback_used',
  'fallback_source',
  'legacy_task',
  'artifact_required',
  'source_signals',
]);

function unknownKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function validateRecipeQualityCompact(input) {
  const compact = input.compact;
  if (compact == null) return;
  if (typeof compact !== 'object' || Array.isArray(compact)) {
    throw new Error('recipe-quality input compact must be a JSON object when provided');
  }
  const unknown = unknownKeys(compact, RECIPE_QUALITY_COMPACT_KEYS);
  if (unknown.length > 0) {
    throw new Error(`recipe-quality input compact contains unknown key(s): ${unknown.join(', ')}`);
  }
  const expected = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }[input.verdict];
  if (compact.verdict != null && expected && compact.verdict !== expected) {
    throw new Error(`recipe-quality input compact.verdict must match verdict ${input.verdict}`);
  }
}

function validateRecipeQualityMeta(input) {
  const meta = input.meta;
  if (meta == null) return;
  if (typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error('recipe-quality input meta must be a JSON object when provided');
  }
  const unknown = unknownKeys(meta, RECIPE_QUALITY_META_KEYS);
  if (unknown.length > 0) {
    throw new Error(`recipe-quality input meta contains unknown key(s): ${unknown.join(', ')}`);
  }
}

function validateRecipeQualityInputKeys(input) {
  const unknown = Object.keys(input).filter((key) => !RECIPE_QUALITY_INPUT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`recipe-quality input contains unknown key(s): ${unknown.join(', ')}`);
  }
}

function optionalObject(name, value) {
  if (value == null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  throw new Error(`${name} must be a JSON object when provided`);
}

function mergeRecipeQualityInputs(fileInput, flagInput) {
  return {
    ...fileInput,
    ...flagInput,
    trainingFields: {
      ...optionalObject('trainingFields', fileInput.trainingFields),
      ...optionalObject('trainingFields', flagInput.trainingFields),
    },
  };
}

function parseRecipeQualityBuildArgs(args) {
  const parsed = { input: null, output: null, flags: {} };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = (flag) => {
      const value = args[++i];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (arg === '--input') parsed.input = next(arg);
    else if (arg.startsWith('--input=')) parsed.input = arg.slice('--input='.length);
    else if (arg === '--output') parsed.output = next(arg);
    else if (arg.startsWith('--output=')) parsed.output = arg.slice('--output='.length);
    else if (arg === '--verdict') parsed.flags.verdict = next(arg);
    else if (arg.startsWith('--verdict=')) parsed.flags.verdict = arg.slice('--verdict='.length);
    else if (arg === '--reason') pushFlagValue(parsed.flags, 'reasons', next(arg));
    else if (arg.startsWith('--reason='))
      pushFlagValue(parsed.flags, 'reasons', arg.slice('--reason='.length));
    else if (arg === '--guidance') pushFlagValue(parsed.flags, 'betterVersionGuidance', next(arg));
    else if (arg.startsWith('--guidance='))
      pushFlagValue(parsed.flags, 'betterVersionGuidance', arg.slice('--guidance='.length));
    else if (arg === '--delta') pushFlagValue(parsed.flags, 'suggestedRecipeDelta', next(arg));
    else if (arg.startsWith('--delta='))
      pushFlagValue(parsed.flags, 'suggestedRecipeDelta', arg.slice('--delta='.length));
    else if (arg === '--proof-mode')
      parsed.flags.trainingFields = { ...parsed.flags.trainingFields, proof_mode: next(arg) };
    else if (arg.startsWith('--proof-mode='))
      parsed.flags.trainingFields = {
        ...parsed.flags.trainingFields,
        proof_mode: arg.slice('--proof-mode='.length),
      };
    else if (arg === '--project')
      parsed.flags.trainingFields = { ...parsed.flags.trainingFields, project: next(arg) };
    else if (arg.startsWith('--project='))
      parsed.flags.trainingFields = {
        ...parsed.flags.trainingFields,
        project: arg.slice('--project='.length),
      };
    else if (arg === '--flow-type')
      parsed.flags.trainingFields = { ...parsed.flags.trainingFields, flow_type: next(arg) };
    else if (arg.startsWith('--flow-type='))
      parsed.flags.trainingFields = {
        ...parsed.flags.trainingFields,
        flow_type: arg.slice('--flow-type='.length),
      };
    else if (arg === '--claim-is-visual')
      parsed.flags.trainingFields = { ...parsed.flags.trainingFields, claim_is_visual: true };
    else if (arg === '--producer') parsed.flags.producer = next(arg);
    else if (arg.startsWith('--producer=')) parsed.flags.producer = arg.slice('--producer='.length);
    else if (arg === '--artifact-required')
      parsed.flags.artifactRequired = parseBooleanFlag(arg, next(arg));
    else if (arg.startsWith('--artifact-required='))
      parsed.flags.artifactRequired = parseBooleanFlag(
        arg,
        arg.slice('--artifact-required='.length),
      );
    else if (arg === '--legacy-task') parsed.flags.legacyTask = true;
    else if (arg === '--source-signal') pushFlagValue(parsed.flags, 'sourceSignals', next(arg));
    else if (arg.startsWith('--source-signal='))
      pushFlagValue(parsed.flags, 'sourceSignals', arg.slice('--source-signal='.length));
    else usage(2);
  }
  return parsed;
}

function normalizeRecipeQualityInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('recipe-quality input must be a JSON object');
  }
  validateRecipeQualityInputKeys(input);
  validateRecipeQualityCompact(input);
  validateRecipeQualityMeta(input);
  return {
    verdict: input.verdict,
    reasons: input.reasons ?? input.compact?.reasons,
    betterVersionGuidance:
      input.betterVersionGuidance ??
      input.better_version_guidance ??
      input.compact?.better_version_guidance,
    dimensions: input.dimensions,
    structuralFindings: input.structuralFindings ?? input.structural_findings,
    contextualFindings: input.contextualFindings ?? input.contextual_findings,
    suggestedRecipeDelta: input.suggestedRecipeDelta ?? input.suggested_recipe_delta,
    trainingFields: input.trainingFields ?? input.training_fields,
    producer: input.producer ?? input.meta?.producer,
    fallbackUsed: input.fallbackUsed ?? input.fallback_used ?? input.meta?.fallback_used,
    fallbackSource: input.fallbackSource ?? input.fallback_source ?? input.meta?.fallback_source,
    legacyTask: input.legacyTask ?? input.legacy_task ?? input.meta?.legacy_task,
    artifactRequired:
      input.artifactRequired ?? input.artifact_required ?? input.meta?.artifact_required,
    sourceSignals: input.sourceSignals ?? input.source_signals ?? input.meta?.source_signals,
    extra: input.extra,
  };
}

async function buildRecipeQuality(args) {
  const parsed = parseRecipeQualityBuildArgs(args);
  const fileInput = parsed.input ? normalizeRecipeQualityInput(readJsonInput(parsed.input)) : {};
  const input = mergeRecipeQualityInputs(fileInput, parsed.flags);
  let runtime;
  try {
    runtime = await import('../dist/index.js');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('/dist/index.js') || message.includes('Cannot find module')) {
      throw new Error(
        'farmslot-agent recipe-quality build requires the compiled package. Run yarn workspace @farmslot/agent-runtime build in source checkouts.',
      );
    }
    throw error;
  }
  const artifact = runtime.buildRecipeQualityArtifact(input);
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  if (parsed.output) {
    const outputPath = path.resolve(parsed.output);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, text);
    console.log(`wrote ${outputPath}`);
  } else {
    process.stdout.write(text);
  }
}

function parseInstallMarkArgs(args) {
  const parsed = { taskDir: args[0], task: 'TASK.md', signal: 'SIGNAL.json' };
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--task') {
      parsed.task = args[++i] || parsed.task;
    } else if (arg.startsWith('--task=')) {
      parsed.task = arg.slice('--task='.length);
    } else if (arg === '--signal') {
      parsed.signal = args[++i] || parsed.signal;
    } else if (arg.startsWith('--signal=')) {
      parsed.signal = arg.slice('--signal='.length);
    } else {
      usage(2);
    }
  }
  if (!parsed.taskDir) usage(2);
  return parsed;
}

function installMark(args) {
  const parsed = parseInstallMarkArgs(args);
  const taskDir = path.resolve(parsed.taskDir);
  mkdirSync(taskDir, { recursive: true });
  const markPath = path.join(taskDir, 'mark');
  const binPath = path.join(packageRoot, 'bin', 'farmslot-agent.mjs');
  writeFileSync(
    markPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
      `node ${JSON.stringify(binPath)} mark "$DIR/${parsed.task}" "$DIR/${parsed.signal}" "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  console.log(`installed ${markPath}`);
}

function parseContractResolveArgs(args) {
  const parsed = { flow: null, mode: null, projectConfig: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--flow') parsed.flow = args[++i] || null;
    else if (arg.startsWith('--flow=')) parsed.flow = arg.slice('--flow='.length);
    else if (arg === '--mode') parsed.mode = args[++i] || null;
    else if (arg.startsWith('--mode=')) parsed.mode = arg.slice('--mode='.length);
    else if (arg === '--project-config') parsed.projectConfig = args[++i] || null;
    else if (arg.startsWith('--project-config='))
      parsed.projectConfig = arg.slice('--project-config='.length);
    else usage(2);
  }
  if (!parsed.flow) usage(2);
  return parsed;
}

function resolveContract(args) {
  const parsed = parseContractResolveArgs(args);
  const { resolveWorkerTerminalContract } = require('../scripts/worker-terminal-contract.cjs');
  const projectConfig = parsed.projectConfig
    ? (JSON.parse(readFileSync(path.resolve(parsed.projectConfig), 'utf8')).worker_terminal ?? null)
    : null;
  const contract = resolveWorkerTerminalContract(projectConfig, parsed.flow, {
    mode: parsed.mode,
  });
  console.log(JSON.stringify(contract, null, 2));
}

async function main() {
  const [command, subcommand, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') usage(0);

  if (command === 'mark') {
    runNode(
      path.join(packageRoot, 'scripts', 'mark-checklist-step.cjs'),
      [subcommand, ...rest].filter((arg) => arg !== undefined),
    );
  } else if (command === 'artifact-check') {
    runNode(
      path.join(packageRoot, 'scripts', 'check-task-artifact-contract.mjs'),
      [subcommand, ...rest].filter((arg) => arg !== undefined),
    );
  } else if (command === 'install-mark') {
    installMark([subcommand, ...rest].filter((arg) => arg !== undefined));
  } else if (command === 'contract' && subcommand === 'resolve') {
    resolveContract(rest);
  } else if (command === 'recipe-quality' && subcommand === 'build') {
    await buildRecipeQuality(rest);
  } else {
    usage(2);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
