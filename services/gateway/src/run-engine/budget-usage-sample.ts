// budget-usage-sample.ts — Poll-time turn/token sampling for the soft budget guard.
// Bounded: reuses a size/mtime cache when the transcript is unchanged, and streams
// only newly appended JSONL bytes from a stored byte offset (local). Remote slots
// sample via execOnSlot + session-usage.sh (same path finalize uses), with the
// same size cache so unchanged remote transcripts are not re-parsed.

import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import type { SlotVars } from '../core/config.js';
import { farmslotRoot } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { parseSessionUsageOutput } from '../runtime/session-usage.js';

/** Durable monitor sample state (also persisted on Run.monitorState). */
export type BudgetUsageSampleState = {
  path: string | null;
  size: number;
  mtimeMs: number;
  /** Next byte offset for local incremental append-only parse. */
  offset: number;
  turns: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  /** Last time a sample was taken (ISO). */
  sampledAt?: string;
  /** When sampling is impossible, a stable reason for operators/logs. */
  unavailableReason?: string;
};

export type BudgetUsageSampleResult = {
  turns: number | null;
  totalTokens: number | null;
  availability: 'available' | 'unavailable' | 'cached';
  unavailableReason?: string;
  nextState: BudgetUsageSampleState;
};

export function emptyBudgetUsageSampleState(): BudgetUsageSampleState {
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

function recomputeClaudeTotal(state: BudgetUsageSampleState): number {
  return state.inputTokens + state.cacheCreation + state.cacheRead + state.outputTokens;
}

/**
 * Advance Claude-style totals from one JSONL object (assistant usage rows only).
 * Pure — exported for unit tests.
 */
export function advanceClaudeUsageLine(
  state: BudgetUsageSampleState,
  obj: Record<string, unknown>,
): BudgetUsageSampleState {
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

/**
 * Advance Codex-style totals. Turn counters + latest total_tokens from token events.
 * Pure — exported for unit tests.
 */
export function advanceCodexUsageLine(
  state: BudgetUsageSampleState,
  obj: Record<string, unknown>,
): BudgetUsageSampleState {
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
    next.totalTokens =
      typeof usage.total_tokens === 'number'
        ? usage.total_tokens
        : next.inputTokens + next.outputTokens;
  } else if (typ === 'event_msg' && payload.type === 'token_count') {
    const info = (payload.info as Record<string, unknown>) ?? {};
    const usage =
      (info.total_token_usage as Record<string, unknown> | undefined) ||
      (info.last_token_usage as Record<string, unknown> | undefined);
    if (usage) {
      next.inputTokens = (usage.input_tokens as number) ?? next.inputTokens;
      next.outputTokens = (usage.output_tokens as number) ?? next.outputTokens;
      next.cacheRead = (usage.cached_input_tokens as number) ?? next.cacheRead;
      next.totalTokens =
        typeof usage.total_tokens === 'number'
          ? usage.total_tokens
          : next.inputTokens + next.outputTokens;
    }
  }
  return next;
}

function runnerKind(runner: string | null | undefined, pathHint: string): 'claude' | 'codex' | 'other' {
  const r = (runner ?? '').toLowerCase();
  if (r.includes('claude')) return 'claude';
  if (r.includes('codex')) return 'codex';
  if (pathHint.includes('.claude/')) return 'claude';
  if (pathHint.includes('.codex/')) return 'codex';
  return 'other';
}

async function streamLocalAppend(
  filePath: string,
  prior: BudgetUsageSampleState,
  runner: string | null | undefined,
): Promise<BudgetUsageSampleState> {
  const st = await stat(filePath);
  // Truncation / rotate — restart accumulation from byte 0.
  let state: BudgetUsageSampleState =
    prior.path === filePath && prior.offset <= st.size
      ? { ...prior, path: filePath, size: st.size, mtimeMs: st.mtimeMs }
      : {
          ...emptyBudgetUsageSampleState(),
          path: filePath,
          size: st.size,
          mtimeMs: st.mtimeMs,
        };

  if (prior.path === filePath && prior.size === st.size && prior.mtimeMs === st.mtimeMs) {
    return { ...state, sampledAt: new Date().toISOString() };
  }

  const kind = runnerKind(runner, filePath);
  const start = state.offset;
  if (start >= st.size) {
    state.size = st.size;
    state.mtimeMs = st.mtimeMs;
    state.sampledAt = new Date().toISOString();
    return state;
  }

  const stream = createReadStream(filePath, { encoding: 'utf8', start });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let bytesConsumed = 0;
  // Track incomplete trailing line when reading mid-write JSONL.
  let carry = '';
  for await (const line of rl) {
    const raw = carry + line;
    carry = '';
    bytesConsumed += Buffer.byteLength(line, 'utf8') + 1; // +1 approx for newline
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (kind === 'claude') state = advanceClaudeUsageLine(state, obj);
      else if (kind === 'codex') state = advanceCodexUsageLine(state, obj);
    } catch {
      // Partial/malformed line — skip (same as session-usage safeJsonLines).
    }
  }

  // Prefer exact EOF from stat for the next offset so we do not drift on CRLF.
  state.offset = st.size;
  state.size = st.size;
  state.mtimeMs = st.mtimeMs;
  state.path = filePath;
  state.sampledAt = new Date().toISOString();
  void bytesConsumed;
  return state;
}

async function remoteFileStat(
  vars: SlotVars,
  filePath: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  const result = await execOnSlot(
    vars,
    `stat -f '%z %m' ${shellQuote(filePath)} 2>/dev/null || stat -c '%s %Y' ${shellQuote(filePath)} 2>/dev/null`,
  );
  if (result.exitCode !== 0) return null;
  const parts = result.stdout.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const size = Number(parts[0]);
  const mtimeSec = Number(parts[1]);
  if (!Number.isFinite(size) || !Number.isFinite(mtimeSec)) return null;
  // macOS stat -f %m and Linux stat -c %Y are seconds.
  return { size, mtimeMs: mtimeSec * 1000 };
}

async function remoteSessionUsageTotal(
  vars: SlotVars,
  slotId: string,
  runnerSessionPath: string,
  runner: string | null | undefined,
): Promise<{ turns: number | null; totalTokens: number | null; error?: string }> {
  const env = [
    `RUNNER_SESSION_PATH=${shellQuote(runnerSessionPath)}`,
    runner ? `RUNNER_SESSION_RUNNER=${shellQuote(runner)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  // Prefer farmslot-root on the slot when available; fall back to remoteRepo layout.
  const script = `${shellQuote(farmslotRoot)}/scripts/session-usage.sh`;
  const cmd = `${env} bash ${script} ${shellQuote(slotId)} total 2>&1`;
  const result = await execOnSlot(vars, cmd);
  if (result.exitCode !== 0) {
    return {
      turns: null,
      totalTokens: null,
      error: `remote session-usage exit ${result.exitCode}: ${result.stdout.slice(0, 200)}`,
    };
  }
  const usage = parseSessionUsageOutput(result.stdout, {
    runner: runner ?? null,
    runnerSessionPath,
  });
  return {
    turns: usage.turns ?? null,
    totalTokens: usage.totalTokens ?? null,
  };
}

/**
 * Sample session turns/tokens for the soft budget guard.
 *
 * - Local: incremental append-only stream from last byte offset (no full re-read).
 * - Remote: session-usage.sh via execOnSlot; skipped when size/mtime unchanged.
 * - Missing path: unavailable (fail-open for evaluation).
 */
export async function sampleBudgetUsage(params: {
  slotId: string;
  vars: SlotVars;
  runner?: string | null;
  runnerSessionPath?: string | null;
  prior: BudgetUsageSampleState;
}): Promise<BudgetUsageSampleResult> {
  const { slotId, vars, runner, runnerSessionPath, prior } = params;
  if (!runnerSessionPath) {
    const next = {
      ...emptyBudgetUsageSampleState(),
      unavailableReason: 'runner did not expose a session transcript path',
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

  const local = isLocal(vars.host, vars.machine);

  if (local) {
    try {
      // Directory sessions (some Grok layouts) fall back to full parse once via
      // open+stream of first JSONL is not enough — use offset 0 stream of the path
      // only when it is a file.
      const fh = await open(runnerSessionPath, 'r');
      const st = await fh.stat();
      await fh.close();
      if (st.isDirectory()) {
        // Bounded fall-back: only re-sample when mtime/size of the directory changes,
        // and use a remote-style full total via local process (still full cost once).
        if (
          prior.path === runnerSessionPath &&
          prior.size === st.size &&
          prior.mtimeMs === st.mtimeMs &&
          prior.turns > 0
        ) {
          return {
            turns: prior.turns,
            totalTokens: prior.totalTokens,
            availability: 'cached',
            nextState: { ...prior, sampledAt: new Date().toISOString() },
          };
        }
        // For directories, keep prior zeroed unavailable — Grok dir parse is heavy;
        // budget guard prefers file transcripts (Claude/Codex).
        const next = {
          ...emptyBudgetUsageSampleState(),
          path: runnerSessionPath,
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

      if (
        prior.path === runnerSessionPath &&
        prior.size === st.size &&
        prior.mtimeMs === st.mtimeMs
      ) {
        return {
          turns: prior.turns,
          totalTokens: prior.totalTokens,
          availability: prior.turns > 0 || prior.totalTokens > 0 ? 'cached' : 'available',
          nextState: { ...prior, sampledAt: new Date().toISOString() },
        };
      }

      const nextState = await streamLocalAppend(runnerSessionPath, prior, runner);
      return {
        turns: nextState.turns,
        totalTokens: nextState.totalTokens,
        availability: 'available',
        nextState,
      };
    } catch (err) {
      const next = {
        ...prior,
        path: runnerSessionPath,
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

  // Remote: size/mtime cache then full session-usage on the slot (cannot stream
  // local-side; still avoids re-parse when the remote file is unchanged).
  try {
    const remoteStat = await remoteFileStat(vars, runnerSessionPath);
    if (
      remoteStat &&
      prior.path === runnerSessionPath &&
      prior.size === remoteStat.size &&
      prior.mtimeMs === remoteStat.mtimeMs &&
      (prior.turns > 0 || prior.totalTokens > 0)
    ) {
      return {
        turns: prior.turns,
        totalTokens: prior.totalTokens,
        availability: 'cached',
        nextState: { ...prior, sampledAt: new Date().toISOString() },
      };
    }

    const usage = await remoteSessionUsageTotal(vars, slotId, runnerSessionPath, runner);
    if (usage.error) {
      const next = {
        ...emptyBudgetUsageSampleState(),
        path: runnerSessionPath,
        size: remoteStat?.size ?? 0,
        mtimeMs: remoteStat?.mtimeMs ?? 0,
        unavailableReason: usage.error,
        sampledAt: new Date().toISOString(),
      };
      return {
        turns: null,
        totalTokens: null,
        availability: 'unavailable',
        unavailableReason: usage.error,
        nextState: next,
      };
    }

    const next: BudgetUsageSampleState = {
      path: runnerSessionPath,
      size: remoteStat?.size ?? 0,
      mtimeMs: remoteStat?.mtimeMs ?? 0,
      offset: remoteStat?.size ?? 0,
      turns: usage.turns ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation: 0,
      cacheRead: 0,
      sampledAt: new Date().toISOString(),
    };
    return {
      turns: usage.turns,
      totalTokens: usage.totalTokens,
      availability: 'available',
      nextState: next,
    };
  } catch (err) {
    const next = {
      ...prior,
      path: runnerSessionPath,
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
