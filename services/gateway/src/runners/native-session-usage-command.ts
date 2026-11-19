import type { ChecklistMark } from '@farmslot/agent-runtime/tool-usage';
import type { NativeWorkerSessionBinding } from '@farmslot/protocol';
import type { PiModelCostMetadata, SessionUsageWindow } from '@farmslot/slot-config';

export const REMOTE_USAGE_DETAIL_NOTE = 'Checklist breakdown exceeds the remote receipt limit';

export type NativeSessionUsageIdentity = Pick<
  NativeWorkerSessionBinding,
  'sessionId' | 'ownerPrincipalId' | 'executionNodeId' | 'stateDirectory'
>;

export interface NativeSessionUsageRequest {
  key: string;
  runner: string;
  provider: string;
  runnerSessionId: string;
  cwd: string;
  sessionPath?: string | null;
  slotId: string;
  nativeSession?: NativeSessionUsageIdentity;
  /** Normalized rates only. Provider credentials never enter host command arguments. */
  liteLlmPrices?: Array<[string, PiModelCostMetadata]>;
  /** Explicit pool node for terminal sessions, which have no native host binding. */
  executionNodeId?: string;
  usageWindow?: SessionUsageWindow;
  /** The run attempt's checklist marks, so tool calls split at the same steps. */
  checklistMarks?: ChecklistMark[];
  parentChecklistMarks?: ChecklistMark[];
}

const SESSION_USAGE_MODULE = String.raw`
import { access, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
let modulePath = process.argv[2];
if (!modulePath) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    try {
      const cli = await realpath(path.join(directory, 'farmslot'));
      const entry = createRequire(cli).resolve('@farmslot/slot-config');
      const candidate = path.join(path.dirname(entry), 'session-usage' + path.extname(entry));
      await access(candidate);
      modulePath = candidate;
      break;
    } catch (error) {
      if (!['ENOENT', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error;
    }
  }
}
if (!modulePath) throw Error('Installed CLI accounting module is unavailable');
const { runSessionUsage } = await import(pathToFileURL(modulePath).href);
`;

const RECEIPT_COMPACTION_PROGRAM =
  `const detailNote = ${JSON.stringify(REMOTE_USAGE_DETAIL_NOTE)};\n` +
  String.raw`
function segmentKey(step, at) { return step + ':' + at; }
function mergeSegments(segments, segment, mark) {
  const first = segments[0];
  const last = segments[segments.length - 1];
  const names = new Map();
  for (const hit of segments) {
    for (const [name, count] of Object.entries(hit.toolCallsByName))
      names.set(name, (names.get(name) || 0) + count);
  }
  const sum = (field) => segments.reduce((total, hit) => total + hit[field], 0);
  const nullableSum = (field) => segments.some(hit => hit[field] == null) ? null : sum(field);
  return {
    segment,
    ...(mark ? { stepNumber: mark.stepNumber, title: mark.label, markedAt: mark.checkedAt } : {}),
    startedAt: first.startedAt,
    endedAt: last.endedAt,
    wallMs: Date.parse(last.endedAt) - Date.parse(first.startedAt),
    toolCalls: sum('toolCalls'),
    toolCallsByName: Object.fromEntries(names),
    totalTokens: nullableSum('totalTokens'),
    compactions: nullableSum('compactions'),
    costUsd: nullableSum('costUsd'),
  };
}

function totalsOnly(usage) {
  return {
    ...usage,
    steps: [],
    toolCallsBeforeFirstMark: null,
    stepsUnavailable: detailNote,
  };
}

// Parent boundaries are a subset of the measured child boundaries. Combine
// only intervals we can prove from the receipt and never read the transcript again.
function parentToolUsage(usage, marks, completedAt) {
  const source = usage.steps;
  if (!source.length || !marks?.length) return totalsOnly(usage);
  const parents = [...marks].sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
  const lastMark = source.findLast((step) => step.markedAt)?.markedAt;
  const trailing = source[source.length - 1];
  // A child-only mark may have extended the source interval. Its end is proven
  // by activity beyond that mark or by activity in the zero-length trailing
  // segment at the mark. With neither, keep totals without guessing wall time.
  const trailingActivity = trailing.segment === 'after-last-mark' &&
    (trailing.toolCalls > 0 || trailing.totalTokens > 0 || trailing.compactions > 0);
  const provenEnd = Date.parse(trailing.endedAt) === Date.parse(completedAt);
  if (Date.parse(lastMark) > Date.parse(parents[parents.length - 1].checkedAt) &&
      Date.parse(trailing.endedAt) <= Date.parse(lastMark) && !trailingActivity && !provenEnd)
    return totalsOnly(usage);
  const edges = new Map(source.flatMap((step, index) =>
    step.markedAt ? [[segmentKey(step.stepNumber, step.markedAt), index]] : [],
  ));
  const steps = [];
  let start = 0;
  for (const [order, mark] of parents.entries()) {
    const end = edges.get(segmentKey(mark.stepNumber, mark.checkedAt));
    if (end === undefined && Date.parse(mark.checkedAt) < Date.parse(source[0].startedAt)) continue;
    if (end === undefined || end < start) return totalsOnly(usage);
    steps.push(mergeSegments(source.slice(start, end + 1), order === 0 ? 'before-first-mark' : 'step', mark));
    start = end + 1;
  }
  if (start < source.length) steps.push(mergeSegments(source.slice(start), 'after-last-mark'));
  const first = steps[0];
  return { ...usage, steps, toolCallsBeforeFirstMark: first?.segment === 'before-first-mark' ? first.toolCalls : 0 };
}

function parentMarks(encoded, expanded) {
  return encoded?.map((mark) => typeof mark === 'number' ? expanded[mark] : mark);
}

function compactReceipt(output, marks, completedAt) {
  const lines = output.split('\n');
  const index = lines.findIndex((line) => line.startsWith('tool_usage='));
  if (index === -1) return output;
  const usage = JSON.parse(lines[index].slice('tool_usage='.length));
  lines[index] = 'tool_usage=' + JSON.stringify(parentToolUsage(usage, marks, completedAt));
  if (!lines.includes('receipt_detail_limited=yes')) lines.push('receipt_detail_limited=yes', '');
  return lines.join('\n');
}

function exceedsBudget(output, maxBytes) {
  return Buffer.byteLength(output, 'utf8') > maxBytes;
}
`;

function encodeParentMarks(checklistMarks?: ChecklistMark[], parents?: ChecklistMark[]) {
  if (!parents) return undefined;
  const indexes = new Map(checklistMarks?.map((mark, index) => [JSON.stringify(mark), index]));
  return parents.map((mark) => indexes.get(JSON.stringify(mark)) ?? mark);
}

// Runs on the execution host. Transcript bodies never cross the RPC.
export const NATIVE_SESSION_USAGE_PROGRAM =
  SESSION_USAGE_MODULE +
  RECEIPT_COMPACTION_PROGRAM +
  String.raw`
import { readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
const input = JSON.parse(process.argv[1]);
function record(line, label) {
  try { const value = JSON.parse(line); if (value && typeof value === 'object' && !Array.isArray(value)) return value; }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  throw Error(label + ' contains an invalid structured record');
}
async function contextFor(request) {
  const binding = request.nativeSession;
  const fallback = { home: homedir(), cwd: request.cwd };
  if (!binding?.stateDirectory) {
    if (request.usageWindow?.nativeLeaseIds) throw Error('Native usage journal is unavailable');
    return fallback;
  }
  const journal = path.resolve(binding.stateDirectory, '../../..', 'sessions', binding.sessionId + '.journal');
  let stream;
  try { stream = createReadStream(journal); await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); }); }
  catch (error) { if (error.code === 'ENOENT' && !request.usageWindow?.nativeLeaseIds) return fallback; throw error; }
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let context;
  let matched;
  const commands = new Map();
  const submissions = [];
  let conversation;
  try {
    for await (const line of lines) {
      const entry = record(line, 'Native journal');
      context = entry.context || context;
      conversation = entry.info?.nativeSessionId || conversation;
      for (const command of entry.commands || []) commands.set(command.commandId, command.leaseId);
      if (conversation === request.runnerSessionId && entry.event?.type === 'command.submitted')
        submissions.push(entry.event);
      if (entry.info && entry.info.nativeSessionId === request.runnerSessionId) {
        const info = entry.info;
        if (info.id !== binding.sessionId || info.ownerPrincipalId !== binding.ownerPrincipalId || info.executionNodeId !== binding.executionNodeId || info.runner !== request.runner)
          throw Error('Native accounting session identity does not match its owner/node');
        matched = { ...context, cwd: info.cwd };
      }
    }
  } finally { lines.close(); stream.destroy(); }
  if (!matched) throw Error('Native journal does not bind the recorded conversation');
  if (request.usageWindow?.nativeLeaseIds) {
    const leases = new Set(request.usageWindow.nativeLeaseIds);
    const first = submissions.findIndex(event => leases.has(commands.get(event.commandId)));
    if (first < 0) throw Error('Native usage journal has no submitted command for the recorded task leases');
    const next = submissions.findIndex((event, index) => index > first && !leases.has(commands.get(event.commandId)));
    if (next >= 0 && submissions.slice(next).some(event => leases.has(commands.get(event.commandId))))
      throw Error('Native usage task leases are interleaved with another run');
    const start = Date.parse(submissions[first].at);
    const end = next < 0 ? undefined : Date.parse(submissions[next].at) - 1;
    if (!Number.isFinite(start) || (end !== undefined && (!Number.isFinite(end) || end < start)))
      throw Error('Native usage journal has invalid command timestamps');
    matched.usageWindow = { startedAt: new Date(start).toISOString(), ...(end === undefined ? {} : { completedAt: new Date(end).toISOString() }) };
  }
  return matched;
}
async function verifyConversation(file, request) {
  const stream = createReadStream(file);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let count = 0;
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row = record(line, 'Transcript');
      const id = request.provider === 'codex-jsonl' ? (row.type === 'session_meta' ? row.payload?.id : undefined) : request.provider === 'pi-jsonl' ? (row.type === 'session' ? row.id : undefined) : row.sessionId;
      if (typeof id === 'string') {
        if (id !== request.runnerSessionId) throw Error('Transcript conversation identity mismatch');
        return;
      }
      if (++count >= 64) break;
    }
    throw Error('Transcript has no verifiable conversation identity');
  } finally { lines.close(); stream.destroy(); }
}
async function locate(request, context) {
  if (request.sessionPath) {
    try {
      const file = await realpath(request.sessionPath);
      await verifyConversation(file, request);
      return file;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const home = context.home || homedir();
  if (path.basename(request.runnerSessionId) !== request.runnerSessionId || ['.', '..'].includes(request.runnerSessionId)) throw Error('Invalid recorded conversation id');
  const matches = new Set();
  if (request.provider === 'claude-jsonl') {
    const root = context.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    const repo = context.cwd || request.cwd;
    let canonical = repo;
    try { canonical = await realpath(repo); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const keys = new Set([repo, canonical].flatMap(value => [value.replaceAll('/', '-'), value.replace(/[^a-zA-Z0-9]/g, '-')]));
    for (const key of keys) {
      const file = path.join(root, 'projects', key, request.runnerSessionId + '.jsonl');
      try { matches.add(await realpath(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } else if (request.provider === 'codex-jsonl') {
    const { DatabaseSync } = await import('node:sqlite');
    const root = context.codexHome || (request.nativeSession?.stateDirectory ? path.join(request.nativeSession.stateDirectory, 'codex-home') : process.env.CODEX_HOME || path.join(home, '.codex'));
    for (const file of (await readdir(root)).filter(name => /^state_[0-9]+\.sqlite$/.test(name))) {
      const database = new DatabaseSync(path.join(root, file), { readOnly: true });
      try {
        const row = database.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(request.runnerSessionId);
        if (row && typeof row.rollout_path === 'string') matches.add(await realpath(row.rollout_path));
      } finally { database.close(); }
    }
  } else throw Error('Runner has no native transcript accounting provider');
  if (matches.size !== 1) throw Error(matches.size ? 'Recorded conversation has ambiguous transcript paths' : 'Recorded conversation transcript was not found');
  const file = [...matches][0];
  await verifyConversation(file, request);
  return file;
}
const measured = new Map();
const results = [];
for (const request of input) {
  let usageWindow;
  try {
    const context = await contextFor(request);
    usageWindow = context.usageWindow || request.usageWindow;
    const file = await locate(request, context);
    const key = JSON.stringify([request.provider, request.runnerSessionId, file, request.liteLlmPrices, usageWindow, request.checklistMarks]);
    let output = measured.get(key);
    if (!output) {
      output = await runSessionUsage({ repo: '', slotId: request.slotId, action: 'total', forcedPath: file, forcedRunner: request.runner, usageWindow, checklistMarks: request.checklistMarks, ...(request.liteLlmPrices ? { liteLlmPrices: new Map(request.liteLlmPrices) } : {}) });
      if (usageWindow && !output.split('\n').includes('usage_window=' + JSON.stringify(usageWindow)))
        throw Error('Installed accounting module did not apply the requested run usage window');
      measured.set(key, output);
    }
    results.push({ key: request.key, runnerSessionId: request.runnerSessionId, sessionPath: file, output, usageWindow });
  } catch (error) { results.push({ key: request.key, runnerSessionId: request.runnerSessionId, error: error.message, usageWindow }); }
}
const maxBytes = Number(process.argv[3]);
let output = JSON.stringify(results);
if (maxBytes > 0 && exceedsBudget(output, maxBytes)) {
  for (const [index, row] of results.entries()) {
    const request = input[index];
    if (row.output)
      row.output = compactReceipt(row.output, parentMarks(request.parentChecklistMarks, request.checklistMarks), row.usageWindow?.completedAt);
  }
  output = JSON.stringify(results);
  if (exceedsBudget(output, maxBytes)) {
    for (const row of results) if (row.output) row.output = compactReceipt(row.output);
    output = JSON.stringify(results);
  }
  if (exceedsBudget(output, maxBytes)) throw Error('Native session usage totals exceed the subprocess limit');
}
process.stdout.write(output);
`;

export function nativeSessionUsageArgv(
  requests: NativeSessionUsageRequest[],
  modulePath?: string,
  maxBytes?: number,
): string[] {
  const input =
    maxBytes === undefined
      ? requests
      : requests.map((request) => ({
          ...request,
          parentChecklistMarks: encodeParentMarks(
            request.checklistMarks,
            request.parentChecklistMarks,
          ),
        }));
  return [
    'node',
    ...(maxBytes === undefined ? [] : ['--no-warnings']),
    '--experimental-strip-types',
    '--experimental-sqlite',
    '--input-type=module',
    '-e',
    NATIVE_SESSION_USAGE_PROGRAM,
    JSON.stringify(input),
    modulePath ?? '',
    ...(maxBytes === undefined ? [] : [String(maxBytes)]),
  ];
}

/** Forced-path worker accounting needs neither an operator checkout nor a node-local pool. */
export function forcedSessionUsageArgv(
  slotId: string,
  runner: string | null | undefined,
  sessionPath: string,
  modulePath?: string,
  checklistMarks?: ChecklistMark[],
  receiptBudget?: { maxBytes: number; parentChecklistMarks?: ChecklistMark[] },
): string[] {
  // Most parent marks are already in the expanded list. Keep references to
  // those marks so they do not double the remote shell argument on large ledgers.
  const budget = receiptBudget && {
    maxBytes: receiptBudget.maxBytes,
    parentChecklistMarks: encodeParentMarks(checklistMarks, receiptBudget.parentChecklistMarks),
  };
  const program =
    SESSION_USAGE_MODULE +
    RECEIPT_COMPACTION_PROGRAM +
    String.raw`
const input = JSON.parse(process.argv[1]);

try {
  const options = { repo: '', slotId: input.slotId, action: 'total', forcedPath: input.sessionPath, forcedRunner: input.runner, checklistMarks: input.checklistMarks };
  let output = await runSessionUsage(options);
  if (input.receiptBudget && exceedsBudget(output, input.receiptBudget.maxBytes)) {
    const marks = parentMarks(input.receiptBudget.parentChecklistMarks, input.checklistMarks);
    output = compactReceipt(output, marks);
    if (exceedsBudget(output, input.receiptBudget.maxBytes))
      output = compactReceipt(output);
    if (exceedsBudget(output, input.receiptBudget.maxBytes))
      throw Error('Session usage totals exceed the remote transport limit');
  }
  process.stdout.write(output);
} catch (error) {
  process.stderr.write(error instanceof SyntaxError ? 'Session accounting source contains invalid structured data' : error instanceof Error ? error.message : 'Session accounting failed');
  process.exitCode = 1;
}
`;
  return [
    'node',
    // The remote daemon counts stdout and stderr together, including Node 22's
    // experimental type-stripping warning. Measurement errors still reach stderr.
    ...(receiptBudget ? ['--no-warnings'] : []),
    '--experimental-strip-types',
    '--experimental-sqlite',
    '--input-type=module',
    '-e',
    program,
    JSON.stringify({ slotId, runner, sessionPath, checklistMarks, receiptBudget: budget }),
    modulePath ?? '',
  ];
}

/** Existing accounting semantics, evaluated in the selected node's CLI environment. */
export function workspaceSessionUsageArgv(
  input: {
    repo: string;
    slotId: string;
    runner?: string | null;
    sessionPath?: string | null;
  },
  modulePath?: string,
): string[] {
  const program =
    SESSION_USAGE_MODULE +
    String.raw`
const input = JSON.parse(process.argv[1]);
process.stdout.write(await runSessionUsage({ repo: input.repo, slotId: input.slotId, action: 'total',
  ...(input.sessionPath ? { forcedPath: input.sessionPath, forcedRunner: input.runner } : {}) }));
`;
  return [
    'node',
    '--experimental-strip-types',
    '--experimental-sqlite',
    '--input-type=module',
    '-e',
    program,
    JSON.stringify(input),
    modulePath ?? '',
  ];
}
