// ADR-039 Amendment 10: grade, interview and episode-recapture records for run traces.
import { existsSync } from 'node:fs';
import { appendFile, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  isTerminalRunStatus,
  type Principal,
  type RunEpisodeRecaptureParams,
  type RunEpisodeRecaptureResult,
  type RunExternalGrade,
  type RunGradeExternalRecordParams,
  type RunGradeExternalRecordResult,
  type RunInterviewKind,
  type RunInterviewRecordParams,
  type RunInterviewRecordResult,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../../core/method-error.js';
import { captureRunEpisode, runEpisodeDir } from '../../run-completion/run-episode.js';
import { getRunWithArchived } from '../../runs/store.js';

const INTERVIEW_KINDS: readonly RunInterviewKind[] = ['why', 'debrief', 'note'];
const MAX_TEXT = 64 * 1024;

function invalid(message: string): never {
  throw new GatewayMethodError('INVALID_PARAMS', message);
}

function text(value: unknown, name: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${name} must be a non-empty string`);
  if (value.length > max) invalid(`${name} is longer than ${max} characters`);
  return value;
}

function isoTime(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (Number.isNaN(Date.parse(value))) invalid(`${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

async function knownRun(runId: unknown): Promise<string> {
  const id = text(runId, 'runId', 200);
  if (path.basename(id) !== id || !(await getRunWithArchived(id))) invalid(`Run not found: ${id}`);
  return id;
}

/** Appends one grade line to `grades/<run-id>.jsonl`; a correction is a new line. */
export async function runGradeExternalRecord(
  params: RunGradeExternalRecordParams,
  principal: Pick<Principal, 'id'>,
): Promise<RunGradeExternalRecordResult> {
  const runId = await knownRun(params.runId);
  const scale = Array.isArray(params.scale)
    ? params.scale.map((entry) => text(entry, 'scale[]', 100))
    : [];
  if (!scale.length) invalid('scale must list the allowed verdicts');
  const verdict = text(params.verdict, 'verdict', 100);
  if (!scale.includes(verdict)) invalid(`verdict must be one of: ${scale.join(', ')}`);
  const recordedAt = new Date().toISOString();
  const grade: RunExternalGrade = {
    source: text(params.source, 'source', 200),
    grader: text(params.grader, 'grader', 200),
    scale,
    verdict,
    ...(params.rubric !== undefined
      ? {
          rubric: (Array.isArray(params.rubric)
            ? params.rubric
            : invalid('rubric must be a list')
          ).map((entry) => ({
            point: text(entry?.point, 'rubric[].point'),
            verdict: text(entry?.verdict, 'rubric[].verdict', 100),
          })),
        }
      : {}),
    ...(params.reason !== undefined ? { reason: text(params.reason, 'reason', MAX_TEXT) } : {}),
    gradedAt: isoTime(params.gradedAt, 'gradedAt') ?? recordedAt,
    recordedBy: principal.id,
    recordedAt,
  };
  const dir = path.join(runEpisodeDir(), 'grades');
  await mkdir(dir, { recursive: true });
  // One write call per line: concurrent appends never interleave inside a line.
  await appendFile(path.join(dir, `${runId}.jsonl`), `${JSON.stringify(grade)}\n`, 'utf8');
  return { grade };
}

/** Stores one interview as `interviews/<run-id>/<n>-<kind>.md`, never overwriting another. */
export async function runInterviewRecord(
  params: RunInterviewRecordParams,
): Promise<RunInterviewRecordResult> {
  const runId = await knownRun(params.runId);
  if (!INTERVIEW_KINDS.includes(params.kind))
    invalid(`kind must be one of: ${INTERVIEW_KINDS.join(', ')}`);
  const body = text(params.text, 'text', MAX_TEXT);
  const dir = path.join(runEpisodeDir(), 'interviews', runId);
  await mkdir(dir, { recursive: true });
  for (let n = 1; n <= 999; n++) {
    const number = String(n).padStart(3, '0');
    try {
      // The number is reserved by exclusive create, shared by every kind, so concurrent records
      // never take the same number or overwrite each other.
      await (await open(path.join(dir, `.${number}`), 'wx')).close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    const file = `${number}-${params.kind}.md`;
    await writeFile(path.join(dir, file), body.endsWith('\n') ? body : `${body}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return { file };
  }
  return invalid('The run already has 999 interviews');
}

/**
 * Rewrites the episodes of runs that ended in the range, through the same writer the retention
 * pass uses (one run at a time, replaced by rename). The episode store is the index: only runs
 * with an episode in the range are loaded. Returns at once; the rewrite runs behind.
 */
export async function runEpisodeRecapture(
  params: RunEpisodeRecaptureParams,
): Promise<RunEpisodeRecaptureResult> {
  const since = isoTime(text(params.since, 'since', 64), 'since')!;
  const until = isoTime(params.until, 'until');
  const dir = runEpisodeDir();
  const names = existsSync(dir)
    ? (await readdir(dir)).filter((name) => name.endsWith('.json'))
    : [];
  const candidates: string[] = [];
  const sinceMs = Date.parse(since);
  for (const name of names) {
    // An episode file not written since `since` cannot describe a run updated since: skip the
    // parse, so the cost is one stat per older episode.
    const file = path.join(dir, name);
    if ((await stat(file)).mtimeMs < sinceMs) continue;
    let episode: { schema?: string; runId?: string; runUpdatedAt?: string };
    try {
      episode = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      console.warn(`[run-episode] recapture skips ${name}: ${(error as Error).message}`);
      continue;
    }
    // A run that ended in the range was last updated at or after its end: a cheap prefilter.
    if (
      episode.schema === 'farmslot-episode-v1' &&
      episode.runId &&
      (episode.runUpdatedAt ?? '') >= since
    )
      candidates.push(episode.runId);
  }
  const runIds: string[] = [];
  for (const runId of candidates) {
    const run = await getRunWithArchived(runId);
    const ended = run?.completedAt ?? run?.updatedAt ?? '';
    if (run && isTerminalRunStatus(run.status) && ended >= since && (!until || ended <= until))
      runIds.push(runId);
  }
  void (async () => {
    for (const runId of runIds) {
      const run = await getRunWithArchived(runId);
      if (!run) continue;
      await captureRunEpisode(run).catch((error: unknown) =>
        console.warn(`[run-episode] recapture ${run.id}: ${(error as Error).message}`),
      );
    }
    console.log(`[run-episode] recaptured ${runIds.length} episode(s) since ${since}`);
  })();
  return { queued: runIds.length };
}
