// session-usage.ts — Runner session token-usage extraction (TypeScript port of the
// Python heredoc embedded in scripts/session-usage.sh).
//
// Pure module: no gateway dependency, no shell-out, no module-load-time side
// effects on HOME. HOME is resolved at call time so tests can set process.env.HOME
// before invoking runSessionUsage and see the correct temp directory.

import { open, readdir, readFile, realpath as fsRealpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type SessionAction = 'snapshot' | 'report' | 'total';

// ─── Pricing tables ──────────────────────────────────────────────────────────

interface ClaudePricing {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

interface OpenaiPricing {
  input: number;
  output: number;
}

// Conservative/optional estimates. If the model doesn't match any entry we omit
// cost_usd rather than inventing a value.
const CLAUDE_PRICING: Record<string, ClaudePricing> = {
  'claude-opus-4-6': { input: 15.0, output: 75.0, cache_write: 18.75, cache_read: 1.5 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cache_write: 3.75, cache_read: 0.3 },
  'claude-haiku-4-5': { input: 0.8, output: 4.0, cache_write: 1.0, cache_read: 0.08 },
};

const OPENAI_PRICING: Record<string, OpenaiPricing> = {
  // GPT-5.6 family (preview GA pricing, USD per 1M tokens).
  'gpt-5.6-sol': { input: 5.0, output: 30.0 },
  'gpt-5.6-terra': { input: 2.5, output: 15.0 },
  'gpt-5.6-luna': { input: 1.0, output: 6.0 },
  'gpt-5.6': { input: 5.0, output: 30.0 }, // bare alias → Sol
  'gpt-5.5': { input: 5.0, output: 15.0 },
  'gpt-5.4': { input: 5.0, output: 15.0 },
};

// ─── Internal totals shape ───────────────────────────────────────────────────

interface SessionTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation: number;
  cache_read: number;
  reasoning_output_tokens: number;
  turns: number;
  model: string;
  total_tokens: number;
  cost_usd: number | null;
}

function emptyTotals(): SessionTotals {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation: 0,
    cache_read: 0,
    reasoning_output_tokens: 0,
    turns: 0,
    model: 'unknown',
    total_tokens: 0,
    cost_usd: null,
  };
}

// ─── Snapshot persisted shape ─────────────────────────────────────────────────

interface SnapshotData {
  runner: string;
  session: string;
  path: string;
  totals: SessionTotals;
}

// ─── JSONL safe iteration ─────────────────────────────────────────────────────

// python urllib.parse.quote(value, safe='') — encodeURIComponent leaves
// !'()* unescaped; percent-encode them too so path keys match the files the
// runner wrote with python semantics.
function pythonQuote(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function* safeJsonLines(filePath: string): AsyncGenerator<Record<string, unknown>> {
  // Read failures propagate (a missing forced transcript must fail loudly, as
  // the python original did); only malformed individual lines are tolerated.
  const content = await readFile(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as unknown;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        yield obj as Record<string, unknown>;
      }
    } catch {
      // Runner transcript files may contain partial/truncated JSONL when the
      // process is still writing. Ignore malformed lines and use complete records.
    }
  }
}

// ─── Repo path matching helpers ───────────────────────────────────────────────

async function grokRepoKey(repoPath: string): Promise<string> {
  try {
    return await fsRealpath(repoPath);
  } catch {
    return path.resolve(repoPath);
  }
}

async function repoPathMatches(
  sessionPath: string | null | undefined,
  repoPath: string,
): Promise<boolean> {
  if (!sessionPath) return false;
  const repoKey = await grokRepoKey(repoPath);
  try {
    return (await fsRealpath(sessionPath)) === repoKey;
  } catch {
    return sessionPath === repoPath || sessionPath === repoKey;
  }
}

// ─── Claude session discovery ─────────────────────────────────────────────────

async function latestClaudeSession(
  home: string,
  repoPath: string,
  slotId: string,
): Promise<{ sessionFile: string; snapshotFile: string } | null> {
  const sessionDir = path.join(home, '.claude', 'projects', repoPath.replaceAll('/', '-'));
  let files: string[];
  try {
    files = await readdir(sessionDir);
  } catch {
    return null;
  }
  const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
  if (!jsonlFiles.length) return null;

  const withMtime = await Promise.all(
    jsonlFiles.map(async (f) => {
      const fp = path.join(sessionDir, f);
      try {
        const s = await stat(fp);
        return { fp, mtime: s.mtimeMs };
      } catch {
        return { fp, mtime: 0 };
      }
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const sessionFile = withMtime[0].fp;
  const snapshotFile = path.join(sessionDir, `.usage-snapshot-${slotId}.json`);
  return { sessionFile, snapshotFile };
}

// ─── Codex session discovery ──────────────────────────────────────────────────

async function findJsonlRecursive(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        results.push(...(await findJsonlRecursive(fullPath)));
      } else if (entry.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    } catch {
      // Session discovery scans third-party runner state; IO failures on
      // individual entries are not Farmslot errors and must not abort the scan.
    }
  }
  return results;
}

async function latestCodexSession(
  home: string,
  repoPath: string,
  slotId: string,
): Promise<{ sessionFile: string; snapshotFile: string } | null> {
  const sessionsRoot = path.join(home, '.codex', 'sessions');
  const allJsonl = await findJsonlRecursive(sessionsRoot);
  const candidates: string[] = [];

  for (const filePath of allJsonl) {
    try {
      const content = await readFile(filePath, 'utf-8');
      const firstLine = content.split('\n').find((l) => l.trim());
      if (!firstLine) continue;
      const first = JSON.parse(firstLine) as Record<string, unknown>;
      if (first.type === 'session_meta') {
        const payload = (first.payload as Record<string, unknown>) ?? {};
        const cwd = payload.cwd as string | undefined;
        if (await repoPathMatches(cwd, repoPath)) {
          candidates.push(filePath);
        }
      }
    } catch {
      // Session discovery scans third-party runner state; unreadable or malformed
      // files are not Farmslot sessions and should not fail the whole status call.
    }
  }

  if (!candidates.length) return null;

  const withMtime = await Promise.all(
    candidates.map(async (fp) => {
      try {
        const s = await stat(fp);
        return { fp, mtime: s.mtimeMs };
      } catch {
        return { fp, mtime: 0 };
      }
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const sessionFile = withMtime[0].fp;
  const snapshotFile = path.join(path.dirname(sessionFile), `.usage-snapshot-${slotId}.json`);
  return { sessionFile, snapshotFile };
}

// ─── Grok session discovery ───────────────────────────────────────────────────

async function grokSessionsDirs(home: string, repoPath: string): Promise<string[]> {
  const repoKey = await grokRepoKey(repoPath);
  // pythonQuote matches Python's urllib.parse.quote(path, safe='') for
  // typical filesystem paths (same unreserved-character set on the common case).
  const keys = new Set([pythonQuote(repoPath), pythonQuote(repoKey)]);
  const dirs: string[] = [];
  for (const key of keys) {
    const candidate = path.join(home, '.grok', 'sessions', key);
    try {
      await stat(candidate);
      dirs.push(candidate);
    } catch {
      // Dir doesn't exist for this encoding key — no sessions to scan.
    }
  }
  return dirs;
}

async function latestGrokSession(
  home: string,
  repoPath: string,
  slotId: string,
): Promise<{ sessionFile: string; snapshotFile: string } | null> {
  const sessionsDirs = await grokSessionsDirs(home, repoPath);
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const sessionsDir of sessionsDirs) {
    let subdirs: string[];
    try {
      subdirs = await readdir(sessionsDir);
    } catch {
      continue;
    }
    for (const sub of subdirs) {
      const sessionDir = path.join(sessionsDir, sub);
      const summaryPath = path.join(sessionDir, 'summary.json');
      try {
        const summaryText = await readFile(summaryPath, 'utf-8');
        const summary = JSON.parse(summaryText) as Record<string, unknown>;
        const info = (summary.info as Record<string, unknown>) ?? {};
        const cwd = info.cwd as string | undefined;
        if (await repoPathMatches(cwd, repoPath)) {
          if (!seen.has(sessionDir)) {
            seen.add(sessionDir);
            candidates.push(sessionDir);
          }
        }
      } catch {
        // Grok may leave partial summary files while the TUI is writing; skip those.
      }
    }
  }

  if (!candidates.length) return null;

  const withMtime = await Promise.all(
    candidates.map(async (d) => {
      try {
        const s = await stat(d);
        return { d, mtime: s.mtimeMs };
      } catch {
        return { d, mtime: 0 };
      }
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const sessionDir = withMtime[0].d;
  const snapshotFile = path.join(sessionDir, `.usage-snapshot-${slotId}.json`);
  return { sessionFile: sessionDir, snapshotFile };
}

// ─── Runner auto-selection ────────────────────────────────────────────────────

interface ChosenSession {
  runner: string;
  sessionFile: string;
  snapshotFile: string;
}

type SessionFinder = (
  home: string,
  repoPath: string,
  slotId: string,
) => Promise<{ sessionFile: string; snapshotFile: string } | null>;

async function chooseSession(
  home: string,
  repoPath: string,
  slotId: string,
): Promise<ChosenSession> {
  const finders: Array<[string, SessionFinder]> = [
    ['claude', latestClaudeSession],
    ['codex', latestCodexSession],
    ['grok', latestGrokSession],
  ];

  const choices: Array<{
    runner: string;
    sessionFile: string;
    snapshotFile: string;
    mtime: number;
  }> = [];

  for (const [runner, finder] of finders) {
    const result = await finder(home, repoPath, slotId);
    if (!result) continue;
    try {
      const s = await stat(result.sessionFile);
      choices.push({ runner, ...result, mtime: s.mtimeMs });
    } catch {
      // A session that was discovered but is no longer stat-able is skipped;
      // the runner must have deleted it between discovery and ranking.
    }
  }

  if (!choices.length) {
    throw new Error(`ERROR: No Claude, Codex, or Grok session found for ${repoPath}`);
  }

  choices.sort((a, b) => b.mtime - a.mtime);
  const { runner, sessionFile, snapshotFile } = choices[0];
  return { runner, sessionFile, snapshotFile };
}

// ─── Claude summarizer ────────────────────────────────────────────────────────

async function summarizeClaude(filePath: string): Promise<SessionTotals> {
  const totals = emptyTotals();
  for await (const obj of safeJsonLines(filePath)) {
    if (obj.type !== 'assistant') continue;
    const msg = (obj.message as Record<string, unknown>) ?? {};
    if (totals.model === 'unknown' && msg.model) {
      totals.model = msg.model as string;
    }
    const usage = (msg.usage as Record<string, unknown>) ?? {};
    if (!Object.keys(usage).length) continue;
    totals.turns += 1;
    totals.input_tokens += (usage.input_tokens as number) ?? 0;
    totals.output_tokens += (usage.output_tokens as number) ?? 0;
    totals.cache_creation += (usage.cache_creation_input_tokens as number) ?? 0;
    totals.cache_read += (usage.cache_read_input_tokens as number) ?? 0;
  }
  const totalInput = totals.input_tokens + totals.cache_creation + totals.cache_read;
  totals.total_tokens = totalInput + totals.output_tokens;
  const prices = Object.entries(CLAUDE_PRICING).find(
    ([k]) => totals.model !== 'unknown' && totals.model.includes(k),
  )?.[1];
  if (prices) {
    totals.cost_usd =
      (totals.input_tokens * prices.input) / 1_000_000 +
      (totals.output_tokens * prices.output) / 1_000_000 +
      (totals.cache_creation * prices.cache_write) / 1_000_000 +
      (totals.cache_read * prices.cache_read) / 1_000_000;
  }
  return totals;
}

// ─── Codex summarizer ─────────────────────────────────────────────────────────

function codexUsageTotal(usage: Record<string, unknown>): number {
  if (usage.total_tokens !== null && usage.total_tokens !== undefined) {
    return (usage.total_tokens as number) ?? 0;
  }
  // Codex/OpenAI usage details treat cached input as part of input_tokens and
  // reasoning output as part of output_tokens; do not double-count detail fields.
  return ((usage.input_tokens as number) ?? 0) + ((usage.output_tokens as number) ?? 0);
}

async function summarizeCodex(filePath: string): Promise<SessionTotals> {
  const totals = emptyTotals();
  let latestUsage: Record<string, unknown> | null = null;

  for await (const obj of safeJsonLines(filePath)) {
    const typ = obj.type as string;
    const payload = (obj.payload as Record<string, unknown>) ?? {};

    if (typ === 'session_meta') {
      const model =
        (payload.model as string | undefined) || (payload.model_slug as string | undefined);
      if (model) totals.model = model;
    } else if (typ === 'turn_context') {
      const model = payload.model as string | undefined;
      if (model) totals.model = model;
    } else if (
      typ === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'assistant'
    ) {
      totals.turns += 1;
    } else if (typ === 'turn.completed' && obj.usage) {
      latestUsage = (obj.usage as Record<string, unknown>) ?? latestUsage;
      totals.turns += 1;
    } else if (typ === 'event_msg' && payload.type === 'token_count') {
      const info = (payload.info as Record<string, unknown>) ?? {};
      const usage =
        (info.total_token_usage as Record<string, unknown> | undefined) ||
        (info.last_token_usage as Record<string, unknown> | undefined);
      if (usage) latestUsage = usage;
    }
  }

  if (latestUsage) {
    totals.input_tokens = (latestUsage.input_tokens as number) ?? 0;
    totals.output_tokens = (latestUsage.output_tokens as number) ?? 0;
    totals.cache_read = (latestUsage.cached_input_tokens as number) ?? 0;
    totals.reasoning_output_tokens = (latestUsage.reasoning_output_tokens as number) ?? 0;
    totals.total_tokens = codexUsageTotal(latestUsage);
  }

  const prices = Object.entries(OPENAI_PRICING).find(
    ([k]) => totals.model !== 'unknown' && totals.model.startsWith(k),
  )?.[1];
  if (prices) {
    totals.cost_usd =
      (totals.input_tokens * prices.input) / 1_000_000 +
      (totals.output_tokens * prices.output) / 1_000_000;
  }
  return totals;
}

// ─── Grok summarizer ──────────────────────────────────────────────────────────

async function summarizeGrok(sessionPath: string, home: string): Promise<SessionTotals> {
  // sessionPath may be a directory (auto-discovered) or a file inside a session dir.
  let isDir = false;
  try {
    isDir = (await stat(sessionPath)).isDirectory();
  } catch {
    // Fall through — treat as file path; parent-dir will be used below.
  }
  const sessionDir = isDir ? sessionPath : path.dirname(sessionPath);
  const summaryPath = path.join(sessionDir, 'summary.json');

  let summaryText: string;
  try {
    summaryText = await readFile(summaryPath, 'utf-8');
  } catch {
    throw new Error(`ERROR: Grok session summary not found at ${summaryPath}`);
  }
  const summary = JSON.parse(summaryText) as Record<string, unknown>;
  const info = (summary.info as Record<string, unknown>) ?? {};
  const sessionId = (info.id as string | undefined) ?? path.basename(sessionDir);

  const totals = emptyTotals();
  totals.model = (summary.current_model_id as string | undefined) ?? 'unknown';

  const logsPath = path.join(home, '.grok', 'logs', 'unified.jsonl');
  let logsContent: string;
  try {
    logsContent = await readFile(logsPath, 'utf-8');
  } catch {
    throw new Error(`ERROR: Grok unified log not found at ${logsPath}`);
  }

  for (const line of logsContent.split('\n')) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.sid !== sessionId || obj.msg !== 'shell.turn.inference_done') continue;
    const ctx = (obj.ctx as Record<string, unknown>) ?? {};
    totals.turns += 1;
    totals.input_tokens += (ctx.prompt_tokens as number) ?? 0;
    totals.output_tokens += (ctx.completion_tokens as number) ?? 0;
    totals.cache_read += (ctx.cached_prompt_tokens as number) ?? 0;
    totals.reasoning_output_tokens += (ctx.reasoning_tokens as number) ?? 0;
  }

  if (totals.turns === 0) {
    throw new Error(`ERROR: No Grok inference usage found for session ${sessionId}`);
  }

  // Grok reports cached_prompt_tokens/reasoning_tokens as detail fields inside
  // prompt_tokens/completion_tokens, so total is prompt + completion only.
  totals.total_tokens = totals.input_tokens + totals.output_tokens;
  return totals;
}

// ─── Cursor summarizer ────────────────────────────────────────────────────────

async function summarizeCursor(filePath: string): Promise<SessionTotals> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (exc) {
    throw new Error(
      `ERROR: Cursor usage requires headless --output-format json stdout: ${(exc as Error).message}`,
    );
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(content) as Record<string, unknown>;
  } catch (exc) {
    throw new Error(
      `ERROR: Cursor usage requires headless --output-format json stdout: ${(exc as Error).message}`,
    );
  }
  const usage = (obj.usage as Record<string, unknown>) ?? {};
  if (!Object.keys(usage).length) {
    throw new Error(
      'ERROR: Cursor transcript does not contain token usage; capture --output-format json stdout',
    );
  }
  const totals = emptyTotals();
  totals.model = (obj.model as string | undefined) ?? 'unknown';
  totals.turns = 1;
  totals.input_tokens = (usage.inputTokens as number) ?? 0;
  totals.output_tokens = (usage.outputTokens as number) ?? 0;
  totals.cache_read = (usage.cacheReadTokens as number) ?? 0;
  totals.cache_creation = (usage.cacheWriteTokens as number) ?? 0;
  totals.total_tokens =
    (usage.totalTokens as number | undefined) ?? totals.input_tokens + totals.output_tokens;
  return totals;
}

// ─── Runner dispatch ──────────────────────────────────────────────────────────

async function summarize(
  runner: string,
  sessionPath: string,
  home: string,
): Promise<SessionTotals> {
  if (runner === 'claude') return summarizeClaude(sessionPath);
  if (runner === 'codex') return summarizeCodex(sessionPath);
  if (runner === 'grok') return summarizeGrok(sessionPath, home);
  if (runner === 'cursor') return summarizeCursor(sessionPath);
  throw new Error(`ERROR: Unsupported runner for usage extraction: ${runner}`);
}

// ─── Session metadata helpers ─────────────────────────────────────────────────

async function sessionName(sessionPath: string): Promise<string> {
  try {
    const s = await stat(sessionPath);
    return s.isDirectory()
      ? path.basename(sessionPath)
      : path.basename(sessionPath, path.extname(sessionPath));
  } catch {
    return path.basename(sessionPath);
  }
}

async function sessionLineCount(sessionPath: string): Promise<number> {
  try {
    const s = await stat(sessionPath);
    if (s.isFile()) {
      const content = await readFile(sessionPath, 'utf-8');
      return content.split('\n').filter((line) => line.length > 0).length;
    }
    // Directory: count lines across all contained JSONL files.
    let total = 0;
    const entries = await readdir(sessionPath);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      try {
        const content = await readFile(path.join(sessionPath, entry), 'utf-8');
        total += content.split('\n').filter((line) => line.length > 0).length;
      } catch {
        // Unreadable file — skip without aborting the count.
      }
    }
    return total;
  } catch {
    return 0;
  }
}

// ─── Output formatting ────────────────────────────────────────────────────────

function formatTotals(totals: SessionTotals): string[] {
  const lines = [
    `turns=${totals.turns}`,
    `model=${totals.model}`,
    `input_tokens=${totals.input_tokens}`,
    `output_tokens=${totals.output_tokens}`,
    `cache_creation=${totals.cache_creation}`,
    `cache_read=${totals.cache_read}`,
    `reasoning_output_tokens=${totals.reasoning_output_tokens}`,
    `total_tokens=${totals.total_tokens}`,
  ];
  if (totals.cost_usd !== null) {
    lines.push(`cost_usd=${totals.cost_usd.toFixed(4)}`);
  }
  return lines;
}

// ─── Incremental sample (poll-time budget / soft ceilings) ───────────────────

/**
 * Durable append-only sample state for poll-time turn/token soft budgets.
 * Offset is the next byte to read; incomplete trailing JSONL is never advanced past.
 */
/** Max new transcript bytes processed per incremental sample (bounds memory). */
export const INCREMENTAL_SESSION_USAGE_MAX_BYTES_PER_SAMPLE = 1024 * 1024;

export type IncrementalSessionUsageState = {
  path: string | null;
  size: number;
  mtimeMs: number;
  /** Byte offset of the first unconsumed byte (after last complete newline). */
  offset: number;
  turns: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  sampledAt?: string;
  unavailableReason?: string;
  /** Soft-budget baseline for warm-handoff / first-poll delta accounting. */
  baselineCaptured?: boolean;
  baselineTurns?: number;
  baselineTotalTokens?: number;
};

export type IncrementalSessionUsageResult = {
  turns: number | null;
  totalTokens: number | null;
  availability: 'available' | 'unavailable' | 'cached';
  unavailableReason?: string;
  nextState: IncrementalSessionUsageState;
};

export function emptyIncrementalSessionUsageState(): IncrementalSessionUsageState {
  return {
    path: null,
    size: 0,
    mtimeMs: 0,
    offset: 0,
    turns: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreation: 0,
    cacheRead: 0,
  };
}

/** Infer runner family for transcript format (shared with path heuristics). */
export function inferSessionUsageRunner(
  runner: string | null | undefined,
  pathHint: string,
): 'claude' | 'codex' | 'other' {
  const r = (runner ?? '').toLowerCase();
  if (r.includes('claude')) return 'claude';
  if (r.includes('codex')) return 'codex';
  if (pathHint.includes('.claude/')) return 'claude';
  if (pathHint.includes('.codex/')) return 'codex';
  return 'other';
}

function recomputeClaudeTotal(state: IncrementalSessionUsageState): number {
  return state.inputTokens + state.cacheCreation + state.cacheRead + state.outputTokens;
}

/** Apply one Claude JSONL object to incremental totals (assistant usage rows). */
export function applyClaudeUsageObject(
  state: IncrementalSessionUsageState,
  obj: Record<string, unknown>,
): IncrementalSessionUsageState {
  if (obj.type !== 'assistant') return state;
  const msg = (obj.message as Record<string, unknown>) ?? {};
  const usage = (msg.usage as Record<string, unknown>) ?? {};
  if (!Object.keys(usage).length) return state;
  const next = { ...state };
  next.turns += 1;
  next.inputTokens += (usage.input_tokens as number) ?? 0;
  next.outputTokens += (usage.output_tokens as number) ?? 0;
  next.cacheCreation += (usage.cache_creation_input_tokens as number) ?? 0;
  next.cacheRead += (usage.cache_read_input_tokens as number) ?? 0;
  next.totalTokens = recomputeClaudeTotal(next);
  return next;
}

/** Apply one Codex JSONL object to incremental totals. */
export function applyCodexUsageObject(
  state: IncrementalSessionUsageState,
  obj: Record<string, unknown>,
): IncrementalSessionUsageState {
  const next = { ...state };
  const typ = obj.type as string;
  const payload = (obj.payload as Record<string, unknown>) ?? {};

  if (typ === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    next.turns += 1;
  } else if (typ === 'turn.completed' && obj.usage) {
    next.turns += 1;
    const usage = obj.usage as Record<string, unknown>;
    next.inputTokens = (usage.input_tokens as number) ?? next.inputTokens;
    next.outputTokens = (usage.output_tokens as number) ?? next.outputTokens;
    next.totalTokens = codexUsageTotal(usage);
  } else if (typ === 'event_msg' && payload.type === 'token_count') {
    const info = (payload.info as Record<string, unknown>) ?? {};
    const usage =
      (info.total_token_usage as Record<string, unknown> | undefined) ||
      (info.last_token_usage as Record<string, unknown> | undefined);
    if (usage) {
      next.inputTokens = (usage.input_tokens as number) ?? next.inputTokens;
      next.outputTokens = (usage.output_tokens as number) ?? next.outputTokens;
      next.cacheRead = (usage.cached_input_tokens as number) ?? next.cacheRead;
      next.totalTokens = codexUsageTotal(usage);
    }
  }
  return next;
}

/**
 * Apply one window of newly read transcript bytes to incremental state.
 * Only complete newline-terminated JSONL records advance the durable offset.
 * Incomplete trailing bytes leave the offset at the incomplete record.
 * If a single record exceeds the max window (no newline in a full window),
 * the window is skipped so sampling always makes forward progress.
 */
export function advanceIncrementalFromBytes(
  prior: IncrementalSessionUsageState,
  buf: Buffer,
  runner: string | null | undefined,
  meta: {
    startOffset: number;
    fileSize: number;
    mtimeMs: number;
    filePath: string;
    maxWindow: number;
  },
): IncrementalSessionUsageState {
  let state: IncrementalSessionUsageState = {
    ...prior,
    path: meta.filePath,
    size: meta.fileSize,
    mtimeMs: meta.mtimeMs,
  };
  const kind = inferSessionUsageRunner(runner, meta.filePath);
  if (kind === 'other') {
    return {
      ...state,
      offset: meta.startOffset,
      unavailableReason: `incremental budget sampling unsupported for runner (path=${meta.filePath})`,
      sampledAt: new Date().toISOString(),
    };
  }

  let lastNl = -1;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] === 0x0a) {
      lastNl = i;
      break;
    }
  }

  if (lastNl < 0) {
    // No complete line in this window.
    if (buf.length >= meta.maxWindow) {
      // Full window without a newline = oversized record; skip the window to
      // guarantee forward progress (usage inside the blob is not counted).
      state.offset = meta.startOffset + buf.length;
      state.sampledAt = new Date().toISOString();
      return state;
    }
    // Partial trailing write — keep offset, wait for more bytes.
    state.offset = meta.startOffset;
    state.sampledAt = new Date().toISOString();
    return state;
  }

  const completeEnd = lastNl + 1;
  const completeText = buf.subarray(0, completeEnd).toString('utf8');
  for (const line of completeText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (kind === 'claude') state = applyClaudeUsageObject(state, obj);
      else if (kind === 'codex') state = applyCodexUsageObject(state, obj);
    } catch {
      // Complete but malformed line — skip.
    }
  }
  state.offset = meta.startOffset + completeEnd;
  state.sampledAt = new Date().toISOString();
  return state;
}

/**
 * Incrementally sample a local transcript file.
 *
 * Only complete newline-terminated JSONL records advance the durable offset.
 * Incomplete trailing bytes (split writes) leave the offset at the incomplete
 * record so the next poll re-reads and counts it when finished.
 */
export async function sampleSessionUsageIncremental(params: {
  filePath: string;
  runner?: string | null;
  prior: IncrementalSessionUsageState;
}): Promise<IncrementalSessionUsageResult> {
  const { filePath, runner, prior } = params;
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) {
      const next = {
        ...emptyIncrementalSessionUsageState(),
        path: filePath,
        size: st.size,
        mtimeMs: st.mtimeMs,
        unavailableReason: 'directory session transcripts are not incrementally sampled',
        sampledAt: new Date().toISOString(),
      };
      return {
        turns: null,
        totalTokens: null,
        availability: 'unavailable',
        unavailableReason: next.unavailableReason,
        nextState: next,
      };
    }

    // Cache only when the file is unchanged *and* we have already consumed through
    // EOF (bounded samples may leave offset < size while size/mtime stay fixed).
    if (
      prior.path === filePath &&
      prior.size === st.size &&
      prior.mtimeMs === st.mtimeMs &&
      prior.offset >= st.size
    ) {
      return {
        turns: prior.turns,
        totalTokens: prior.totalTokens,
        availability: prior.turns > 0 || prior.totalTokens > 0 ? 'cached' : 'available',
        nextState: { ...prior, sampledAt: new Date().toISOString() },
      };
    }

    // Truncation / rotate — restart from byte 0.
    let state: IncrementalSessionUsageState =
      prior.path === filePath && prior.offset <= st.size
        ? { ...prior, path: filePath, size: st.size, mtimeMs: st.mtimeMs }
        : {
            ...emptyIncrementalSessionUsageState(),
            path: filePath,
            size: st.size,
            mtimeMs: st.mtimeMs,
          };

    const start = state.offset;
    if (start >= st.size) {
      state.size = st.size;
      state.mtimeMs = st.mtimeMs;
      state.sampledAt = new Date().toISOString();
      return {
        turns: state.turns,
        totalTokens: state.totalTokens,
        availability: 'available',
        nextState: state,
      };
    }

    // Bound memory: process at most MAX bytes of new data per sample. Further
    // growth is consumed on later polls (offset advances).
    const unread = st.size - start;
    const length = Math.min(unread, INCREMENTAL_SESSION_USAGE_MAX_BYTES_PER_SAMPLE);
    const buf = Buffer.alloc(length);
    const fh = await open(filePath, 'r');
    try {
      await fh.read(buf, 0, length, start);
    } finally {
      await fh.close();
    }

    const advanced = advanceIncrementalFromBytes(state, buf, runner, {
      startOffset: start,
      fileSize: st.size,
      mtimeMs: st.mtimeMs,
      filePath,
      maxWindow: INCREMENTAL_SESSION_USAGE_MAX_BYTES_PER_SAMPLE,
    });
    if (advanced.unavailableReason) {
      return {
        turns: null,
        totalTokens: null,
        availability: 'unavailable',
        unavailableReason: advanced.unavailableReason,
        nextState: advanced,
      };
    }
    return {
      turns: advanced.turns,
      totalTokens: advanced.totalTokens,
      availability: 'available',
      nextState: advanced,
    };
  } catch (err) {
    const next = {
      ...prior,
      path: filePath,
      unavailableReason: (err as Error).message,
      sampledAt: new Date().toISOString(),
    };
    return {
      turns: null,
      totalTokens: null,
      availability: 'unavailable',
      unavailableReason: next.unavailableReason,
      nextState: next,
    };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a session-usage action (snapshot / report / total) for a slot and return
 * the combined output as a single string — same text the bash script printed to
 * stdout. HOME is read at call time via process.env.HOME ?? os.homedir() so
 * that test harnesses which override process.env.HOME before calling see the
 * correct temp directory.
 */
export async function runSessionUsage(params: {
  /** Slot repo path (remote-repo): used only when forcedPath is not provided. */
  repo: string;
  slotId: string;
  action: SessionAction;
  /** Override: skip auto-discovery and use this transcript file/directory directly. */
  forcedPath?: string;
  /** Override: runner name when forcedPath is set. Falls back to path-based heuristic. */
  forcedRunner?: string | null;
}): Promise<string> {
  const { repo, slotId, action, forcedPath, forcedRunner } = params;

  // Read HOME at call time — not at module load — so tests that set
  // process.env.HOME before invoking see the correct temp directory.
  const home = process.env.HOME ?? os.homedir();

  let runner: string;
  let sessionFile: string;
  let snapshotFile: string;

  if (forcedPath) {
    sessionFile = forcedPath;
    // Match Python: empty/missing forced_runner falls back to path-based heuristic.
    runner = (forcedRunner || null) ?? (forcedPath.includes('.claude/') ? 'claude' : 'codex');
    snapshotFile = path.join(path.dirname(forcedPath), `.usage-snapshot-${slotId}.json`);
  } else {
    const chosen = await chooseSession(home, repo, slotId);
    runner = chosen.runner;
    sessionFile = chosen.sessionFile;
    snapshotFile = chosen.snapshotFile;
  }

  const name = await sessionName(sessionFile);

  if (action === 'snapshot') {
    const totals = await summarize(runner, sessionFile, home);
    const data: SnapshotData = { runner, session: name, path: sessionFile, totals };
    await writeFile(snapshotFile, JSON.stringify(data), 'utf-8');
    return `Snapshot saved: ${name}\n`;
  }

  if (action === 'report') {
    let snapshotRaw: string;
    try {
      snapshotRaw = await readFile(snapshotFile, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error("ERROR: No snapshot found. Run 'snapshot' before delivering the prompt.");
      }
      // Permission/IO failures are real errors, not a missing snapshot.
      throw err;
    }
    const snapData = JSON.parse(snapshotRaw) as SnapshotData;
    const current = await summarize(runner, sessionFile, home);
    const base = snapData.totals;
    const header = [
      `Session:  ${name}`,
      `Runner:   ${runner}`,
      `Snapshot: ${snapData.session}`,
      `---`,
    ];
    const diff: SessionTotals = {
      model: current.model,
      turns: current.turns - base.turns,
      input_tokens: current.input_tokens - base.input_tokens,
      output_tokens: current.output_tokens - base.output_tokens,
      cache_creation: current.cache_creation - base.cache_creation,
      cache_read: current.cache_read - base.cache_read,
      reasoning_output_tokens: current.reasoning_output_tokens - base.reasoning_output_tokens,
      total_tokens: current.total_tokens - base.total_tokens,
      cost_usd:
        current.cost_usd !== null && base.cost_usd !== null
          ? current.cost_usd - base.cost_usd
          : null,
    };
    return [...header, ...formatTotals(diff)].join('\n') + '\n';
  }

  if (action === 'total') {
    const current = await summarize(runner, sessionFile, home);
    const lines = await sessionLineCount(sessionFile);
    const header = [`Session:  ${name}`, `Runner:   ${runner}`, `Lines:    ${lines}`, `---`];
    return [...header, ...formatTotals(current)].join('\n') + '\n';
  }

  throw new Error(`Unknown action: ${action}`);
}
