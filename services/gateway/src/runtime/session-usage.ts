import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

import type { RunnerSessionUsage } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { farmslotRoot } from '../fleet/state.js';
import { listRunnerSessionFiles } from '../runners/session-process.js';

function parseNumberLine(lines: string[], prefix: string): number | null {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (!line) return null;
  const n = Number.parseFloat(line.split('=')[1] ?? '');
  return Number.isFinite(n) ? n : null;
}

function parseStringLine(lines: string[], prefix: string): string | null {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (!line) return null;
  const value = line.slice(prefix.length).trim();
  return value && value !== 'unknown' ? value : null;
}

export function parseSessionUsageOutput(
  stdout: string,
  seed: Pick<RunnerSessionUsage, 'runner' | 'runnerSessionId' | 'runnerSessionPath'> = {},
): RunnerSessionUsage {
  const lines = stdout.split('\n');
  return {
    ...seed,
    actualModel: parseStringLine(lines, 'model='),
    turns: parseNumberLine(lines, 'turns='),
    inputTokens: parseNumberLine(lines, 'input_tokens='),
    outputTokens: parseNumberLine(lines, 'output_tokens='),
    cacheCreation: parseNumberLine(lines, 'cache_creation='),
    cacheRead: parseNumberLine(lines, 'cache_read='),
    reasoningOutputTokens: parseNumberLine(lines, 'reasoning_output_tokens='),
    totalTokens: parseNumberLine(lines, 'total_tokens='),
    costUsd: parseNumberLine(lines, 'cost_usd='),
    measuredAt: new Date().toISOString(),
    source: 'runner-transcript',
    scope: 'session-total',
  };
}

export function unavailableRunnerSessionUsage({
  runner,
  runnerSessionId,
  runnerSessionPath,
  error,
}: {
  runner?: string | null;
  runnerSessionId?: string | null;
  runnerSessionPath?: string | null;
  error: string;
}): RunnerSessionUsage {
  return {
    runner: runner ?? null,
    runnerSessionId: runnerSessionId ?? null,
    runnerSessionPath: runnerSessionPath ?? null,
    measuredAt: new Date().toISOString(),
    source: 'unavailable',
    error,
  };
}

/**
 * Pick the transcript that belongs to THIS run's dispatch window. `paths` is
 * newest-first; we return the newest whose mtime falls between the run's dispatch
 * and completion (with a small clock-skew buffer). Bounding to the window stops a
 * later/earlier run's session in the same slot repo from being charged to this run.
 */
function pickRunSessionTranscript(
  paths: string[],
  dispatchedAt: string,
  completedAt?: string | null,
): string | null {
  const start = Date.parse(dispatchedAt) - 5 * 60_000;
  if (!Number.isFinite(start)) return null;
  const end = (completedAt ? Date.parse(completedAt) : Date.now()) + 5 * 60_000;
  for (const candidate of paths) {
    let mtime: number;
    try {
      mtime = statSync(candidate).mtimeMs;
    } catch {
      // Transcript discovery races with CLI-owned files; skip any that vanished.
      continue;
    }
    if (mtime >= start && mtime <= end) return candidate;
  }
  return null;
}

export async function extractRunnerSessionUsage({
  slotId,
  vars,
  runner,
  runnerSessionId,
  runnerSessionPath,
  dispatchedAt,
  completedAt,
}: {
  slotId: string;
  vars?: SlotVars;
  runner?: string | null;
  runnerSessionId?: string | null;
  runnerSessionPath?: string | null;
  /** Run dispatch time — required to safely re-discover a missing transcript path. */
  dispatchedAt?: string | null;
  /** Run completion time — upper-bounds re-discovery to the run's own session. */
  completedAt?: string | null;
}): Promise<RunnerSessionUsage> {
  // Remote slots first: never re-discover or extract a transcript remotely.
  if (vars && !isLocal(vars.host, vars.machine)) {
    return unavailableRunnerSessionUsage({
      runner,
      runnerSessionId,
      runnerSessionPath: runnerSessionPath ?? null,
      error: 'runner transcript usage extraction for remote slots is not implemented',
    });
  }
  // Local: the session path is captured once at dispatch. If that poll missed
  // (rollout not yet written, or pre-fix gateway), re-discover it at read time so
  // extraction is idempotent — but only a transcript inside this run's dispatch
  // window, so another run's session can't be mis-attributed.
  if (!runnerSessionPath && vars && runner && dispatchedAt) {
    const discovered = await listRunnerSessionFiles(vars, runner);
    const chosen = pickRunSessionTranscript(discovered, dispatchedAt, completedAt);
    if (chosen) {
      runnerSessionPath = chosen;
      runnerSessionId = runnerSessionId ?? path.basename(chosen, '.jsonl');
    }
  }
  if (!runnerSessionPath) {
    return unavailableRunnerSessionUsage({
      runner,
      runnerSessionId,
      runnerSessionPath: null,
      error: 'runner did not expose a session transcript path',
    });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RUNNER_SESSION_PATH: runnerSessionPath,
    RUNNER_SESSION_RUNNER: runner ?? '',
  };
  return await new Promise<RunnerSessionUsage>((resolve) => {
    execFile(
      'bash',
      [`${farmslotRoot}/scripts/session-usage.sh`, slotId, 'total'],
      { env, timeout: 30_000 },
      (err, stdout) => {
        if (err) {
          resolve(
            unavailableRunnerSessionUsage({
              runner,
              runnerSessionId,
              runnerSessionPath,
              error: err.message,
            }),
          );
          return;
        }
        resolve(
          parseSessionUsageOutput(stdout, {
            runner: runner ?? null,
            runnerSessionId: runnerSessionId ?? null,
            runnerSessionPath,
          }),
        );
      },
    );
  });
}
