// The canary's verdict: results JSON, a one-line status for the lead's watcher, and on failure
// a HOLD file that stops the next fast-forward deploy.
import { publishIfAbsent, writeAtomic, writeJson } from '../lib/isolated-stack.mjs';

import type { CheckResult } from './outcome.mjs';

const BLOCKING = new Set(['fail', 'xpass', 'unverified']);

export interface Verdict {
  ok: boolean;
  exitCode: number;
  summary: string;
}

export function verdict(
  checks: CheckResult[],
  setupError: string | undefined,
  cleanupErrors: string[] = [],
): Verdict {
  if (setupError)
    return { ok: false, exitCode: 2, summary: `could not run: ${setupError.split('\n')[0]}` };
  if (!checks.length) return { ok: false, exitCode: 2, summary: 'could not run: no check ran' };
  const blocking = checks.filter((check) => BLOCKING.has(check.status));
  const known = checks.filter((check) => check.status === 'known');
  const notExercised = checks.filter((check) => check.status === 'not-exercised');
  const name = (check: CheckResult) =>
    `${check.case}${check.variant === '-' ? '' : ` ${check.variant}`}`;
  const passed = checks.filter((check) => check.status === 'pass').length;
  const parts = [`${passed}/${checks.length} checks pass`];
  if (blocking.length)
    parts.push(
      `${blocking.length} ${blocking
        .map((check) => {
          const why = check.error ?? check.differences[0];
          return `${check.status.toUpperCase()} ${name(check)}${why ? ` (${why.slice(0, 120)})` : ''}`;
        })
        .join(', ')}`,
    );
  if (known.length)
    parts.push(
      `${known.length} known: ${known.map((check) => `${name(check)} ${check.ledger}`).join(', ')}`,
    );
  if (notExercised.length) parts.push(`NOT_EXERCISED ${notExercised.map(name).join(', ')}`);
  // On success the status line carries the lifecycle timings.
  if (!blocking.length)
    for (const check of checks.filter(
      (candidate) => candidate.case === 'lifecycle' && candidate.timingsS,
    ))
      parts.push(
        `${check.variant}: ${Object.entries(check.timingsS!)
          .map(([step, seconds]) => `${step} ${seconds}s`)
          .join(' ')}`,
      );
  // What the stack could not stop is still running or still on disk.
  if (cleanupErrors.length)
    parts.push(
      `${cleanupErrors.length} cleanup failed (${cleanupErrors[0]!.split('\n')[0]!.slice(0, 120)})`,
    );
  const unverified = blocking.some((check) => check.status === 'unverified');
  return {
    ok: !blocking.length && !cleanupErrors.length,
    exitCode: blocking.length
      ? unverified && blocking.every((check) => check.status === 'unverified')
        ? 2
        : 1
      : cleanupErrors.length
        ? 1
        : 0,
    summary: parts.join('; '),
  };
}

export async function report(options: {
  profile: string;
  head: string;
  startedAt: Date;
  resultsFile: string;
  statusFile?: string;
  holdFile?: string;
  checks: CheckResult[];
  setupError?: string;
  cleanupErrors: string[];
  evidence: string;
  extra: Record<string, unknown>;
}): Promise<Verdict> {
  const result = verdict(options.checks, options.setupError, options.cleanupErrors);
  const minutes = Math.ceil((Date.now() - options.startedAt.getTime()) / 60_000);
  await writeJson(options.resultsFile, {
    schemaVersion: 2,
    profile: options.profile,
    head: options.head,
    startedAt: options.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    ok: result.ok,
    summary: result.summary,
    modelCalls: options.checks.reduce((sum, check) => sum + check.modelCalls, 0),
    ...options.extra,
    checks: options.checks,
    setupError: options.setupError ?? null,
    cleanupErrors: options.cleanupErrors,
    evidence: options.evidence,
  });
  const stamp = new Date().toISOString().slice(0, 16);
  const line = `${result.ok ? 'OK' : 'BLOCKED'} ${stamp}Z ${options.profile} ${options.head.slice(0, 8)} ${result.summary} (${minutes}m) results=${options.resultsFile}`;
  if (options.statusFile) await writeAtomic(options.statusFile, `${line}\n`);
  console.log(line);
  // A failed canary holds the next deploy, unless something already holds it.
  if (!result.ok && options.holdFile) {
    const time = new Date().toTimeString().slice(0, 5);
    const set = await publishIfAbsent(
      options.holdFile,
      `Canary ${time}: ${options.profile} failed at ${options.head.slice(0, 8)}: ${result.summary}; results=${options.resultsFile}\n`,
    );
    console.log(`deploy hold ${set ? 'set' : 'already set'}: ${options.holdFile}`);
  }
  return result;
}
