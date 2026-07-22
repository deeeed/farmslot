import { isRecord } from './json.js';
import type { RecipeHudOptions } from './types.js';

export function buildHudNode(
  status: 'running' | 'pass' | 'fail',
  event: {
    nodeId: string;
    action: string;
    node: Record<string, unknown>;
    recipe: unknown;
    index: number;
    total: number;
    error?: string;
  },
  options: RecipeHudOptions | false | undefined,
): Record<string, unknown> {
  const title =
    options && options.title
      ? options.title
      : isRecord(event.recipe) && typeof event.recipe.title === 'string'
        ? event.recipe.title
        : 'Recipe run';
  const flow = hudFlow(event.action, event.node);
  const text = hudText(event.action, status, event.node);
  const detail = normalizeHudSecondary(hudDetail(event.node), text, flow);
  return {
    action: 'app.hud',
    title,
    status,
    node_id: event.nodeId,
    phase: lifecyclePhase(status),
    flow: flow || undefined,
    detail,
    text,
    action_name: event.action,
    proves: event.node.proves,
    intent: text,
    error: event.error ? hudErrorSummary(event.error) : undefined,
    display: isRecord(event.node.display) ? event.node.display : hudDisplay(options),
    progress: {
      current: event.index,
      total: event.total,
    },
  };
}

function hudDisplay(options: RecipeHudOptions | false | undefined): Record<string, unknown> {
  if (!options || !options.display) return {};
  return { ...options.display };
}

function lifecyclePhase(status: 'running' | 'pass' | 'fail'): string {
  if (status === 'running') return 'running';
  if (status === 'fail') return 'failed';
  return 'passed';
}

function hudFlow(_action: string, node: Record<string, unknown>): string {
  for (const key of ['flow', 'domain', 'group']) {
    const value = node[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function hudText(
  action: string,
  status: 'running' | 'pass' | 'fail',
  node: Record<string, unknown>,
): string {
  const intent = node.intent;
  if (typeof intent === 'string' && intent.trim()) return intent;
  if (action === 'end') {
    if (status === 'fail') return 'Recipe failed';
    if (status === 'pass') return 'Recipe completed';
    return 'Recipe is finishing';
  }
  throw new Error('Non-terminal recipe nodes must include intent before HUD progress can render.');
}

function hudDetail(node: Record<string, unknown>): string | undefined {
  const explicitDetail = node.detail;
  if (typeof explicitDetail === 'string' && explicitDetail.trim()) return explicitDetail;
  const fragments: string[] = [];
  for (const key of ['target', 'destination', 'selector', 'test_id', 'testID']) {
    const value = node[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      fragments.push(`${key}=${String(value)}`);
    }
  }
  return fragments.length ? fragments.join(' · ') : undefined;
}

function normalizeHudSecondary(
  value: string | undefined,
  intent: string,
  flow: string,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized === intent || normalized === flow) return undefined;
  return normalized;
}

function hudErrorSummary(error: string): string {
  const nestedError = error.match(/"error":"([^"]+)"/)?.[1];
  const lines = error
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line.includes("Warning: The 'NO_COLOR' env")) return false;
      if (line.startsWith('(Use `node --trace-warnings')) return false;
      if (line.startsWith('file://')) return false;
      if (line.startsWith('at ')) return false;
      if (line.startsWith('Node.js ')) return false;
      return true;
    });
  const errorLine =
    [...lines].reverse().find((line) => line.startsWith('Error: ')) ??
    lines.find((line) => line.includes('Error: ')) ??
    lines[0] ??
    error;
  let summary = errorLine.includes('Error: ')
    ? errorLine.slice(errorLine.indexOf('Error: ') + 'Error: '.length)
    : errorLine;
  const resultIndex = summary.indexOf('. Result:');
  if (resultIndex > 0) summary = summary.slice(0, resultIndex);
  if (nestedError && !summary.includes(nestedError)) summary = `${summary}: ${nestedError}`;
  const maxLength = 180;
  return summary.length > maxLength ? `${summary.slice(0, maxLength - 1)}…` : summary;
}
