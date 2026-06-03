import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadProjectVars } from '../core/config.js';
import { callLLM } from '../llm/index.js';

import { type LlmRecoveryVerdict, parseLlmRecoveryOutput } from './llm-output-schema.js';

export type LlmRecoveryCaller = (input: {
  project: string;
  prompt: string;
  failureText: string;
  signal?: AbortSignal;
}) => Promise<{ output: unknown; costUsd?: number }>;
let callerForTest: LlmRecoveryCaller | null = null;
export function __setLlmRecoveryCallerForTest(caller: LlmRecoveryCaller | null): void {
  callerForTest = caller;
}
function parseJsonObject(text: string): unknown {
  const t = text.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1].trim() : t);
}
async function readPromptTemplate(templatePath: string): Promise<string> {
  try {
    return await readFile(templatePath, 'utf8');
  } catch (err) {
    // Minimal projects/tests may not ship the optional classification prompt.
    // The output schema, API-only caller, timeout, and budget gates still bound
    // the recovery path, so a terse default prompt is safe and deterministic.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'Classify this Farmslot failure.';
    throw err;
  }
}
async function callConfiguredLlm(input: {
  project: string;
  prompt: string;
  failureText: string;
  signal?: AbortSignal;
}): Promise<{ output: unknown; costUsd?: number }> {
  if (
    process.env.NODE_TEST_CONTEXT === '1' &&
    process.env.FARMSLOT_AUTO_RECOVERY_LLM_FIXTURE_JSON
  ) {
    return {
      output: JSON.parse(process.env.FARMSLOT_AUTO_RECOVERY_LLM_FIXTURE_JSON),
      costUsd: Number(process.env.FARMSLOT_AUTO_RECOVERY_LLM_FIXTURE_COST_USD ?? '0'),
    };
  }
  const response = await callLLM({
    systemPrompt:
      'Classify Farmslot transient failures. Return only JSON with category, confidence, and optional proposedAction.',
    userPrompt: `${input.prompt}\n\nFailure text:\n\`\`\`\n${input.failureText.slice(0, 16000)}\n\`\`\``,
    maxTokens: 512,
    signal: input.signal,
    allowCliFallback: false,
  });
  return { output: parseJsonObject(response.text), costUsd: response.usage.costUsd ?? 0 };
}
function costFromError(err: unknown): number {
  const maybe = err as { costUsd?: unknown; usage?: { costUsd?: unknown } };
  const cost =
    typeof maybe.costUsd === 'number'
      ? maybe.costUsd
      : typeof maybe.usage?.costUsd === 'number'
        ? maybe.usage.costUsd
        : 0;
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
async function withOptionalTimeout<T>(
  timeoutMs: number | undefined,
  fn: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined || timeoutMs <= 0) return fn();
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`llm_refine_timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(controller.signal), timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
export async function classifyWithLlm(
  project: string,
  failureText: string,
  options: { timeoutMs?: number } = {},
): Promise<{ verdict: LlmRecoveryVerdict; costUsd: number }> {
  const pv = await loadProjectVars(project);
  const templatePath = path.join(pv.projectTemplatesDir, 'prompts', 'classify-failure.md');
  const prompt = await readPromptTemplate(templatePath);
  try {
    const response = await withOptionalTimeout(options.timeoutMs, (signal) =>
      (callerForTest ?? callConfiguredLlm)({ project, prompt, failureText, signal }),
    );
    return { verdict: parseLlmRecoveryOutput(response.output), costUsd: response.costUsd ?? 0 };
  } catch (err) {
    console.warn(
      `[auto-recovery] llm_refine_failed project=${project} reason=${describeError(err)}`,
    );
    return {
      verdict: { confidence: 'low', warning: 'llm_refine_failed' },
      costUsd: costFromError(err),
    };
  }
}
