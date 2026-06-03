import { execFile } from 'node:child_process';

import type { RunnerSessionUsage } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import { isLocal } from '../core/exec.js';
import { farmslotRoot } from '../fleet/state.js';

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

export async function extractRunnerSessionUsage({
  slotId,
  vars,
  runner,
  runnerSessionId,
  runnerSessionPath,
}: {
  slotId: string;
  vars?: SlotVars;
  runner?: string | null;
  runnerSessionId?: string | null;
  runnerSessionPath?: string | null;
}): Promise<RunnerSessionUsage> {
  if (!runnerSessionPath) {
    return unavailableRunnerSessionUsage({
      runner,
      runnerSessionId,
      runnerSessionPath: null,
      error: 'runner did not expose a session transcript path',
    });
  }
  if (vars && !isLocal(vars.host, vars.machine)) {
    return unavailableRunnerSessionUsage({
      runner,
      runnerSessionId,
      runnerSessionPath,
      error: 'runner transcript usage extraction for remote slots is not implemented',
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
