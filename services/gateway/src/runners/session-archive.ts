import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  type AgentContext,
  type AgentRole,
  contextIdFor,
  primaryRoleForFlow,
  type Run,
  type RunnerSessionArchiveRef,
} from '@farmslot/protocol';

import { getAgentContexts, selectAgentContext } from '../agents/contexts.js';
import { writeAtomicJSON } from '../core/atomic-json.js';
import { assertHeavyWriteRoom } from '../core/heavy-write-room.js';
import { slotCopyFile, slotFileExists, type SlotLocality, slotStat } from '../core/slot-io.js';
import { getRun, runSessionArchiveDir, updateRun, updateRunAgentContexts } from '../runs/store.js';

import { runnerSessionArchiveKind } from './registry.js';
import { runnerHistorySessionFilePath } from './worker-session-history.js';

export const SESSION_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;
export const SESSION_ARCHIVE_MAX_LINES = 10_000;
export const SESSION_ARCHIVE_TRANSCRIPT = 'transcript.jsonl';
export const SESSION_ARCHIVE_MANIFEST = 'manifest.json';
/** The session key a pre-Amendment-10 archive reads as; never written to a ref. */
export const LEGACY_SESSION_KEY = 'legacy';
/** A pre-replay capture's bound, including the wait for the run's in-flight capture. */
export const REPLAY_CAPTURE_TIMEOUT_MS = 30_000;

export interface SessionArchiveReleaseResult {
  attempted: number;
  captured: number;
  missing: number;
  skipped: number;
  summary: string;
}

interface ArchiveTarget {
  contextId: string;
  role?: AgentRole;
  runner: string;
  runnerSessionId?: string | null;
  runnerSessionPath: string;
  /** For a review-fix session, the review round it answers. */
  answersRound?: number;
  /** The review round a reviewer or fix capture belongs to. */
  round?: number;
  /** The worker session recorded only on run metrics (no agent context holds it). */
  metricsOwner?: boolean;
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'context';
  return cleaned.slice(0, 80);
}

export function runnerSessionArchiveContextDir(runId: string, contextId: string): string {
  return path.join(runSessionArchiveDir(runId), safeSegment(contextId));
}

export function runnerSessionArchiveRelativeDir(runId: string, contextId: string): string {
  return path.posix.join('session-archives', runId, safeSegment(contextId));
}

function archiveTargets(run: Run): ArchiveTarget[] {
  const fromContexts: ArchiveTarget[] = getAgentContexts(run)
    .filter((ctx): ctx is AgentContext & { runnerSessionPath: string } =>
      Boolean(ctx.runnerSessionPath?.trim()),
    )
    .map((ctx) => ({
      contextId: ctx.id,
      role: ctx.role,
      runner: ctx.runner ?? run.metrics.runner ?? '',
      runnerSessionId: ctx.runnerSessionId,
      runnerSessionPath: ctx.runnerSessionPath,
    }));

  const pathValue = run.metrics.runnerSessionPath?.trim();
  if (pathValue && run.metrics.runner) {
    const already = fromContexts.some(
      (target) =>
        target.runnerSessionPath === pathValue ||
        runnerHistorySessionFilePath(target.runnerSessionPath, target.runner) ===
          runnerHistorySessionFilePath(pathValue, run.metrics.runner),
    );
    if (!already) {
      const role = primaryRoleForFlow(run.flowType);
      fromContexts.push({
        contextId: contextIdFor(role),
        role,
        runner: run.metrics.runner,
        runnerSessionId: run.metrics.runnerSessionId,
        runnerSessionPath: pathValue,
        metricsOwner: true,
      });
    }
  }
  return fromContexts;
}

function resolveArchiveRef(run: Run, contextId?: string): RunnerSessionArchiveRef | undefined {
  if (contextId) {
    return getAgentContexts(run).find((ctx) => ctx.id === contextId)?.runnerSessionArchive;
  }
  const selected = selectAgentContext(run);
  return selected?.runnerSessionArchive ?? run.metrics.runnerSessionArchive;
}

function tailJsonl(raw: string): { lines: string[]; truncated: boolean } {
  const lines = raw.split('\n');
  if (lines.length <= SESSION_ARCHIVE_MAX_LINES) return { lines, truncated: false };
  return { lines: lines.slice(-SESSION_ARCHIVE_MAX_LINES), truncated: true };
}

function isInsideDir(root: string, candidate: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

/** The archive directory of one ref: per-session, or the context directory for a legacy ref. */
function refArchiveDir(runId: string, contextId: string, ref: RunnerSessionArchiveRef): string {
  const contextDir = runnerSessionArchiveContextDir(runId, contextId);
  return ref.sessionKey && ref.sessionKey !== LEGACY_SESSION_KEY
    ? path.join(contextDir, safeSegment(ref.sessionKey))
    : contextDir;
}

async function confinedArchiveTranscript(
  runId: string,
  contextId: string,
  ref: RunnerSessionArchiveRef,
): Promise<string | null> {
  const root = runSessionArchiveDir(runId);
  const filePath = path.join(refArchiveDir(runId, contextId, ref), SESSION_ARCHIVE_TRANSCRIPT);
  try {
    const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(filePath)]);
    if (!isInsideDir(resolvedRoot, resolvedFile)) return null;
    return resolvedFile;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

/** Refs of one archive target: the list, or a legacy single ref read as a one-session list. */
export function archiveRefsOf(
  list: readonly RunnerSessionArchiveRef[] | undefined,
  single: RunnerSessionArchiveRef | undefined,
): RunnerSessionArchiveRef[] {
  // A ref with no session key is a legacy archive, in the list or alone; it reads as `legacy`.
  const view = (ref: RunnerSessionArchiveRef) => ({
    ...ref,
    sessionKey: ref.sessionKey ?? LEGACY_SESSION_KEY,
  });
  if (list?.length) return list.map(view);
  return single ? [view(single)] : [];
}

function sessionKeyFor(
  target: ArchiveTarget,
  refs: readonly RunnerSessionArchiveRef[],
  sourcePath: string,
) {
  const id = target.runnerSessionId?.trim();
  // A runner session reused across review rounds keeps one snapshot per round.
  const round = target.round !== undefined ? `-r${target.round}` : '';
  if (id) return `${safeSegment(id)}${round}`;
  // No runner session id: the same source keeps its attempt, a new one gets the next index.
  const same = refs.find((ref) => ref.originalPath === sourcePath && ref.sessionKey);
  return (
    same?.sessionKey ??
    `attempt-${refs.filter((ref) => ref.sessionKey !== LEGACY_SESSION_KEY).length + 1}`
  );
}

/** The `legacy` key exists only in the list view; it is never written to a ref. */
function withoutLegacyKey<
  T extends {
    list: RunnerSessionArchiveRef[];
    single: RunnerSessionArchiveRef;
    ref: RunnerSessionArchiveRef;
  },
>(merged: T): T {
  const strip = (ref: RunnerSessionArchiveRef): RunnerSessionArchiveRef => {
    if (ref.sessionKey !== LEGACY_SESSION_KEY) return ref;
    const { sessionKey: _legacy, ...rest } = ref;
    return rest;
  };
  return {
    ...merged,
    list: merged.list.map(strip),
    single: strip(merged.single),
    ref: strip(merged.ref),
  };
}

/** Merge a ref into its list; the single ref is the latest captured session, else the newest ref. */
function mergeArchiveRef(refs: RunnerSessionArchiveRef[], ref: RunnerSessionArchiveRef) {
  const index = refs.findIndex((entry) => entry.sessionKey === ref.sessionKey);
  const prior = index >= 0 ? refs[index] : undefined;
  // A retry that is still missing keeps the first reason and records when it was retried.
  const merged: RunnerSessionArchiveRef =
    prior && prior.status === 'missing' && ref.status === 'missing'
      ? { ...ref, reason: prior.reason ?? ref.reason, lastAttemptAt: new Date().toISOString() }
      : // A failed retry never replaces a captured transcript.
        prior?.status === 'captured' && ref.status !== 'captured'
        ? { ...prior, lastAttemptAt: new Date().toISOString() }
        : ref;
  const list =
    index >= 0 ? refs.map((entry, i) => (i === index ? merged : entry)) : [...refs, merged];
  const latestCaptured = [...list].reverse().find((entry) => entry.status === 'captured');
  return { list, single: latestCaptured ?? merged, ref: merged };
}

async function copyJsonlArchive(params: {
  vars: SlotLocality;
  runId: string;
  target: ArchiveTarget;
  refs: readonly RunnerSessionArchiveRef[];
}): Promise<RunnerSessionArchiveRef> {
  const kind = runnerSessionArchiveKind(params.target.runner);
  const sourcePath = runnerHistorySessionFilePath(
    params.target.runnerSessionPath,
    params.target.runner,
  );
  const sessionKey = sessionKeyFor(params.target, params.refs, sourcePath);
  const base = {
    runner: params.target.runner,
    originalPath: sourcePath,
    sessionKey,
    ...(params.target.round !== undefined ? { round: params.target.round } : {}),
    ...(params.target.answersRound !== undefined
      ? { answersRound: params.target.answersRound }
      : {}),
  };
  if (kind === 'none') {
    return {
      status: 'unsupported',
      ...base,
      originalPath: params.target.runnerSessionPath,
      reason: `${params.target.runner || 'runner'} does not archive session transcripts.`,
    };
  }
  const missing = (reason: string, extra: Partial<RunnerSessionArchiveRef> = {}) =>
    ({ status: 'missing', kind, ...base, reason, ...extra }) satisfies RunnerSessionArchiveRef;

  try {
    if (!(await slotFileExists(params.vars, sourcePath)))
      return missing('Runner transcript file is not available on disk.');
    const stat = await slotStat(params.vars, sourcePath);
    if (!stat.isFile) return missing('Runner transcript path is not a file.');
    const source = { sourceSize: stat.size, sourceMtimeMs: stat.mtimeMs };
    if (stat.size > SESSION_ARCHIVE_MAX_BYTES)
      return missing(`Runner transcript is larger than ${SESSION_ARCHIVE_MAX_BYTES} bytes.`, {
        sizeBytes: stat.size,
        ...source,
      });
    // A session captured under the legacy layout, from this same file, is not copied again.
    const legacy = params.refs.find(
      (ref) =>
        ref.sessionKey === LEGACY_SESSION_KEY &&
        ref.status === 'captured' &&
        ref.originalPath === sourcePath,
    );
    if (legacy) return legacy;
    // An unchanged source already captured under any key (a round included) is not copied
    // again: the release backstop, which carries no round, finds a warm reviewer's last round.
    const prior = params.refs.find(
      (ref) =>
        ref.status === 'captured' &&
        ref.originalPath === sourcePath &&
        ref.sourceSize === stat.size &&
        ref.sourceMtimeMs === stat.mtimeMs,
    );
    if (prior) return prior;

    const destDir = path.join(
      runnerSessionArchiveContextDir(params.runId, params.target.contextId),
      sessionKey,
    );
    const destFile = path.join(destDir, SESSION_ARCHIVE_TRANSCRIPT);
    const temporary = `${destFile}.tmp-${randomUUID()}`;
    try {
      // Checked before mkdir, which would otherwise recreate a missing storage root first.
      await assertHeavyWriteRoom(destDir);
      await mkdir(destDir, { recursive: true });
      await slotCopyFile(params.vars, sourcePath, temporary, {
        label: 'runner-session-archive',
        phase: 'download',
        runId: params.runId,
      });
      const bytes = await readFile(temporary);
      if (bytes.byteLength > SESSION_ARCHIVE_MAX_BYTES) {
        await rm(temporary, { force: true });
        return missing(`Runner transcript is larger than ${SESSION_ARCHIVE_MAX_BYTES} bytes.`, {
          sizeBytes: bytes.byteLength,
          ...source,
        });
      }
      const ref: RunnerSessionArchiveRef = {
        status: 'captured',
        kind,
        ...base,
        relativeDir: path.posix.join(
          runnerSessionArchiveRelativeDir(params.runId, params.target.contextId),
          sessionKey,
        ),
        ...source,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.byteLength,
        capturedAt: new Date().toISOString(),
      };
      // Rename into place: a failed copy never removes an earlier captured transcript.
      await rename(temporary, destFile);
      // The bytes are in place: the capture stands. The manifest is a convenience copy of the
      // ref, so a failure to write it is logged rather than recorded as a missing transcript.
      await writeAtomicJSON(path.join(destDir, SESSION_ARCHIVE_MANIFEST), {
        version: 2,
        ...ref,
        contextId: params.target.contextId,
        role: params.target.role,
        runnerSessionId: params.target.runnerSessionId ?? null,
      }).catch((error: unknown) =>
        console.warn(
          `[session-archive] ${params.runId.slice(0, 8)}: manifest not written: ${(error as Error).message}`,
        ),
      );
      return ref;
    } finally {
      await rm(temporary, { force: true });
    }
  } catch (err) {
    return missing(err instanceof Error ? err.message : String(err));
  }
}

/** Captures for one run run one after another; a later caller joins the queue. */
const captureQueues = new Map<string, Promise<unknown>>();

function inCaptureQueue<T>(runId: string, work: () => Promise<T>): Promise<T> {
  const previous = captureQueues.get(runId) ?? Promise.resolve();
  const next = previous.then(work, work);
  captureQueues.set(runId, next);
  void next
    .finally(() => {
      if (captureQueues.get(runId) === next) captureQueues.delete(runId);
    })
    .catch(() => undefined);
  return next;
}

function targetRefs(run: Run, target: ArchiveTarget): RunnerSessionArchiveRef[] {
  const ctx = getAgentContexts(run).find((context) => context.id === target.contextId);
  return ctx
    ? archiveRefsOf(ctx.runnerSessionArchives, ctx.runnerSessionArchive)
    : archiveRefsOf(run.metrics.runnerSessionArchives, run.metrics.runnerSessionArchive);
}

/** Writes one ref: a patch of that context's archive list, or of the worker's metrics refs. */
function recordArchiveRef(runId: string, target: ArchiveTarget, ref: RunnerSessionArchiveRef) {
  const run = getRun(runId);
  if (!run) return ref;
  const merged = withoutLegacyKey(mergeArchiveRef(targetRefs(run, target), ref));
  if (getAgentContexts(run).some((context) => context.id === target.contextId)) {
    updateRunAgentContexts(runId, (_current, contexts) =>
      contexts.map((ctx) =>
        ctx.id === target.contextId
          ? { ...ctx, runnerSessionArchives: merged.list, runnerSessionArchive: merged.single }
          : ctx,
      ),
    );
  }
  // The worker's metrics refs follow the primary context, or stand alone without contexts.
  const latest = getRun(runId)!;
  if (target.metricsOwner || primaryContextId(latest) === target.contextId) {
    const metrics = target.metricsOwner
      ? merged
      : withoutLegacyKey(
          mergeArchiveRef(
            archiveRefsOf(
              latest.metrics.runnerSessionArchives,
              latest.metrics.runnerSessionArchive,
            ),
            ref,
          ),
        );
    // Read and written with no await between: a patch of the current metrics' archive refs.
    updateRun(runId, {
      metrics: {
        ...latest.metrics,
        runnerSessionArchives: metrics.list,
        runnerSessionArchive: metrics.single,
      },
    });
  }
  return merged.ref;
}

function primaryContextId(run: Run): string | undefined {
  return selectAgentContext(run)?.id;
}

async function captureTarget(
  vars: SlotLocality,
  runId: string,
  target: ArchiveTarget,
): Promise<RunnerSessionArchiveRef> {
  const run = getRun(runId);
  if (!run) return { status: 'missing', reason: `No run ${runId}` };
  const ref = await copyJsonlArchive({ vars, runId, target, refs: targetRefs(run, target) });
  return recordArchiveRef(runId, target, ref);
}

/**
 * Captures one agent session when it ends (ADR-039 Amendment 10). Runs after the transition
 * commits; a failure records `missing` and never throws.
 */
export async function captureRunnerSession(params: {
  vars: SlotLocality;
  runId: string;
  contextId: string;
  answersRound?: number;
  round?: number;
}): Promise<RunnerSessionArchiveRef | undefined> {
  const run = getRun(params.runId);
  const target = run && sessionTarget(run, params.contextId);
  if (!target) return undefined;
  return inCaptureQueue(params.runId, () =>
    captureTarget(params.vars, params.runId, {
      ...target,
      answersRound: params.answersRound,
      round: params.round ?? params.answersRound,
    }),
  );
}

/**
 * The session a context ran in: its own, or for a native fix that runs inside the worker's
 * conversation, the owner context's session, recorded on the fix context.
 */
function sessionTarget(run: Run, contextId: string): ArchiveTarget | undefined {
  const own = archiveTargets(run).find((entry) => entry.contextId === contextId);
  if (own) return own;
  const context = getAgentContexts(run).find((entry) => entry.id === contextId);
  const ownerId = context?.nativeSessionOwner?.contextId;
  const owner = ownerId && archiveTargets(run).find((entry) => entry.contextId === ownerId);
  return owner && context
    ? { ...owner, contextId, role: context.role, metricsOwner: false }
    : undefined;
}

/**
 * Captures a session synchronously before a replay replaces it, bounded by `timeoutMs`
 * including the wait for the run's in-flight capture. A timeout records `missing`; a capture
 * that finishes later still records its result.
 */
export async function captureRunnerSessionBeforeReplay(params: {
  vars: SlotLocality;
  runId: string;
  contextId: string;
  timeoutMs?: number;
}): Promise<RunnerSessionArchiveRef | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), params.timeoutMs ?? REPLAY_CAPTURE_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([captureRunnerSession(params), timeout]);
    if (result !== 'timeout') return result;
    const run = getRun(params.runId);
    const target = run && sessionTarget(run, params.contextId);
    if (!target) return undefined;
    const sourcePath = runnerHistorySessionFilePath(target.runnerSessionPath, target.runner);
    return recordArchiveRef(params.runId, target, {
      status: 'missing',
      runner: target.runner,
      originalPath: sourcePath,
      sessionKey: sessionKeyFor(target, targetRefs(run, target), sourcePath),
      reason: 'capture-timeout',
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function archiveRunnerSessionsForSlotRelease(params: {
  vars: SlotLocality;
  runId: string;
}): Promise<SessionArchiveReleaseResult> {
  const run = getRun(params.runId);
  if (!run) {
    return {
      attempted: 0,
      captured: 0,
      missing: 0,
      skipped: 0,
      summary: `No run ${params.runId} to archive`,
    };
  }

  const usage = await import('../runtime/agent-session-usage.js');
  await usage.recoverReleasedRunWorkerUsage(params.runId);
  await usage.captureRunSessionUsage(params.runId);
  return captureAllRunnerSessions({ ...params, run });
}

/**
 * Captures every session of a run not yet captured: the slot-release backstop, and
 * `farmslot runs bundle retain` while the node still holds the files.
 */
export async function captureAllRunnerSessions(params: {
  vars: SlotLocality;
  runId: string;
  run?: Run;
}): Promise<SessionArchiveReleaseResult> {
  const run = params.run ?? getRun(params.runId);
  if (!run)
    return { attempted: 0, captured: 0, missing: 0, skipped: 0, summary: `No run ${params.runId}` };
  let captured = 0;
  let missing = 0;
  let skipped = 0;
  let attempted = 0;

  // Joins a pending session-end capture instead of racing it, then captures every session
  // not yet captured (a changed source is copied again).
  await inCaptureQueue(params.runId, async () => {
    const current = getRun(params.runId) ?? run;
    for (const target of archiveTargets(current)) {
      const before = targetRefs(current, target);
      const ref = await captureTarget(params.vars, params.runId, target);
      if (ref.status === 'unsupported') skipped += 1;
      else if (
        before.some(
          (entry) =>
            entry === ref ||
            (entry.status === 'captured' &&
              entry.sha256 === ref.sha256 &&
              entry.sessionKey === ref.sessionKey),
        )
      )
        skipped += 1;
      else {
        attempted += 1;
        if (ref.status === 'captured') captured += 1;
        else missing += 1;
      }
    }
  });

  const summaryParts = [`archived ${captured}/${attempted + skipped}`];
  if (skipped) summaryParts.push(`${skipped} already stored or unsupported`);
  if (missing) summaryParts.push(`${missing} missing`);
  return {
    attempted,
    captured,
    missing,
    skipped,
    summary:
      attempted + skipped === 0
        ? 'No runner transcript to archive'
        : `Session archive: ${summaryParts.join(', ')}`,
  };
}

export async function readRunnerSessionArchiveLines(params: {
  run: Run;
  contextId?: string;
}): Promise<{
  lines: string[];
  originalPath: string;
  size: number;
  relativeDir: string;
  truncated: boolean;
} | null> {
  const ref = resolveArchiveRef(params.run, params.contextId);
  if (!ref || ref.status !== 'captured' || !ref.originalPath) return null;
  const contextId = params.contextId ?? selectAgentContext(params.run)?.id;
  if (!contextId) return null;
  const filePath = await confinedArchiveTranscript(params.run.id, contextId, ref);
  if (!filePath) return null;
  const raw = await readFile(filePath, 'utf8');
  const { lines, truncated } = tailJsonl(raw);
  return {
    lines,
    originalPath: ref.originalPath,
    size: Buffer.byteLength(raw),
    relativeDir: ref.relativeDir ?? runnerSessionArchiveRelativeDir(params.run.id, contextId),
    truncated,
  };
}

/** Usage reads require a complete, hash-qualified retained transcript. */
export async function verifiedRunnerSessionArchivePath(
  run: Run,
  contextId?: string,
): Promise<string | null> {
  const ref = resolveArchiveRef(run, contextId);
  contextId ??= selectAgentContext(run)?.id;
  if (!ref || ref.status !== 'captured' || !ref.sha256 || !contextId) return null;
  const filePath = await confinedArchiveTranscript(run.id, contextId, ref);
  if (!filePath) throw new Error('Retained runner transcript is missing.');
  const bytes = await readFile(filePath);
  if (
    bytes.length > SESSION_ARCHIVE_MAX_BYTES ||
    createHash('sha256').update(bytes).digest('hex') !== ref.sha256
  ) {
    throw new Error('Retained runner transcript failed its recorded SHA256 identity.');
  }
  return filePath;
}
