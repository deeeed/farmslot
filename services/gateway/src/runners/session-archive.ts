import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
import { slotCopyFile, slotFileExists, type SlotLocality, slotStat } from '../core/slot-io.js';
import { getRun, runSessionArchiveDir, updateRun, updateRunAgentContexts } from '../runs/store.js';

import { runnerSessionArchiveKind } from './registry.js';
import { runnerHistorySessionFilePath } from './worker-session-history.js';

export const SESSION_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;
export const SESSION_ARCHIVE_MAX_LINES = 10_000;
export const SESSION_ARCHIVE_TRANSCRIPT = 'transcript.jsonl';
export const SESSION_ARCHIVE_MANIFEST = 'manifest.json';

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
  existing?: RunnerSessionArchiveRef;
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 80) || 'context';
}

export function runnerSessionArchiveContextDir(runId: string, contextId: string): string {
  return path.join(runSessionArchiveDir(runId), safeSegment(contextId));
}

export function runnerSessionArchiveRelativeDir(runId: string, contextId: string): string {
  return path.posix.join('session-archives', runId, safeSegment(contextId));
}

function archiveTargets(run: Run): ArchiveTarget[] {
  const fromContexts = getAgentContexts(run)
    .filter((ctx): ctx is AgentContext & { runnerSessionPath: string } =>
      Boolean(ctx.runnerSessionPath?.trim()),
    )
    .map((ctx) => ({
      contextId: ctx.id,
      role: ctx.role,
      runner: ctx.runner ?? run.metrics.runner ?? '',
      runnerSessionId: ctx.runnerSessionId,
      runnerSessionPath: ctx.runnerSessionPath,
      existing: ctx.runnerSessionArchive,
    }));
  if (fromContexts.length > 0) return fromContexts;

  const pathValue = run.metrics.runnerSessionPath?.trim();
  if (!pathValue || !run.metrics.runner) return [];
  const role = primaryRoleForFlow(run.flowType);
  return [
    {
      contextId: contextIdFor(role),
      role,
      runner: run.metrics.runner,
      runnerSessionId: run.metrics.runnerSessionId,
      runnerSessionPath: pathValue,
      existing: run.metrics.runnerSessionArchive,
    },
  ];
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

async function confinedArchiveTranscript(runId: string, contextId: string): Promise<string | null> {
  const root = runSessionArchiveDir(runId);
  const filePath = path.join(
    runnerSessionArchiveContextDir(runId, contextId),
    SESSION_ARCHIVE_TRANSCRIPT,
  );
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

async function copyJsonlArchive(params: {
  vars: SlotLocality;
  runId: string;
  target: ArchiveTarget;
}): Promise<RunnerSessionArchiveRef> {
  const kind = runnerSessionArchiveKind(params.target.runner);
  if (kind === 'none') {
    return {
      status: 'unsupported',
      runner: params.target.runner,
      originalPath: params.target.runnerSessionPath,
      reason: `${params.target.runner || 'runner'} does not archive session transcripts.`,
    };
  }

  const sourcePath = runnerHistorySessionFilePath(
    params.target.runnerSessionPath,
    params.target.runner,
  );
  const exists = await slotFileExists(params.vars, sourcePath);
  if (!exists) {
    return {
      status: 'missing',
      kind,
      runner: params.target.runner,
      originalPath: sourcePath,
      reason: 'Runner transcript file is not available on disk.',
    };
  }

  const stat = await slotStat(params.vars, sourcePath);
  if (!stat.isFile) {
    return {
      status: 'missing',
      kind,
      runner: params.target.runner,
      originalPath: sourcePath,
      reason: 'Runner transcript path is not a file.',
    };
  }
  if (stat.size > SESSION_ARCHIVE_MAX_BYTES) {
    return {
      status: 'missing',
      kind,
      runner: params.target.runner,
      originalPath: sourcePath,
      sizeBytes: stat.size,
      reason: `Runner transcript is larger than ${SESSION_ARCHIVE_MAX_BYTES} bytes.`,
    };
  }

  const destDir = runnerSessionArchiveContextDir(params.runId, params.target.contextId);
  const destFile = path.join(destDir, SESSION_ARCHIVE_TRANSCRIPT);
  await mkdir(destDir, { recursive: true });
  try {
    await slotCopyFile(params.vars, sourcePath, destFile, {
      label: 'runner-session-archive',
      phase: 'download',
      runId: params.runId,
    });
    const bytes = await readFile(destFile);
    if (bytes.byteLength > SESSION_ARCHIVE_MAX_BYTES) {
      await rm(destDir, { recursive: true, force: true });
      return {
        status: 'missing',
        kind,
        runner: params.target.runner,
        originalPath: sourcePath,
        sizeBytes: bytes.byteLength,
        reason: `Runner transcript is larger than ${SESSION_ARCHIVE_MAX_BYTES} bytes.`,
      };
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const capturedAt = new Date().toISOString();
    const ref: RunnerSessionArchiveRef = {
      status: 'captured',
      kind,
      runner: params.target.runner,
      originalPath: sourcePath,
      relativeDir: runnerSessionArchiveRelativeDir(params.runId, params.target.contextId),
      sha256,
      sizeBytes: bytes.byteLength,
      capturedAt,
    };
    await writeFile(
      path.join(destDir, SESSION_ARCHIVE_MANIFEST),
      `${JSON.stringify(
        {
          version: 1,
          ...ref,
          contextId: params.target.contextId,
          role: params.target.role,
          runnerSessionId: params.target.runnerSessionId ?? null,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    return ref;
  } catch (err) {
    await rm(destDir, { recursive: true, force: true });
    return {
      status: 'missing',
      kind,
      runner: params.target.runner,
      originalPath: sourcePath,
      reason: err instanceof Error ? err.message : String(err),
    };
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

  const targets = archiveTargets(run);
  const refs = new Map<string, RunnerSessionArchiveRef>();
  let captured = 0;
  let missing = 0;
  let skipped = 0;
  let attempted = 0;

  for (const target of targets) {
    if (target.existing?.status === 'captured') {
      refs.set(target.contextId, target.existing);
      skipped += 1;
      continue;
    }
    attempted += 1;
    const ref = await copyJsonlArchive({ vars: params.vars, runId: params.runId, target });
    refs.set(target.contextId, ref);
    if (ref.status === 'captured') captured += 1;
    else if (ref.status === 'missing') missing += 1;
    else skipped += 1;
  }

  if (refs.size > 0 && getAgentContexts(run).length > 0) {
    updateRunAgentContexts(params.runId, (_current, contexts) =>
      contexts.map((ctx) => {
        const ref = refs.get(ctx.id);
        return ref ? { ...ctx, runnerSessionArchive: ref } : ctx;
      }),
    );
  }

  const updated = getRun(params.runId) ?? run;
  const primary = selectAgentContext(updated);
  const primaryRef =
    (primary ? refs.get(primary.id) : undefined) ??
    [...refs.values()].find((ref) => ref.status === 'captured') ??
    [...refs.values()][0];
  if (primaryRef) {
    updateRun(params.runId, {
      metrics: { ...updated.metrics, runnerSessionArchive: primaryRef },
    });
  }

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
  const filePath = await confinedArchiveTranscript(params.run.id, contextId);
  if (!filePath) return null;
  const raw = await readFile(filePath, 'utf8');
  const { lines, truncated } = tailJsonl(raw);
  return {
    lines,
    originalPath: ref.originalPath,
    size: Buffer.byteLength(raw),
    relativeDir: runnerSessionArchiveRelativeDir(params.run.id, contextId),
    truncated,
  };
}
