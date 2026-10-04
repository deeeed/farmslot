import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { latestTaskDir } from '@farmslot/agent-runtime';
import {
  ensureRuntimeDirectory,
  OperationRecord,
  processIdentity,
  readOperations,
} from '@farmslot/recipe-runner/runtime/operation';

import { harnessHost, hostEnvName } from './host.js';
import { recipeRuntimeDir } from './paths.js';

export const COMMAND_JOURNAL_FILE = 'last-command.json';

const SENSITIVE_KEY =
  /(?:api[-_]?key|auth|credential|mnemonic|pass(?:word)?|private[-_]?key|secret|seed|srp|token|vault)/iu;
// Do not infer secrets from value shape: 64 hex characters may be a transaction
// hash, and mnemonic-length prose may be legitimate CLI evidence.
const EVIDENCE_OPTIONS = new Set(['--artifacts-dir', '--out', '--output']);

export interface CommandJournalRecord {
  schemaVersion: 1;
  command: string;
  args: string[];
  target: string;
  verdict: 'running' | 'pass' | 'fail';
  exitCode: number | null;
  evidencePaths: string[];
  startedAt: string;
  finishedAt: string | null;
}

interface CommandJournalHandle {
  file: string;
  record: CommandJournalRecord;
  operation: OperationRecord;
}

let activeCommandJournal: CommandJournalHandle | undefined;

export async function withCommandJournal(
  command: string,
  argv: readonly string[],
  execute: () => Promise<number>,
): Promise<number> {
  // Persist commands whose side effects or proof work should not be guessed or repeated after interruption.
  if (!harnessHost().journaledCommands.includes(command)) return execute();
  const operationEnv = hostEnvName('OPERATION_ID');
  const handle = tryBeginCommandJournal(command, argv);
  const previous = activeCommandJournal;
  const parentId = process.env[operationEnv];
  if (handle) process.env[operationEnv] = handle.operation.value.id;
  activeCommandJournal = handle;
  try {
    const exitCode = await execute();
    tryFinishCommandJournal(handle, exitCode);
    return exitCode;
  } catch (error) {
    tryFinishCommandJournal(handle, 1);
    throw error;
  } finally {
    activeCommandJournal = previous;
    if (parentId) process.env[operationEnv] = parentId;
    else delete process.env[operationEnv];
  }
}

export function recordCommandStage(stage: string): void {
  activeCommandJournal?.operation.stage(stage);
}

export function recordCommandOutput(chunk: string | Uint8Array): void {
  activeCommandJournal?.operation.output(chunk);
}

export function recordCommandEvidence(...evidence: string[]): void {
  const handle = activeCommandJournal;
  if (!handle || evidence.length === 0) return;
  try {
    const paths = new Set(handle.record.evidencePaths);
    for (const entry of evidence) paths.add(path.resolve(entry));
    handle.record = { ...handle.record, evidencePaths: [...paths] };
    writeAtomic(handle.file, handle.record);
  } catch (error) {
    process.stderr.write(
      `${harnessHost().name}: resumability journal could not record evidence: ${errorMessage(error)}\n`,
    );
  }
}

export function commandJournalPath(target: string, runtimeDir?: string): string {
  const relative = runtimeDir ?? recipeRuntimeDir();
  assertRelativeRuntimeDir(relative);
  return path.join(path.resolve(target), relative, COMMAND_JOURNAL_FILE);
}

export function readCommandJournal(
  target: string,
  runtimeDir?: string,
): {
  file: string;
  record: CommandJournalRecord | null;
} {
  const legacyFile = commandJournalPath(target, runtimeDir);
  const operations = readOperations(path.join(path.dirname(legacyFile), 'operations'));
  const live = operations.filter(
    (operation) =>
      operation.status === 'running' &&
      processIdentity(operation.pid) === operation.processStartedAt,
  );
  const roots = operations
    .filter((operation) => !operation.parentId)
    .sort((a, b) => (a.finishedAt ?? a.startedAt).localeCompare(b.finishedAt ?? b.startedAt));
  const selected =
    live.find((operation) => !operation.parentId) ??
    live.at(-1) ??
    roots.at(-1) ??
    operations.at(-1);
  const file = selected
    ? path.join(path.dirname(legacyFile), 'operations', `${selected.id}.journal.json`)
    : legacyFile;
  let descriptor: number | undefined;
  try {
    // O_NOFOLLOW blocks symlinks where supported; matching the opened file's
    // identity closes the fallback race, and missing identity fails closed.
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
    const pathStat = fs.lstatSync(file, { bigint: true });
    if (
      !descriptorStat.isFile() ||
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      (pathStat.dev === 0n && pathStat.ino === 0n) ||
      descriptorStat.dev !== pathStat.dev ||
      descriptorStat.ino !== pathStat.ino
    ) {
      return { file, record: null };
    }
    const parsed = JSON.parse(fs.readFileSync(descriptor, 'utf8')) as CommandJournalRecord;
    return isCommandJournalRecord(parsed) ? { file, record: parsed } : { file, record: null };
  } catch {
    return { file, record: null };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function redactCommandArgs(argv: readonly string[]): string[] {
  // Redact the complete invocation, including payloads after `--`; the journal must never preserve secrets.
  const redacted: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const equals = token.indexOf('=');
    if (token.startsWith('--') && equals !== -1) {
      const option = token.slice(0, equals);
      const value = token.slice(equals + 1);
      redacted.push(
        `${option}=${option === '--arg' ? redactAssignment(value) : SENSITIVE_KEY.test(option) ? '<redacted>' : redactUrl(value)}`,
      );
      continue;
    }
    if (token.startsWith('--') && SENSITIVE_KEY.test(token)) {
      redacted.push(token);
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('--')) {
        redacted.push('<redacted>');
        index += 1;
      }
      continue;
    }
    if (token === '--arg') {
      redacted.push(token);
      const value = argv[index + 1];
      if (value !== undefined) {
        redacted.push(redactAssignment(value));
        index += 1;
      }
      continue;
    }
    redacted.push(redactAssignment(redactUrl(token)));
  }
  return redacted;
}

// Bound standalone history; task-local mirrors remain with their task artifacts.
function pruneCompletedJournals(
  directory: string,
  operations: ReturnType<typeof readOperations>,
): void {
  const completed = operations.filter((operation) => operation.status !== 'running');
  for (const operation of completed.slice(0, -100)) {
    for (const suffix of ['.json', '.journal.json', '.log']) {
      fs.rmSync(path.join(directory, `${operation.id}${suffix}`), { force: true });
    }
  }
}

function tryBeginCommandJournal(
  command: string,
  argv: readonly string[],
): CommandJournalHandle | undefined {
  try {
    const target = invocationTarget(argv);
    if (!fs.existsSync(target)) return undefined;
    const runtimeDir = optionValue(argv, '--runtime-dir');
    const legacyFile = commandJournalPath(target, runtimeDir);
    const taskDir = latestTaskDir(path.join(target, 'temp', 'tasks'));
    const signalFile = taskDir && path.join(taskDir, 'SIGNAL.json');
    const liveTask =
      signalFile &&
      fs.existsSync(signalFile) &&
      JSON.parse(fs.readFileSync(signalFile, 'utf8')).status === 'running';
    const directory = path.join(path.dirname(legacyFile), 'operations');
    const operations = readOperations(directory, (error) =>
      process.stderr.write(
        `${harnessHost().name}: ignoring invalid prior operation: ${error.message}\n`,
      ),
    );
    pruneCompletedJournals(directory, operations);
    const inherited = process.env[hostEnvName('OPERATION_ID')];
    const parent =
      inherited &&
      operations.find(
        (operation) =>
          operation.id === inherited &&
          operation.target === target &&
          operation.status === 'running' &&
          processIdentity(operation.pid) === operation.processStartedAt,
      );
    const operation = new OperationRecord(directory, command, target, {
      ...(parent ? { parentId: parent.id } : {}),
      ...(liveTask ? { mirrorDirectory: path.join(taskDir!, 'artifacts', 'operations') } : {}),
    });
    const file = path.join(directory, `${operation.value.id}.journal.json`);
    const now = new Date().toISOString();
    const record: CommandJournalRecord = {
      schemaVersion: 1,
      command,
      args: redactCommandArgs(argv.slice(1)),
      target,
      verdict: 'running',
      exitCode: null,
      evidencePaths: evidencePaths(argv),
      startedAt: now,
      finishedAt: null,
    };
    writeAtomic(file, record);
    return { file, record, operation };
  } catch (error) {
    process.stderr.write(
      `${harnessHost().name}: resumability journal unavailable: ${errorMessage(error)}\n`,
    );
    return undefined;
  }
}

function tryFinishCommandJournal(handle: CommandJournalHandle | undefined, exitCode: number): void {
  if (!handle) return;
  try {
    writeAtomic(handle.file, {
      ...handle.record,
      verdict: exitCode === 0 ? 'pass' : 'fail',
      exitCode,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    process.stderr.write(
      `${harnessHost().name}: resumability journal could not finalize: ${errorMessage(error)}\n`,
    );
  } finally {
    handle.operation.finish(exitCode);
  }
}

function writeAtomic(file: string, record: CommandJournalRecord): void {
  ensureRuntimeDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function invocationTarget(argv: readonly string[]): string {
  const target = path.resolve(optionValue(argv, '--target') ?? process.cwd());
  return fs.existsSync(target) ? fs.realpathSync(target) : target;
}

function evidencePaths(argv: readonly string[]): string[] {
  const values = new Set<string>();
  for (const option of EVIDENCE_OPTIONS) {
    const value = optionValue(argv, option);
    if (value) values.add(path.resolve(value));
  }
  return [...values];
}

function optionValue(argv: readonly string[], option: string): string | undefined {
  const divider = argv.indexOf('--');
  const end = divider === -1 ? argv.length : divider;
  for (let index = 1; index < end; index += 1) {
    const token = argv[index] ?? '';
    if (token === option) {
      const value = argv[index + 1];
      return value && !value.startsWith('--') ? value : undefined;
    }
    if (token.startsWith(`${option}=`)) return token.slice(option.length + 1);
  }
  return undefined;
}

function redactAssignment(token: string): string {
  const equals = token.indexOf('=');
  if (equals <= 0) return redactValue(token);
  const key = token.slice(0, equals);
  const value = token.slice(equals + 1);
  return `${key}=${SENSITIVE_KEY.test(key) ? '<redacted>' : redactValue(value)}`;
}

function redactUrl(token: string): string {
  return token.replace(/(\w+:\/\/)[^/@\s:]+:[^/@\s]+@/gu, '$1<redacted>@');
}

function redactValue(value: string): string {
  try {
    return JSON.stringify(redactStructuredValue(JSON.parse(value)));
  } catch {
    return value.replace(
      /((?:api[-_]?key|auth|credential|mnemonic|pass(?:word)?|private[-_]?key|secret|seed|srp|token|vault)=)[^\s]+/giu,
      '$1<redacted>',
    );
  }
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redactStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructuredValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveKey(key) ? '<redacted>' : redactStructuredValue(entry),
    ]),
  );
}

function assertRelativeRuntimeDir(value: string): void {
  if (!value || path.isAbsolute(value) || !/^[A-Za-z0-9._/-]+$/u.test(value)) {
    throw new Error(`--runtime-dir must be a safe relative path: ${value}`);
  }
  if (value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`--runtime-dir contains an unsafe path component: ${value}`);
  }
}

function isCommandJournalRecord(value: unknown): value is CommandJournalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<CommandJournalRecord>;
  return (
    record.schemaVersion === 1 &&
    typeof record.command === 'string' &&
    Array.isArray(record.args) &&
    record.args.every((entry) => typeof entry === 'string') &&
    typeof record.target === 'string' &&
    (record.verdict === 'running' || record.verdict === 'pass' || record.verdict === 'fail') &&
    (record.exitCode === null || typeof record.exitCode === 'number') &&
    Array.isArray(record.evidencePaths) &&
    record.evidencePaths.every((entry) => typeof entry === 'string') &&
    typeof record.startedAt === 'string' &&
    (record.finishedAt === null || typeof record.finishedAt === 'string')
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
