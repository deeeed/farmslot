// Tool-call usage per agent session: runner adapters translate a transcript into one stream,
// one counter splits it at the checklist marks. Farm accounting and the direct-skill path share it.
import { claudeToolUsage } from './adapters/claude.js';
import { codexToolUsage } from './adapters/codex.js';
import { cursorToolUsage } from './adapters/cursor.js';
import { grokToolUsage } from './adapters/grok.js';
import { nativeToolUsage } from './adapters/native.js';
import { piToolUsage } from './adapters/pi.js';
import { countToolUsage, type ToolUsage, type ToolUsageWindow } from './count.js';
import type { ChecklistMark } from './ledger.js';
import { LiveToolUsage } from './live.js';
import type { ToolUsageAdapter } from './stream.js';

export type { ToolUsage, ToolUsageSegment, ToolUsageWindow } from './count.js';
export { countToolUsage, mergeToolUsage } from './count.js';
export type { ChecklistMark } from './ledger.js';
export { checklistMarks, checklistMarksFromSignal } from './ledger.js';
export { LiveToolUsage, type LiveUsageSummary } from './live.js';
export {
  CLAUDE_PRICING,
  type ClaudePricing,
  OPENAI_PRICING,
  openaiCostUsd,
  type OpenaiPricing,
} from './prices.js';
export type {
  CompactionEvent,
  TokenSample,
  ToolCallEvent,
  ToolUsageAdapter,
  ToolUsageStream,
} from './stream.js';
export type { StreamParser } from './stream.js';
export { dropStreamBefore, pairToolEvents } from './stream.js';

const ADAPTERS: readonly ToolUsageAdapter[] = [
  piToolUsage,
  claudeToolUsage,
  codexToolUsage,
  grokToolUsage,
  cursorToolUsage,
  nativeToolUsage,
];

export function toolUsageAdapter(runner: string): ToolUsageAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.runner === runner);
}

/** Reads one session with its runner's adapter and counts it against the marks. */
export async function measureToolUsage(params: {
  runner: string;
  sessionPath: string;
  marks?: ChecklistMark[];
  window?: ToolUsageWindow;
  home?: string;
}): Promise<ToolUsage> {
  const adapter = toolUsageAdapter(params.runner);
  if (!adapter) throw new Error(`No tool-usage adapter for runner ${params.runner}`);
  const stream = await adapter.read(params.sessionPath, { home: params.home });
  return countToolUsage(stream, params.marks ?? [], params.window);
}

/** A live reader for the runner's transcript; undefined when it is not one appendable JSONL file. */
export function createLiveToolUsage(runner: string): LiveToolUsage | undefined {
  const parser = toolUsageAdapter(runner)?.parser;
  return parser ? new LiveToolUsage(runner, parser) : undefined;
}
