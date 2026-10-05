// The host's action catalog: where its bundled library lives, how an adapter's
// action manifest resolves across library sources, and the risk each bundled
// action carries. `run`, `call` and the discovery helpers below read actions
// only through it.
import {
  OFFICIAL_RECIPE_ACTIONS,
  type OfficialActionName,
  officialRecipeActionCapabilities,
  type RecipeActionManifestDocument,
  type RecipeExecutionCapability,
  type RecipeSourceProvenance,
} from '@farmslot/protocol';
import type { RecipeLibrarySource } from '@farmslot/recipe-runner';

import { actionCapabilityMatrix, actionCategory, type ActionMatrixRow } from '../action-catalog.js';

import { harnessAdapters } from './adapters.js';
import { color } from './cli-color.js';
import { isSensitiveKey, redactStructuredValue } from './command-journal.js';
import { harnessHost } from './host.js';
import { isRecord, shellQuoteArg } from './parse-args.js';
import { closest } from './suggest.js';

/** Where one resolved action came from. */
export interface ActionCapabilitySource {
  name: string;
  tier: 'official' | 'personal' | 'team' | 'canonical' | 'task';
  manifestPath: string;
  shadows?: string[];
  trust?: RecipeSourceProvenance['trust'];
  implementationRoot?: string;
  digest?: string;
  resolveDigest?: () => Promise<string>;
}

export interface ResolvedActionManifest {
  manifest: RecipeActionManifestDocument;
  actionSources: Map<string, ActionCapabilitySource>;
}

export interface RecipeCatalog {
  /** The library the host ships: its source name, root, and the namespace of its action names. */
  bundledLibrary: { name: string; root: string; actionNamespace: string };
  /**
   * The adapter's action manifest merged across the library sources (the
   * bundled one last), or the override manifest with its task action root.
   */
  resolveActionManifest(
    adapter: string,
    overridePath?: string,
    sources?: readonly RecipeLibrarySource[],
    taskActionRoot?: string,
  ): Promise<ResolvedActionManifest>;
  /** Throws when the manifest document is invalid. */
  validateManifest(manifest: RecipeActionManifestDocument): Promise<unknown>;
  /** The execution capabilities the host enforces for a bundled action. */
  actionCapabilities(action: string): readonly RecipeExecutionCapability[];
}

export interface DescribedAction {
  name: string;
  kind: 'official' | 'custom';
  category: string;
  description: string;
  fields: string[];
  schema?: unknown;
  examples?: unknown;
  result_cases?: string[];
  source: string;
  sourceTier: ActionCapabilitySource['tier'];
  sourceManifest: string;
  shadows: string[];
  capabilities: RecipeExecutionCapability[];
}

const OFFICIAL_ACTIONS = new Set<string>(OFFICIAL_RECIPE_ACTIONS);

/** `--library` arguments that reproduce the non-bundled sources of a lookup. */
export function actionLibraryContextArgs(
  catalog: RecipeCatalog,
  librarySources?: readonly RecipeLibrarySource[],
): string {
  return (librarySources ?? [])
    .filter((source) => source.name !== catalog.bundledLibrary.name)
    .map((source) => {
      const entry = source.name ? `${source.name}=${source.root}` : source.root;
      return ` --library ${shellQuoteArg(entry)}`;
    })
    .join('');
}

/** Every action across the registered adapters, with the adapters that declare it. */
export async function resolveActionCapabilityMatrix(
  catalog: RecipeCatalog,
  librarySources?: readonly RecipeLibrarySource[],
): Promise<ActionMatrixRow[]> {
  const catalogs = await Promise.all(
    harnessAdapters()
      .list()
      .map(async (adapter) => {
        const { manifest, actionSources } = await catalog.resolveActionManifest(
          adapter,
          undefined,
          librarySources,
        );
        return { adapter, actions: describeManifestActions(catalog, manifest, actionSources) };
      }),
  );
  return actionCapabilityMatrix(catalogs);
}

export function describeManifestActions(
  catalog: RecipeCatalog,
  manifest: unknown,
  actionSources: ReadonlyMap<string, ActionCapabilitySource> = new Map(),
): DescribedAction[] {
  const manifestRecord = isRecord(manifest) ? manifest : {};
  const actions = isRecord(manifestRecord.actions) ? manifestRecord.actions : {};
  return Object.entries(actions).map(([name, metadata]) =>
    describeManifestAction(
      catalog,
      name,
      OFFICIAL_ACTIONS.has(name) ? 'official' : 'custom',
      metadata,
      actionSources.get(name),
    ),
  );
}

function describeManifestAction(
  catalog: RecipeCatalog,
  name: string,
  kind: 'official' | 'custom',
  metadata: unknown,
  source: ActionCapabilitySource | undefined,
): DescribedAction {
  const record = isRecord(metadata) ? metadata : {};
  const schema = record.schema;
  const schemaRecord = isRecord(schema) ? schema : {};
  const properties = isRecord(schemaRecord.properties)
    ? Object.keys(schemaRecord.properties)
        .filter((field) => field !== 'action' && field !== 'next')
        .sort()
    : [];
  return {
    name,
    kind,
    category: actionCategory(name, [catalog.bundledLibrary.actionNamespace]),
    description: typeof record.description === 'string' ? record.description : '',
    fields: properties,
    schema,
    examples: record.examples,
    ...(Array.isArray(record.result_cases)
      ? {
          result_cases: record.result_cases.filter(
            (value): value is string => typeof value === 'string',
          ),
        }
      : {}),
    source: source?.name ?? (kind === 'official' ? 'official' : catalog.bundledLibrary.name),
    sourceTier: source?.tier ?? (kind === 'official' ? 'official' : 'canonical'),
    sourceManifest: source?.manifestPath ?? '',
    shadows: source?.shadows ?? [],
    capabilities: [
      ...new Set([
        ...(Array.isArray(record.execution_capabilities)
          ? record.execution_capabilities.filter(
              (value): value is RecipeExecutionCapability => typeof value === 'string',
            )
          : []),
        ...(kind === 'official'
          ? officialRecipeActionCapabilities(name as OfficialActionName)
          : catalog.actionCapabilities(name)),
      ]),
    ],
  };
}

/**
 * One action in full, as `actions --action <name>` and `call <action> --help`
 * print it: the call form, description, source, risk, result cases, fields
 * with their types, up to two authored examples, and the first one as a
 * runnable call with its recipe node.
 */
export function renderActionDetail(
  entry: DescribedAction,
  adapter: string,
  target: string,
  executable: string,
): string {
  const host = harnessHost().name;
  const schema = isRecord(entry.schema) ? entry.schema : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === 'string')
      : [],
  );
  const lines: string[] = [
    `${host} call ${entry.name} [key=value ...] [--arg k=v ...] [flags]`,
    '',
  ];
  if (entry.description) lines.push(`  ${entry.description}`, '');
  lines.push(
    `  Source: ${entry.source}${entry.sourceManifest ? ` (${entry.sourceManifest})` : ''}`,
  );
  if (entry.capabilities.length > 0) lines.push(`  Risk: ${entry.capabilities.join(', ')}`);
  if (entry.result_cases?.length) lines.push(`  Result cases: ${entry.result_cases.join(', ')}`);
  lines.push('');
  if (entry.fields.length === 0) {
    lines.push('  Fields: (none)');
  } else {
    lines.push('  Fields (pass as <name>=<value> or --arg <name>=<value>):');
    const width = Math.max(...entry.fields.map((name) => name.length));
    for (const name of entry.fields) {
      const prop = isRecord(properties[name]) ? properties[name] : {};
      const type = typeof prop.type === 'string' ? prop.type : 'any';
      const req = required.has(name) ? ' (required)' : '';
      const desc = typeof prop.description === 'string' ? ` — ${prop.description}` : '';
      const enumVals = Array.isArray(prop.enum) ? ` [one of: ${prop.enum.join(', ')}]` : '';
      const defaultValue = Object.hasOwn(prop, 'default')
        ? ` [default: ${JSON.stringify(prop.default)}]`
        : '';
      lines.push(`    ${name.padEnd(width)}  ${type}${req}${defaultValue}${desc}${enumVals}`);
    }
  }
  const examples = shortExampleCalls(entry);
  if (examples.length > 0) {
    lines.push('', '  Examples:');
    for (const example of examples) lines.push(`    ${example}`);
  }
  const runnable = renderHumanActionExample(entry, adapter, target, executable);
  if (runnable) lines.push('', runnable);
  return lines.join('\n');
}

function shortExampleCalls(entry: DescribedAction): string[] {
  if (!Array.isArray(entry.examples)) return [];
  const short = entry.name.split('.').pop() ?? entry.name;
  const out: string[] = [];
  for (const example of entry.examples.slice(0, 2)) {
    const node = isRecord(example) ? example : undefined;
    if (!node) continue;
    const tokens = Object.entries(node)
      .filter(([key]) => key !== 'action' && key !== 'intent' && key !== 'next')
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
    out.push(`${harnessHost().name} call ${short} ${tokens.join(' ')}`.trim());
  }
  return out;
}

/** The authored example as a human block: the call that runs it and its recipe node. */
export function renderHumanActionExample(
  entry: DescribedAction,
  adapter: string,
  target: string,
  executable: string,
): string | undefined {
  const node = authoredExampleNode(entry.examples, undefined, entry.schema);
  if (!node) return undefined;
  const out = (style: string, text: string) => color(style, text, { stream: process.stdout });
  const command = actionExampleCommand(entry, adapter, target, executable);
  if (!command) return undefined;
  const lines = [
    out('label', 'Example call:'),
    `  ${out('cmd', command)}`,
    out('label', 'Recipe node:'),
    ...JSON.stringify(node, null, 2)
      .split('\n')
      .map((line) => `  ${line}`),
  ];
  return lines.join('\n');
}

/**
 * A runnable `call` for the action's authored example; `preferredValues` pick
 * the closest example and override its values.
 */
export function actionExampleCommand(
  entry: DescribedAction,
  adapter: string,
  target: string,
  executable: string,
  preferredValues?: Record<string, unknown>,
): string | undefined {
  const node = authoredExampleNode(entry.examples, preferredValues, entry.schema);
  if (!node) return undefined;
  const host = harnessHost().name;
  const commandName = executable.endsWith(`/${host}`) ? host : executable;
  const args = entry.fields.flatMap((field) =>
    Object.hasOwn(node, field)
      ? [shellQuoteArg(`${field}=${safeActionCallValue(field, node[field])}`)]
      : [],
  );
  return [
    shellQuoteArg(commandName),
    'call',
    shellQuoteArg(entry.name),
    ...args,
    '--adapter',
    adapter,
    '--target',
    shellQuoteArg(target),
  ].join(' ');
}

function authoredExampleNode(
  examples: unknown,
  preferredValues?: Record<string, unknown>,
  schema?: unknown,
): Record<string, unknown> | undefined {
  if (!Array.isArray(examples)) return undefined;
  if (preferredValues && Object.keys(preferredValues).length > 0) {
    const normalizedValues = normalizePreferredValues(preferredValues, schema);
    const nodes = examples.filter(isRecord);
    if (nodes.length === 0) return undefined;
    const ranked = nodes
      .map((node) => ({
        node,
        completeness: Object.keys(node).filter(
          (name) => !['action', 'intent', 'next'].includes(name),
        ).length,
        score: Object.entries(normalizedValues).reduce((score, [name, value]) => {
          if (!Object.hasOwn(node, name)) return score;
          return score + (sameActionValue(name, node[name], value) ? 3 : -1);
        }, 0),
      }))
      .sort((left, right) => right.score - left.score || right.completeness - left.completeness);
    return { ...ranked[0]!.node, ...normalizedValues };
  }
  for (const example of examples) {
    if (isRecord(example)) return example;
  }
  return undefined;
}

function normalizePreferredValues(
  preferredValues: Record<string, unknown>,
  schema: unknown,
): Record<string, unknown> {
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  return Object.fromEntries(
    Object.entries(preferredValues).flatMap(([name, value]) => {
      const property = isRecord(properties[name]) ? properties[name] : undefined;
      if (property && !matchesSchemaType(property.type, value)) return [];
      const values = property && Array.isArray(property.enum) ? property.enum : undefined;
      if (!values) {
        return [[name, value]];
      }
      const compatibleValue = values.find((candidate) => sameActionValue(name, candidate, value));
      if (compatibleValue !== undefined) return [[name, compatibleValue]];
      const strings = values.filter(
        (candidate): candidate is string => typeof candidate === 'string',
      );
      const suggestion = typeof value === 'string' ? closest(value, strings) : undefined;
      return suggestion === undefined ? [] : [[name, suggestion]];
    }),
  );
}

function matchesSchemaType(type: unknown, value: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  if (types.every((candidate) => typeof candidate !== 'string')) return true;
  return types.some((candidate) => {
    if (candidate === 'null') return value === null;
    if (candidate === 'array') return Array.isArray(value);
    if (candidate === 'object') return isRecord(value);
    if (candidate === 'integer') return typeof value === 'number' && Number.isInteger(value);
    return typeof value === candidate;
  });
}

function sameActionValue(name: string, left: unknown, right: unknown): boolean {
  if (name === 'state') {
    const canonicalState = (value: unknown) => {
      if (value === 'present') return 'open';
      if (value === 'absent') return 'none';
      return value;
    };
    left = canonicalState(left);
    right = canonicalState(right);
  }
  const scalar = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  if (scalar(left) && scalar(right)) return String(left) === String(right);
  return JSON.stringify(left) === JSON.stringify(right);
}

function actionCallValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function safeActionCallValue(field: string, value: unknown): string {
  if (isSensitiveKey(field)) return `<${field}>`;
  return actionCallValue(redactStructuredValue(value));
}
