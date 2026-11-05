import type { NativeWorkerSessionBinding } from '@farmslot/protocol';

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
  /** Explicit pool node for terminal sessions, which have no native host binding. */
  executionNodeId?: string;
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

// Runs on the execution host. Transcript bodies never cross the RPC.
export const NATIVE_SESSION_USAGE_PROGRAM =
  SESSION_USAGE_MODULE +
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
  if (!binding?.stateDirectory) return fallback;
  const journal = path.resolve(binding.stateDirectory, '../../..', 'sessions', binding.sessionId + '.journal');
  let stream;
  try { stream = createReadStream(journal); await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); }); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let context;
  let matched;
  try {
    for await (const line of lines) {
      const entry = record(line, 'Native journal');
      context = entry.context || context;
      if (entry.info && entry.info.nativeSessionId === request.runnerSessionId) {
        const info = entry.info;
        if (info.id !== binding.sessionId || info.ownerPrincipalId !== binding.ownerPrincipalId || info.executionNodeId !== binding.executionNodeId || info.runner !== request.runner)
          throw Error('Native accounting session identity does not match its owner/node');
        matched = { ...context, cwd: info.cwd };
      }
    }
  } finally { lines.close(); stream.destroy(); }
  if (!matched) throw Error('Native journal does not bind the recorded conversation');
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
async function locate(request) {
  if (request.sessionPath) {
    try {
      const file = await realpath(request.sessionPath);
      await verifyConversation(file, request);
      return file;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const context = await contextFor(request);
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
  try {
    const file = await locate(request);
    const key = request.provider + ':' + request.runnerSessionId + ':' + file;
    let output = measured.get(key);
    if (!output) {
      output = await runSessionUsage({ repo: '', slotId: request.slotId, action: 'total', forcedPath: file, forcedRunner: request.runner });
      measured.set(key, output);
    }
    results.push({ key: request.key, runnerSessionId: request.runnerSessionId, sessionPath: file, output });
  } catch (error) { results.push({ key: request.key, runnerSessionId: request.runnerSessionId, error: error.message }); }
}
process.stdout.write(JSON.stringify(results));
`;

export function nativeSessionUsageArgv(
  requests: NativeSessionUsageRequest[],
  modulePath?: string,
): string[] {
  return [
    'node',
    '--experimental-strip-types',
    '--experimental-sqlite',
    '--input-type=module',
    '-e',
    NATIVE_SESSION_USAGE_PROGRAM,
    JSON.stringify(requests),
    modulePath ?? '',
  ];
}

/** Forced-path worker accounting needs neither an operator checkout nor a node-local pool. */
export function forcedSessionUsageArgv(
  slotId: string,
  runner: string | null | undefined,
  sessionPath: string,
  modulePath?: string,
): string[] {
  const program =
    SESSION_USAGE_MODULE +
    String.raw`
const input = JSON.parse(process.argv[1]);
try {
  process.stdout.write(await runSessionUsage({ repo: '', slotId: input.slotId, action: 'total', forcedPath: input.sessionPath, forcedRunner: input.runner }));
} catch (error) {
  process.stderr.write(error instanceof SyntaxError ? 'Session accounting source contains invalid structured data' : error instanceof Error ? error.message : 'Session accounting failed');
  process.exitCode = 1;
}
`;
  return [
    'node',
    '--experimental-strip-types',
    '--experimental-sqlite',
    '--input-type=module',
    '-e',
    program,
    JSON.stringify({ slotId, runner, sessionPath }),
    modulePath ?? '',
  ];
}
