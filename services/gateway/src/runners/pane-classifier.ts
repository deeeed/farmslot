import { callLLM } from '../llm/index.js';

export type PaneClassifierState =
  | 'ready'
  | 'busy'
  | 'command_not_submitted'
  | 'prompt_buffered'
  | 'auth_blocked'
  | 'trust_prompt'
  | 'crashed'
  | 'unknown';

export type PaneClassifierAction =
  | 'wait'
  | 'send_enter'
  | 'send_ctrl_m'
  | 'send_yes'
  | 'abort'
  | 'manual';

export interface PaneClassifierResult {
  state: PaneClassifierState;
  confidence: number;
  suggestedAction: PaneClassifierAction;
  reason: string;
}

const STATES: ReadonlySet<PaneClassifierState> = new Set([
  'ready',
  'busy',
  'command_not_submitted',
  'prompt_buffered',
  'auth_blocked',
  'trust_prompt',
  'crashed',
  'unknown',
]);

const ACTIONS: ReadonlySet<PaneClassifierAction> = new Set([
  'wait',
  'send_enter',
  'send_ctrl_m',
  'send_yes',
  'abort',
  'manual',
]);

export function parsePaneClassifierResult(text: string): PaneClassifierResult | null {
  const trimmed = text.trim();
  const jsonText = trimmed.startsWith('{')
    ? trimmed
    : (trimmed.match(/\{[\s\S]*\}/)?.[0] ?? '');
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const state = typeof record.state === 'string' ? record.state : 'unknown';
  const suggestedAction =
    typeof record.suggestedAction === 'string' ? record.suggestedAction : 'manual';
  const rawConfidence = typeof record.confidence === 'number' ? record.confidence : 0;
  const confidence = Math.max(0, Math.min(1, rawConfidence));
  const reason = typeof record.reason === 'string' ? record.reason.slice(0, 300) : 'no reason';

  if (!STATES.has(state as PaneClassifierState)) return null;
  if (!ACTIONS.has(suggestedAction as PaneClassifierAction)) return null;

  return {
    state: state as PaneClassifierState,
    confidence,
    suggestedAction: suggestedAction as PaneClassifierAction,
    reason,
  };
}

export async function classifyRunnerPaneState(opts: {
  runner: string;
  target: string;
  pane: string;
  expected: string;
}): Promise<PaneClassifierResult> {
  const paneTail = opts.pane.split('\n').slice(-90).join('\n');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  let result: Awaited<ReturnType<typeof callLLM>>;
  try {
    result = await callLLM({
      model: 'fast',
      maxTokens: 220,
      allowCliFallback: false,
      signal: controller.signal,
      systemPrompt: [
        'You classify terminal UI state for a tmux-launched coding agent.',
        'Return only compact JSON with keys: state, confidence, suggestedAction, reason.',
        'Allowed state values: ready, busy, command_not_submitted, prompt_buffered, auth_blocked, trust_prompt, crashed, unknown.',
        'Allowed suggestedAction values: wait, send_enter, send_ctrl_m, send_yes, abort, manual.',
        'Use command_not_submitted when a shell prompt visibly contains a command that has not executed.',
        'Use ready when an interactive agent prompt is available for input.',
        'Use busy when the agent is still starting, reading, thinking, or running a command.',
      ].join('\n'),
      userPrompt: [
        `runner: ${opts.runner}`,
        `tmux target: ${opts.target}`,
        `expected: ${opts.expected}`,
        'pane:',
        '```',
        paneTail,
        '```',
      ].join('\n'),
    });
  } finally {
    clearTimeout(timeout);
  }
  return (
    parsePaneClassifierResult(result.text) ?? {
      state: 'unknown',
      confidence: 0,
      suggestedAction: 'manual',
      reason: 'classifier returned invalid JSON',
    }
  );
}

export async function classifyRunnerPaneStateBestEffort(opts: {
  runner: string;
  target: string;
  pane: string;
  expected: string;
}): Promise<PaneClassifierResult> {
  try {
    return await classifyRunnerPaneState(opts);
  } catch (err) {
    // The classifier is a timeout diagnostic fallback. Missing auth or provider
    // failures must not break the deterministic runner path.
    return {
      state: 'unknown',
      confidence: 0,
      suggestedAction: 'manual',
      reason: `classifier unavailable: ${(err as Error).message.slice(0, 180)}`,
    };
  }
}
