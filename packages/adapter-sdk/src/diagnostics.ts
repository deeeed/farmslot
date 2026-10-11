import { isRecord } from '@farmslot/protocol';

// info: a finding the recipe library's console allowlist marks as known
// third-party noise; it is reported but does not make a run REVIEW.
export type DiagnosticLevel = 'info' | 'warning' | 'error' | 'exception';

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
