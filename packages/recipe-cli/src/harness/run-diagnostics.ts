// Run-scoped application diagnostics: what the app logged while a recipe ran
// (from a baseline offset), its in-app issue buffer and request log, grouped,
// redacted and classified by the host's console classifier. Non-blocking: a
// finding marks the run REVIEW, never FAIL.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AdapterBrowser, AdapterLogSource } from '@farmslot/adapter-sdk';
import type { RecipeRunResult } from '@farmslot/recipe-runner';

import { harnessAdapter } from './adapters.js';

const MAX_CAPTURE_BYTES = 512 * 1024;
const MAX_FINDINGS = 20;
const MAX_PREVIEW_CHARS = 320;
const RAW_APP_LOG_ARTIFACT = 'diagnostics-app-log.txt';

// info: a finding the recipe library's console allowlist marks as known
// third-party noise; it is reported but does not make a run REVIEW.
type DiagnosticLevel = 'info' | 'warning' | 'error' | 'exception';

/** One console log record: its first line and the continuation lines after it. */
export interface ConsoleRecord {
  line: string;
  continuation: string[];
}

/** What an allowlist entry is compared with. */
export interface ConsoleEventKey {
  signature: string;
  continuation: string;
  first_frame: string;
}

export interface ClassifiedConsoleRecord {
  level: Exclude<DiagnosticLevel, 'info'>;
  source: string;
  message: string;
  firstFrame: string | null;
  key: ConsoleEventKey;
}

export interface ConsoleAllowlistMatch {
  reason: string;
  // The entry's index in its file.
  index: number;
  file: string;
  temporary?: boolean;
}

/** The least an allowlist reports: its applied entries and the problems found loading it. */
export interface ConsoleAllowlist {
  entries: readonly unknown[];
  problems: string[];
}

/**
 * How a host reads console logs: records, which of them are findings, how a
 * message groups, and the recipe libraries' allowlist of known noise.
 */
export interface ConsoleClassifier<TAllowlist extends ConsoleAllowlist> {
  records(text: string): ConsoleRecord[];
  // The finding a record is, or null for ordinary output.
  classify(record: ConsoleRecord): ClassifiedConsoleRecord | null;
  // A message with run-specific values replaced, for grouping.
  signature(message: string): string;
  loadAllowlist(libraryRoots: readonly string[]): TAllowlist;
  match(
    event: { source: string; key: ConsoleEventKey },
    allowlist: TAllowlist,
  ): ConsoleAllowlistMatch | null;
  // Library roots when the run's summary names none.
  libraryRoots(): string[];
}

/** Conservative defaults: unrecognized nonempty application output needs review. */
export function createDefaultConsoleClassifier(
  libraryRoots: readonly string[],
): ConsoleClassifier<ConsoleAllowlist> {
  return {
    records: (text) =>
      text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => ({ line, continuation: [] })),
    classify(record) {
      let level: unknown;
      try {
        const value: unknown = JSON.parse(record.line);
        if (isRecord(value)) level = value.level ?? value.severity;
      } catch {
        // Non-JSON application output uses the level prefix, if present.
        level = /^\s*\[?(info|debug|trace|warn(?:ing)?|error|exception|fatal)\b/iu.exec(
          record.line,
        )?.[1];
      }
      const severity = typeof level === 'string' ? level.toLowerCase() : '';
      if (['info', 'debug', 'trace'].includes(severity)) return null;
      const message = record.line;
      const key = { signature: message, continuation: '', first_frame: '' };
      return {
        level:
          severity === 'exception'
            ? 'exception'
            : ['error', 'fatal'].includes(severity)
              ? 'error'
              : 'warning',
        source: severity ? 'application' : 'unclassified-application-log',
        message,
        firstFrame: null,
        key,
      };
    },
    signature: (message) => message,
    loadAllowlist: () => ({ entries: [], problems: [] }),
    match: () => null,
    libraryRoots: () => [...libraryRoots],
  };
}

export interface RunDiagnosticBaseline {
  source: AdapterLogSource;
  offset: number;
  inode?: number;
  // The platform's in-app issue buffer, armed at the run's start.
  issueBuffer?: { adapter: string; projectRoot: string };
  // The console collector this run's findings depend on.
  capture?: ConsoleCaptureSpec;
  // The platform's request log from the run's start.
  requestLog?: { adapter: string; path: string; offset: number; inode?: number };
}

export interface ConsoleCaptureSpec {
  adapter: string;
  projectRoot: string;
  cdpPort?: string;
  extensionLog: string;
  pageLog: string;
  pidFile: string;
  startError?: string;
}

// Whether the run's console capture was shown to work; without it an empty
// log is not CLEAN.
export interface CaptureEvidence {
  verified: boolean;
  detail: string;
}

export interface RunSideFinding {
  level: DiagnosticLevel;
  fingerprint: string;
  count: number;
  preview: string;
  // Console lines: where the event came from (as the classifier or the
  // platform names it), its message signature (findings group by it) and the
  // first stack frame or URL.
  source?: string;
  signature?: string;
  firstFrame?: string | null;
  allowlisted?: { reason: string; entry: number; file: string; temporary?: true };
}

export interface RunDiagnosticsDocument {
  schemaVersion: 1;
  scope: 'recipe-run-application';
  status: 'clean' | 'review' | 'unavailable';
  nonBlocking: true;
  note: string;
  source: {
    label: string;
    path: string;
    startOffset: number;
    endOffset: number;
    inode?: number;
    bytesRead: number;
    truncated: boolean;
    inAppBuffer: 'collected' | 'unavailable' | 'n/a';
    rawArtifact: string;
    redacted: true;
  };
  counts: {
    total: number;
    warning: number;
    error: number;
    exception: number;
    info?: number;
  };
  allowlist?: { entries: number; applied: number; problems: string[] };
  capture?: CaptureEvidence;
  displayedFindingCount: number;
  omittedFindingCount: number;
  findings: RunSideFinding[];
}

export type RecipeRunEvidence = RecipeRunResult & {
  diagnosticsPath?: string;
  // The browser the run drove, bound to its CDP port during the run.
  browser?: AdapterBrowser | null;
  sideFindings?: Pick<RunDiagnosticsDocument, 'status' | 'note' | 'counts'>;
};

export function readRunDiagnosticsDocument(
  diagnosticsPath: unknown,
): RunDiagnosticsDocument | null {
  if (typeof diagnosticsPath !== 'string' || diagnosticsPath.length === 0) return null;
  try {
    const document = JSON.parse(fs.readFileSync(diagnosticsPath, 'utf8')) as unknown;
    return isRunDiagnosticsDocument(document) ? document : null;
  } catch {
    return null;
  }
}

export function formatRunDiagnosticsForHuman(
  diagnostics: RunDiagnosticsDocument | null,
  adapter: string,
): string[] {
  if (!diagnostics) {
    return [
      harnessAdapter(adapter).headless
        ? `N/A — ${adapter.charAt(0).toUpperCase()}${adapter.slice(1)} is headless and has no application log source.`
        : 'UNAVAILABLE — application diagnostics could not be collected for this run.',
    ];
  }
  const status =
    diagnostics.status === 'clean'
      ? 'CLEAN'
      : diagnostics.status === 'review'
        ? 'REVIEW'
        : 'UNAVAILABLE';
  const lines = [`${status} — ${diagnostics.note}`];
  for (const finding of diagnostics.findings) {
    const count = finding.count > 1 ? ` ×${finding.count}` : '';
    const source = finding.source ? ` [${finding.source}]` : '';
    const allowed = finding.allowlisted ? ` (allowlisted: ${finding.allowlisted.reason})` : '';
    lines.push(`${finding.level.toUpperCase()}${count}${source} — ${finding.preview}${allowed}`);
  }
  return lines;
}

export async function beginRunDiagnostics(
  adapter: string,
  projectRoot: string,
): Promise<RunDiagnosticBaseline | null> {
  const surface = harnessAdapter(adapter);
  const source = surface.appLogSource(projectRoot);
  if (!source) return null;
  const diagnostics = surface.diagnostics;
  const issueBuffer = diagnostics?.issueBuffer?.arm(projectRoot)
    ? { adapter, projectRoot }
    : undefined;
  let capture: ConsoleCaptureSpec | undefined;
  if (diagnostics?.console) {
    const collector = diagnostics.console;
    const startError = await collector.start(projectRoot).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const { extensionLog, pageLog, pidFile } = collector.files(projectRoot);
    const cdpPort = collector.cdpPort();
    capture = {
      adapter,
      projectRoot,
      extensionLog,
      pageLog,
      pidFile,
      ...(cdpPort ? { cdpPort } : {}),
      ...(startError ? { startError } : {}),
    };
  }
  const requestLogPath = diagnostics?.requestLog?.path(projectRoot) ?? null;
  const requestStat = requestLogPath ? safeStat(requestLogPath) : null;
  const stat = safeStat(source.path);
  return {
    source,
    offset: stat?.size ?? 0,
    ...(stat ? { inode: stat.ino } : {}),
    ...(issueBuffer ? { issueBuffer } : {}),
    ...(capture ? { capture } : {}),
    ...(requestLogPath
      ? {
          requestLog: {
            adapter,
            path: requestLogPath,
            offset: requestStat?.size ?? 0,
            ...(requestStat ? { inode: requestStat.ino } : {}),
          },
        }
      : {}),
  };
}

// The collector started on a CDP port, and the platform proves it is still
// the runtime's own and that a control line logged where the run's log comes
// from reaches it.
export async function verifyConsoleCapture(capture: ConsoleCaptureSpec): Promise<CaptureEvidence> {
  if (capture.startError)
    return {
      verified: false,
      detail: `the console collector did not start: ${capture.startError}`,
    };
  if (!capture.cdpPort) return { verified: false, detail: 'no CDP port for the console collector' };
  const control = await harnessAdapter(capture.adapter).diagnostics!.console!.verifyControl({
    projectRoot: capture.projectRoot,
    cdpPort: capture.cdpPort,
    extensionLog: capture.extensionLog,
    pageLog: capture.pageLog,
    pidFile: capture.pidFile,
  });
  return { verified: control.ok, detail: control.detail };
}

function isRunDiagnosticsDocument(value: unknown): value is RunDiagnosticsDocument {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.scope !== 'recipe-run-application')
    return false;
  if (value.status !== 'clean' && value.status !== 'review' && value.status !== 'unavailable')
    return false;
  return typeof value.note === 'string' && Array.isArray(value.findings);
}

export async function finishRunDiagnostics<TAllowlist extends ConsoleAllowlist>(
  baseline: RunDiagnosticBaseline | null,
  result: RecipeRunResult,
  classifier: ConsoleClassifier<TAllowlist>,
): Promise<RecipeRunEvidence> {
  if (!baseline) return result;
  try {
    const bufferedIssues = baseline.issueBuffer
      ? harnessAdapter(baseline.issueBuffer.adapter).diagnostics?.issueBuffer?.collect(
          baseline.issueBuffer.projectRoot,
        )
      : undefined;
    const allowlist = classifier.loadAllowlist(recipeLibraryRoots(result.summaryPath, classifier));
    const capture = baseline.capture ? await verifyConsoleCapture(baseline.capture) : undefined;
    const { diagnostics, rawAppLog } = collectRunDiagnosticsCapture(
      baseline,
      classifier,
      bufferedIssues,
      allowlist,
      capture,
    );
    const artifactsDir = path.dirname(result.summaryPath);
    const diagnosticsPath = path.join(artifactsDir, 'diagnostics.json');
    fs.writeFileSync(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`);
    fs.writeFileSync(
      path.join(artifactsDir, RAW_APP_LOG_ARTIFACT),
      redactDiagnosticText(rawAppLog.toString('utf8')),
    );
    indexDiagnosticArtifact(result.artifactManifestPath);
    indexDiagnosticSummary(result.summaryPath, diagnostics);

    return {
      ...result,
      diagnosticsPath,
      sideFindings: {
        status: diagnostics.status,
        note: diagnostics.note,
        counts: diagnostics.counts,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`WARN: run diagnostics were unavailable: ${detail}`);
    return {
      ...result,
      sideFindings: {
        status: 'unavailable',
        note: 'Run diagnostics could not be collected; the recipe result is unchanged.',
        counts: { total: 0, warning: 0, error: 0, exception: 0 },
      },
    };
  }
}

export function collectRunDiagnostics<TAllowlist extends ConsoleAllowlist>(
  baseline: RunDiagnosticBaseline,
  classifier: ConsoleClassifier<TAllowlist>,
  bufferedIssues?: unknown[] | null,
  allowlist: TAllowlist | null = null,
  capture?: CaptureEvidence,
): RunDiagnosticsDocument {
  return collectRunDiagnosticsCapture(baseline, classifier, bufferedIssues, allowlist, capture)
    .diagnostics;
}

function collectRunDiagnosticsCapture<TAllowlist extends ConsoleAllowlist>(
  baseline: RunDiagnosticBaseline,
  classifier: ConsoleClassifier<TAllowlist>,
  bufferedIssues?: unknown[] | null,
  allowlist: TAllowlist | null = null,
  capture?: CaptureEvidence,
): { diagnostics: RunDiagnosticsDocument; rawAppLog: Buffer } {
  const stat = safeStat(baseline.source.path);
  const source = {
    label: baseline.source.label,
    path: baseline.source.path,
    startOffset: baseline.offset,
    endOffset: stat?.size ?? baseline.offset,
    inode: undefined as number | undefined,
    bytesRead: 0,
    truncated: false,
    inAppBuffer:
      bufferedIssues === undefined
        ? ('n/a' as const)
        : bufferedIssues === null
          ? ('unavailable' as const)
          : ('collected' as const),
    rawArtifact: RAW_APP_LOG_ARTIFACT,
    redacted: true as const,
  };
  let rawAppLog: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  if (stat) {
    const sameFile = baseline.inode === undefined || baseline.inode === stat.ino;
    const startOffset = sameFile && stat.size >= baseline.offset ? baseline.offset : 0;
    const available = Math.max(0, stat.size - startOffset);
    const bytesToRead = Math.min(available, MAX_CAPTURE_BYTES);
    source.startOffset = startOffset;
    source.endOffset = stat.size;
    source.inode = stat.ino;
    source.bytesRead = bytesToRead;
    source.truncated = available > MAX_CAPTURE_BYTES;
    if (bytesToRead > 0) rawAppLog = readSlice(baseline.source.path, startOffset, bytesToRead);
    // A read cut at the size limit ends mid-line: that partial line is not
    // an event of its own.
    if (source.truncated) rawAppLog = rawAppLog.subarray(0, rawAppLog.lastIndexOf(0x0a) + 1);
  }
  const text = rawAppLog.toString('utf8');

  const lineFindings = classifier
    .records(text)
    .map((record) => classifyRecord(record, classifier))
    .filter((finding): finding is PendingFinding => finding !== null);
  applyConsoleAllowlist(lineFindings, classifier, allowlist);
  const allFindings = dedupeFindings([
    ...lineFindings,
    ...(bufferedIssues ?? [])
      .map(classifyBufferedIssue)
      .filter((finding): finding is Omit<RunSideFinding, 'count'> => finding !== null),
    ...(baseline.requestLog ? requestLogFindings(baseline.requestLog) : []),
  ]);
  const applied = allFindings.filter((finding) => finding.level === 'info').length;
  // Findings that need review first, allowlisted noise last.
  allFindings.sort((a, b) => Number(a.level === 'info') - Number(b.level === 'info'));
  const findings = allFindings.slice(0, MAX_FINDINGS).map(stripInternal);
  const counts = countFindings(allFindings);
  const omittedFindingCount = Math.max(0, allFindings.length - findings.length);
  const captureFailed = capture !== undefined && !capture.verified;
  // Only the first MAX_CAPTURE_BYTES of the run's log were read: the rest was
  // never checked, so an empty result is not CLEAN.
  const status =
    counts.total > 0
      ? 'review'
      : !captureFailed &&
          !source.truncated &&
          (stat || (bufferedIssues !== undefined && bufferedIssues !== null))
        ? 'clean'
        : 'unavailable';
  const captureNote =
    (captureFailed ? ` Console capture was not verified: ${capture.detail}.` : '') +
    (source.truncated
      ? ` The run's log exceeded ${MAX_CAPTURE_BYTES} bytes; only its start was checked.`
      : '');
  const note =
    (counts.total > 0
      ? `Observed ${counts.total} distinct application warning/error event(s) during the recipe run; showing ${findings.length} preview(s) and omitting ${omittedFindingCount}. Relation to the task is not determined.`
      : status === 'clean'
        ? 'No application warnings or errors were emitted during the recipe run.'
        : 'Application diagnostics were unavailable for this run.') + captureNote;

  return {
    diagnostics: {
      schemaVersion: 1,
      scope: 'recipe-run-application',
      status,
      nonBlocking: true,
      note,
      source,
      counts,
      ...(allowlist
        ? {
            allowlist: { entries: allowlist.entries.length, applied, problems: allowlist.problems },
          }
        : {}),
      ...(capture ? { capture } : {}),
      displayedFindingCount: findings.length,
      omittedFindingCount,
      findings,
    },
    rawAppLog,
  };
}

type PendingFinding = Omit<RunSideFinding, 'count'> & { event?: ConsoleEventKey };

function classifyRecord(
  record: ConsoleRecord,
  classifier: Pick<ConsoleClassifier<ConsoleAllowlist>, 'classify' | 'signature'>,
): PendingFinding | null {
  const classified = classifier.classify(record);
  if (!classified) return null;
  const line = record.line;
  // Grouped by the redacted signature, so lines that differ only in a secret
  // value or a query string are one finding.
  const signature = classifier.signature(redactDiagnosticText(classified.message));
  return {
    ...makeFinding(classified.level, line.trim(), `${classified.source}|${signature}`),
    source: classified.source,
    signature: redactPreview(signature),
    firstFrame: classified.firstFrame ? redactPreview(classified.firstFrame) : null,
    event: classified.key,
  };
}

// What the platform reads from its request log during the run.
function requestLogFindings(
  requestLog: NonNullable<RunDiagnosticBaseline['requestLog']>,
): PendingFinding[] {
  const reader = harnessAdapter(requestLog.adapter).diagnostics?.requestLog;
  const stat = safeStat(requestLog.path);
  if (!reader || !stat) return [];
  const sameFile = requestLog.inode === undefined || requestLog.inode === stat.ino;
  const start = sameFile && stat.size >= requestLog.offset ? requestLog.offset : 0;
  const lines = readSlice(requestLog.path, start, stat.size - start)
    .toString('utf8')
    .split('\n');
  return reader.findings(lines).map(({ level, source, text }) => ({
    ...makeFinding(level, text, `${source}|${text}`),
    source,
    signature: text,
    firstFrame: null,
  }));
}

function classifyBufferedIssue(value: unknown): Omit<RunSideFinding, 'count'> | null {
  if (!isRecord(value) || typeof value.text !== 'string') return null;
  const rawLevel = String(value.level ?? '').toLowerCase();
  const level =
    rawLevel === 'warn' || rawLevel === 'warning'
      ? 'warning'
      : rawLevel === 'error'
        ? 'error'
        : rawLevel === 'exception'
          ? 'exception'
          : null;
  return level ? makeFinding(level, value.text) : null;
}

function makeFinding(
  level: DiagnosticLevel,
  text: string,
  groupKey?: string,
): Omit<RunSideFinding, 'count'> {
  const preview = redactPreview(text.trim());
  const identity =
    groupKey ??
    preview
      .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\b/gu, '[TIME]')
      .replace(/\[(?:sw|page:[^\]]+|console:[^\]]+)\]/gu, '[APP]')
      .replace(/^(?:(?:WARN(?:ING)?|ERROR|EXCEPTION|\[TIME\]|\[APP\])\s*)+/u, '');
  return {
    level,
    fingerprint: createHash('sha256').update(`${level}|${identity}`).digest('hex').slice(0, 12),
    preview,
  };
}

// Allowlisted findings become info (known third-party noise, with the
// reason). Decided per event before grouping, so one allowlisted occurrence
// never hides a different one with the same first line.
function applyConsoleAllowlist<TAllowlist extends ConsoleAllowlist>(
  findings: PendingFinding[],
  classifier: ConsoleClassifier<TAllowlist>,
  allowlist: TAllowlist | null,
): void {
  if (!allowlist) return;
  for (const finding of findings) {
    // A classified record always has its event key and source.
    if (!finding.event || finding.source === undefined) continue;
    const match = classifier.match({ source: finding.source, key: finding.event }, allowlist);
    if (!match) continue;
    finding.allowlisted = {
      reason: match.reason,
      entry: match.index,
      file: match.file,
      ...(match.temporary ? { temporary: true as const } : {}),
    };
    finding.level = 'info';
    finding.fingerprint = createHash('sha256')
      .update(`${finding.fingerprint}|info|${match.file}#${match.index}`)
      .digest('hex')
      .slice(0, 12);
  }
}

function redactPreview(value: string): string {
  return redactDiagnosticText(value).slice(0, MAX_PREVIEW_CHARS);
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/\b(Bearer)\s+\S+/giu, '$1 [REDACTED]')
    .replace(
      /(["'])(api[-_]?key|password|passphrase|mnemonic|seed(?:Phrase)?|privateKey|secret|token|authorization|vault)\1\s*:\s*(?:"[^"]*"|'[^']*'|[^,\s}\]]+)/giu,
      '$1$2$1:"[REDACTED]"',
    )
    .replace(
      /\b(api[-_]?key|password|passphrase|mnemonic|seed(?:Phrase)?|privateKey|secret|token|authorization|vault)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/giu,
      '$1=[REDACTED]',
    )
    .replace(/\b(?:0x)?[a-f0-9]{64,}\b/giu, '[REDACTED_HEX]')
    .replace(/(https?:\/\/[^\s?]+)\?\S+/giu, '$1?[REDACTED_QUERY]');
}

function dedupeFindings(findings: PendingFinding[]): RunSideFinding[] {
  const byFingerprint = new Map<string, RunSideFinding>();
  for (const finding of findings) {
    const existing = byFingerprint.get(finding.fingerprint);
    if (existing) existing.count += 1;
    else byFingerprint.set(finding.fingerprint, { ...finding, count: 1 });
  }
  return [...byFingerprint.values()];
}

// total counts the findings that need review; allowlisted ones are info.
function countFindings(findings: RunSideFinding[]) {
  const counts = { total: 0, warning: 0, error: 0, exception: 0, info: 0 };
  for (const finding of findings) {
    counts[finding.level] += 1;
    if (finding.level !== 'info') counts.total += 1;
  }
  return counts;
}

function stripInternal(finding: RunSideFinding & { event?: ConsoleEventKey }): RunSideFinding {
  const { event: _event, ...rest } = finding;
  return rest;
}

function readSlice(filePath: string, offset: number, length: number): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function indexDiagnosticArtifact(manifestPath: string): void {
  const manifest = readJsonRecord(manifestPath);
  if (!manifest) return;
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  manifest.artifacts = [
    ...artifacts.filter(
      (artifact) =>
        !isRecord(artifact) ||
        !['diagnostics.json', RAW_APP_LOG_ARTIFACT].includes(String(artifact.path)),
    ),
    {
      path: 'diagnostics.json',
      type: 'json',
      label: 'Run-scoped application diagnostics',
      category: 'diagnostic',
    },
    {
      path: RAW_APP_LOG_ARTIFACT,
      type: 'log',
      label: 'Redacted run-scoped application log slice',
      category: 'diagnostic',
    },
  ];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function indexDiagnosticSummary(summaryPath: string, diagnostics: RunDiagnosticsDocument): void {
  const summary = readJsonRecord(summaryPath);
  if (!summary) return;
  summary.sideFindings = {
    status: diagnostics.status,
    nonBlocking: true,
    counts: diagnostics.counts,
    diagnosticsPath: 'diagnostics.json',
    appLogPath: RAW_APP_LOG_ARTIFACT,
    appLogRedacted: true,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

// The run's recipe library roots (summary.json), where console allowlists live.
function recipeLibraryRoots(
  summaryPath: string,
  classifier: Pick<ConsoleClassifier<ConsoleAllowlist>, 'libraryRoots'>,
): string[] {
  const summary = readJsonRecord(summaryPath);
  const libraries = isRecord(summary?.recipeLibraries) ? summary.recipeLibraries : null;
  const sources = Array.isArray(libraries?.sources) ? libraries.sources : [];
  const roots = sources
    .map((source: unknown) =>
      isRecord(source) && typeof source.root === 'string' ? source.root : null,
    )
    .filter((root): root is string => Boolean(root));
  return roots.length ? roots : classifier.libraryRoots();
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
