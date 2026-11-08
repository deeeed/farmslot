import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';

import {
  type NativeSessionEvent,
  type NativeWorkerSessionBinding,
  type ProcessActivitySource,
  type ProcessCommit,
  type ProcessCoverage,
  type ProcessMarkCall,
  type ProcessProductEdit,
} from '@farmslot/protocol';

import {
  nativeProcessEvents,
  type ProcessHistoryFormat,
  processTaskPromptBoundary,
  projectProcessHistory,
} from './process-history.js';
import { markerChangeSignature, projectProcessTools } from './process-tools.js';
import { NativeWorkerHistory } from './worker-history.js';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_EVENTS = 4000;
const FULL_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface ProcessCaptureRequest {
  contextId: string;
  executionNodeId: string;
  repo: string;
  taskDir: string;
  excludedRoots: string[];
  baseSha?: string;
  /** A retained source can name an immutable head without consulting a recycled checkout's HEAD. */
  headSha?: string;
  verifiedMarkerShas: string[];
  format?: ProcessHistoryFormat;
  sessionId?: string;
  sessionPath?: string;
  /** Verified provider-clock acceptance, not Gateway attemptStartedAt. */
  startAtMs?: number;
  allowInitialTaskPrompt?: boolean;
  endAtMs: number;
  nativeSession?: NativeWorkerSessionBinding;
}

export interface ProcessCaptureResult {
  schemaVersion: 1;
  contextId: string;
  capturedAt: string;
  sources: ProcessActivitySource[];
  commits: ProcessCommit[] | null;
  productPaths: string[] | null;
  edits: ProcessProductEdit[] | null;
  markCalls: ProcessMarkCall[] | null;
  gitCoverage: ProcessCoverage;
  historyCoverage: ProcessCoverage;
  uncertainWrites: boolean;
  uncertainMarks: boolean;
}

interface SourceFrame {
  lines: string[];
  bytes: number;
  sha256: string;
  identity: string;
  incomplete: boolean;
}

function monotone(times: Iterable<string>): boolean {
  let previous = -Infinity;
  for (const value of times) {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) continue;
    if (at < previous) return false;
    previous = at;
  }
  return true;
}

/** Read a bounded immutable prefix. Unlike recovery, this never repairs a journal tail. */
async function sourceFrame(file: string): Promise<SourceFrame> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('SOURCE_SIZE');
    if (process.getuid && stat.uid !== process.getuid())
      throw new Error('SOURCE_OWNER_UNAVAILABLE');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('SOURCE_CHANGED');
      offset += read.bytesRead;
    }
    const end = bytes.lastIndexOf(10) + 1;
    const prefix = bytes.subarray(0, end);
    return {
      lines: prefix.toString().split('\n').slice(0, -1),
      bytes: end,
      sha256: createHash('sha256').update(prefix).digest('hex'),
      identity: `${stat.dev}:${stat.ino}`,
      incomplete: end !== bytes.length,
    };
  } finally {
    await handle.close();
  }
}

function source(
  request: ProcessCaptureRequest,
  id: string,
  kind: ProcessActivitySource['kind'],
): ProcessActivitySource {
  return {
    id,
    kind,
    contextId: request.contextId,
    executionNodeId: request.executionNodeId,
    clockId: `node:${request.executionNodeId}`,
  };
}

function sourceError(error: unknown): ProcessCoverage {
  // Structured source bodies and filesystem paths must not leak through JSON parser diagnostics.
  const code =
    error instanceof SyntaxError
      ? 'INVALID_STRUCTURED_SOURCE'
      : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : 'SOURCE_UNAVAILABLE';
  return { status: 'unavailable', reason: code };
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function gitSnapshot(request: ProcessCaptureRequest) {
  if (!request.baseSha || !FULL_SHA.test(request.baseSha)) throw new Error('GIT_BASE_UNAVAILABLE');
  const git = (args: string[]) =>
    execFileSync(
      'git',
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', request.repo, ...args],
      { encoding: 'utf8', timeout: 15000, maxBuffer: MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  const head = request.headSha ?? git(['rev-parse', 'HEAD']).trim();
  if (!FULL_SHA.test(head)) throw new Error('GIT_HEAD_UNAVAILABLE');
  const raw = git([
    'log',
    '--reverse',
    '--topo-order',
    '--max-count=257',
    '--format=%x00%H%x00%P%x00%aI%x00%cI%x00',
    '-p',
    '--unified=0',
    '--no-ext-diff',
    '--no-renames',
    `${request.baseSha}..${head}`,
  ]).split('\0');
  const entries: Array<{ commit: ProcessCommit; patch: string }> = [];
  for (let index = 1; index + 4 < raw.length; index += 5) {
    const [sha, parents, authoredAt, committedAt, patch] = raw.slice(index, index + 5);
    if (
      !FULL_SHA.test(sha) ||
      !Number.isFinite(Date.parse(authoredAt)) ||
      !Number.isFinite(Date.parse(committedAt))
    )
      throw new Error('GIT_METADATA_INVALID');
    entries.push({
      commit: {
        sha,
        parents: parents.split(' ').filter(Boolean),
        authoredAt,
        committedAt,
        kind: request.verifiedMarkerShas.includes(sha) ? 'debug-marker' : 'other',
        source: { sourceId: 'git' },
      },
      patch,
    });
  }
  const markerSignatures = entries
    .filter((entry) => entry.commit.kind === 'debug-marker')
    .map((entry) => markerChangeSignature(entry.patch))
    .filter((value): value is string => Boolean(value));
  for (const entry of entries) {
    const removed = markerChangeSignature(entry.patch, '-');
    if (removed && markerSignatures.includes(removed)) entry.commit.kind = 'marker-removal';
  }
  const pending = (
    request.headSha ? '' : git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  )
    .split('\0')
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3));
  const files = [
    ...new Set([
      ...git([
        'diff',
        '--name-only',
        '-z',
        request.baseSha,
        ...(request.headSha ? [request.headSha] : []),
        '--',
      ])
        .split('\0')
        .filter(Boolean),
      ...pending,
    ]),
  ].filter(
    (file) => !request.excludedRoots.some((root) => inside(root, path.resolve(request.repo, file))),
  );
  const changed = !request.headSha && git(['rev-parse', 'HEAD']).trim() !== head;
  return {
    head,
    commits: entries.slice(0, 256).map((entry) => entry.commit),
    markerSignatures,
    files,
    partial: entries.length > 256 || changed,
  };
}

function verifyConversation(
  format: ProcessHistoryFormat,
  frame: SourceFrame,
  file: string,
  expected: string,
): void {
  for (const line of frame.lines.slice(0, 64)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const id =
      format === 'pi-jsonl'
        ? row.type === 'session'
          ? row.id
          : undefined
        : format === 'codex-jsonl'
          ? row.type === 'session_meta'
            ? row.payload?.id
            : undefined
          : row.sessionId;
    if (typeof id !== 'string') continue;
    // Legacy Pi bindings record its timestamped filename; the native UUID remains in that exact filename.
    const stem = path.basename(file, '.jsonl');
    if (id !== expected && !(format === 'pi-jsonl' && expected === stem && stem.endsWith(`_${id}`)))
      throw new Error('CONVERSATION_MISMATCH');
    return;
  }
  throw new Error('CONVERSATION_UNVERIFIED');
}

async function readHistory(request: ProcessCaptureRequest) {
  const binding = request.nativeSession;
  if (!binding) {
    if (!request.sessionPath || !request.sessionId || !request.format)
      throw new Error('TRANSCRIPT_BINDING_UNAVAILABLE');
    const frame = await sourceFrame(request.sessionPath);
    verifyConversation(request.format, frame, request.sessionPath, request.sessionId);
    const initial =
      request.startAtMs === undefined && request.allowInitialTaskPrompt
        ? processTaskPromptBoundary(request.format, frame.lines, request.repo, request.taskDir)
        : undefined;
    const startAt = request.startAtMs ?? initial?.at;
    if (startAt === undefined || !Number.isFinite(startAt))
      throw new Error('ATTEMPT_PROVIDER_BOUNDARY_UNAVAILABLE');
    if (startAt > request.endAtMs) throw new Error('ATTEMPT_TIME_WINDOW_INVALID');
    const offset = initial?.line ?? 0;
    const projection = projectProcessHistory(
      request.format,
      frame.lines.slice(offset),
      'history',
      startAt,
      request.endAtMs,
      offset,
    );
    const coherent = monotone(projection.events.map((event) => event.at));
    return {
      events: projection.events,
      source: {
        ...source(request, 'history', 'transcript'),
        sessionId: request.sessionId,
        path: path.basename(request.sessionPath),
        byteStart: 0,
        byteEnd: frame.bytes,
        fileIdentity: frame.identity,
        sha256: frame.sha256,
        ...(!coherent ? { clockId: null } : {}),
        notBefore: new Date(startAt).toISOString(),
        notAfter: new Date(request.endAtMs).toISOString(),
        ...(initial ? { startLine: initial.line } : {}),
      },
      partial: frame.incomplete || projection.malformed > 0 || !coherent,
    };
  }
  if (
    !binding.stateDirectory ||
    !binding.generation ||
    binding.executionNodeId !== request.executionNodeId
  )
    throw new Error('NATIVE_BINDING_UNAVAILABLE');
  const file = path.resolve(
    binding.stateDirectory,
    '../../..',
    'sessions',
    `${binding.sessionId}.journal`,
  );
  const frame = await sourceFrame(file);
  const history = new NativeWorkerHistory();
  const events: NativeSessionEvent[] = [];
  for (const line of frame.lines) {
    if (!line.trim()) continue;
    // Runtime-owned private journal format. Identity and event ordering are qualified before use.
    const row: Parameters<NativeWorkerHistory['observe']>[0] = JSON.parse(line);
    if (
      row.info &&
      (row.info.id !== binding.sessionId ||
        row.info.ownerPrincipalId !== binding.ownerPrincipalId ||
        row.info.executionNodeId !== binding.executionNodeId)
    )
      throw new Error('NATIVE_IDENTITY_MISMATCH');
    if (row.event) {
      if (
        row.event.sessionId !== binding.sessionId ||
        row.event.sequence !== events.length + 1 ||
        typeof row.event.at !== 'string' ||
        !Number.isFinite(Date.parse(row.event.at))
      )
        throw new Error('NATIVE_EVENT_ORDER_INVALID');
      events.push(row.event);
    }
    history.observe({ info: row.info, event: row.event });
  }
  let after: number | undefined;
  const selected: NativeSessionEvent[] = [];
  const ownedEvents: NativeSessionEvent[] = [];
  let startAfter = 0,
    endAt = 0;
  let otherCommands = false;
  for (;;) {
    const page = history.read(binding.leaseId, events, [], after, 500, binding.generation);
    startAfter = page.scope!.startAfter;
    endAt = page.scope!.endAt;
    selected.push(
      ...page.events.filter(
        (event) => event.commandId === binding.commandId && Date.parse(event.at) <= request.endAtMs,
      ),
    );
    ownedEvents.push(...page.events.filter((event) => event.commandId === binding.commandId));
    if (
      page.events.some(
        (event) =>
          event.commandId &&
          event.commandId !== binding.commandId &&
          Date.parse(event.at) <= request.endAtMs,
      )
    )
      otherCommands = true;
    if (!page.hasMore) break;
    if (page.cursor <= (after ?? 0)) throw new Error('NATIVE_CURSOR_INVALID');
    after = page.cursor;
  }
  const coherent = monotone(ownedEvents.map((event) => event.at));
  return {
    events: nativeProcessEvents(selected, 'history'),
    source: {
      ...source(request, 'history', 'native-events'),
      sessionId: binding.sessionId,
      generation: binding.generation,
      leaseId: binding.leaseId,
      commandId: binding.commandId,
      startAfter,
      endAt,
      byteEnd: frame.bytes,
      fileIdentity: frame.identity,
      sha256: frame.sha256,
      notAfter: new Date(request.endAtMs).toISOString(),
      ...(!coherent ? { clockId: null } : {}),
    },
    partial:
      frame.incomplete ||
      otherCommands ||
      !coherent ||
      !selected.some((event) => event.type === 'command.accepted'),
  };
}

/** Runs on the execution node. Returns compact facts only and never launches or repairs a host. */
export async function captureProcessSources(
  request: ProcessCaptureRequest,
): Promise<ProcessCaptureResult> {
  const result: ProcessCaptureResult = {
    schemaVersion: 1,
    contextId: request.contextId,
    capturedAt: new Date().toISOString(),
    sources: [],
    commits: null,
    productPaths: null,
    edits: null,
    markCalls: null,
    uncertainWrites: true,
    uncertainMarks: true,
    gitCoverage: { status: 'unavailable', reason: 'GIT_NOT_READ' },
    historyCoverage: { status: 'unavailable', reason: 'HISTORY_NOT_READ' },
  };
  let signatures: string[] = [];
  try {
    const git = gitSnapshot(request);
    result.commits = git.commits;
    result.productPaths = git.files;
    signatures = git.markerSignatures;
    result.sources.push({
      ...source(request, 'git', 'git'),
      baseSha: request.baseSha,
      headSha: git.head,
    });
    result.gitCoverage = {
      status: git.partial ? 'partial' : 'complete',
      reason: git.partial ? 'GIT_RANGE_PARTIAL' : 'PINNED_GIT_RANGE',
    };
  } catch (error) {
    result.gitCoverage = sourceError(error);
  }
  try {
    const history = await readHistory(request);
    const tools = projectProcessTools(history.events.slice(0, MAX_EVENTS), {
      repo: request.repo,
      taskDir: request.taskDir,
      productPaths: result.productPaths ?? [],
      markerSignatures: signatures,
    });
    result.sources.push(history.source);
    result.edits =
      result.productPaths === null || (tools.uncertainWrites && !tools.edits.length)
        ? null
        : tools.edits;
    result.markCalls = tools.uncertainMarks && !tools.marks.length ? null : tools.marks;
    result.uncertainWrites = tools.uncertainWrites;
    result.uncertainMarks = tools.uncertainMarks;
    const partial = history.partial || history.events.length > MAX_EVENTS;
    result.historyCoverage = {
      status: partial ? 'partial' : 'complete',
      reason: partial ? 'HISTORY_PARTIAL' : 'VERIFIED_ATTEMPT_WINDOW',
    };
  } catch (error) {
    result.historyCoverage = sourceError(error);
  }
  return result;
}
