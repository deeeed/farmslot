import { isRecord, RECIPE_PROTOCOL_SCHEMA_URL } from '@farmslot/protocol';

import type { IndexedAction } from './discovery-index.js';
import type { DiscoveryParameter } from './types.js';

const STEP_ID = 'step';
const DONE_ID = 'done';

/** A workflow node for an action: its first authored example, else one built from the schema. */
export function actionTemplateNode(action: IndexedAction): Record<string, unknown> {
  const example = action.examples.find(isRecord);
  const fields = example
    ? Object.fromEntries(
        Object.entries(example).filter(([key]) => !['action', 'intent', 'next'].includes(key)),
      )
    : Object.fromEntries(
        action.parameters
          .filter((parameter) => parameter.required)
          .map((parameter) => [parameter.name, placeholder(parameter)]),
      );
  return {
    action: action.name,
    intent:
      typeof example?.intent === 'string'
        ? example.intent
        : `TODO: why this ${action.name} step runs`,
    ...fields,
    next: DONE_ID,
  };
}

/** A `call` node for a recipe with every required parameter that has no default. */
export function recipeTemplateNode(
  ref: string,
  parameters: readonly DiscoveryParameter[],
): Record<string, unknown> {
  const params = Object.fromEntries(
    parameters
      .filter((parameter) => parameter.required && !Object.hasOwn(parameter, 'default'))
      .map((parameter) => [parameter.name, placeholder(parameter)]),
  );
  return {
    action: 'call',
    ref,
    intent: `TODO: why this recipe calls ${ref}`,
    ...(Object.keys(params).length > 0 ? { params } : {}),
    next: DONE_ID,
  };
}

/** A complete recipe wrapping one node, ready to save as `<name>.recipe.json`. */
export function recipeSkeleton(
  title: string,
  node: Record<string, unknown>,
): Record<string, unknown> {
  return {
    $schema: RECIPE_PROTOCOL_SCHEMA_URL,
    title,
    description: 'TODO: what this recipe proves.',
    workflow: {
      entry: STEP_ID,
      nodes: {
        [STEP_ID]: node,
        [DONE_ID]: { action: 'end', status: 'pass' },
      },
    },
  };
}

/** Command-line assignments for required parameters without defaults. */
export function requiredAssignments(parameters: readonly DiscoveryParameter[]): string[] {
  return parameters
    .filter((parameter) => parameter.required && !Object.hasOwn(parameter, 'default'))
    .map((parameter) => `${parameter.name}=${shellQuote(assignmentValue(placeholder(parameter)))}`);
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function placeholder(parameter: DiscoveryParameter): unknown {
  if (parameter.enum && parameter.enum.length > 0) return parameter.enum[0];
  if (parameter.type === 'boolean') return false;
  if (parameter.type === 'number' || parameter.type === 'integer') return 0;
  if (parameter.type === 'array') return [];
  if (parameter.type === 'object') return {};
  return `<${parameter.name}>`;
}

function assignmentValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
