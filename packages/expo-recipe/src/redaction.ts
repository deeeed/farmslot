import {
  type ActionAdapter,
  type ActionResult,
  createStandardCoreAdapters,
} from '@farmslot/recipe-harness';

const SENSITIVE_OUTPUT_KEY_PATTERN =
  /(token|secret|password|api[_-]?key|private[_-]?key|auth(?:key|token|secret)|credential)/iu;
const SENSITIVE_TEXT_PATTERN =
  /\b(token|secret|password|api[_-]?key|private[_-]?key|auth(?:key|token|secret)|credential)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu;
const REDACTED_VALUE = '<redacted>';

// Recipe traces persist adapter outputs, so the Expo package redacts command output before the runner writes any artifacts.
export function createRedactingCoreAdapters(actions: string[]): ActionAdapter[] {
  return createStandardCoreAdapters({ actions }).map((adapter) => {
    if (adapter.action !== 'command') return adapter;
    return {
      ...adapter,
      async execute(node, context) {
        return redactActionResult(await adapter.execute(node, context));
      },
    };
  });
}

function redactActionResult(result: ActionResult): ActionResult {
  return result.output === undefined
    ? result
    : { ...result, output: redactSensitiveOutput(result.output) };
}

function redactSensitiveOutput(value: unknown, sensitiveKey = false): unknown {
  if (sensitiveKey) return REDACTED_VALUE;
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveOutput(entry));
  if (value && typeof value === 'object') return redactSensitiveObject(value);
  if (typeof value === 'string') return redactSensitiveString(value);
  return value;
}

function redactSensitiveObject(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      redactSensitiveOutput(entry, SENSITIVE_OUTPUT_KEY_PATTERN.test(key)),
    ]),
  );
}

function redactSensitiveString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return redactSensitiveText(value);
  try {
    return JSON.stringify(redactSensitiveOutput(JSON.parse(value)));
  } catch {
    // Non-JSON stdout/stderr is expected for arbitrary project commands; redact common key=value fragments only.
    return redactSensitiveText(value);
  }
}

function redactSensitiveText(value: string): string {
  return value.replace(SENSITIVE_TEXT_PATTERN, (_match, key: string, separator: string) => {
    return `${key}${separator}${REDACTED_VALUE}`;
  });
}
