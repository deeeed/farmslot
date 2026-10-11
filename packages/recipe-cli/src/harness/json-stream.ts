import type { CommandEventStream, StageHandle } from '@farmslot/adapter-sdk';

import { recordCommandStage } from './command-journal.js';
import { createStageReporter } from './stage-progress.js';
type JsonFields = Record<string, unknown>;
type WriteCallback = (error?: Error | null) => void;

function redirectStdout(write: typeof process.stdout.write): () => void {
  const original = process.stdout.write;
  process.stdout.write = write;
  return () => {
    if (process.stdout.write === write) process.stdout.write = original;
  };
}

/** Release machine output only after closeout; retain failed invocation output as diagnostics. */
export function deferCommandOutput(): (success: boolean) => void {
  const chunks: Buffer[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const restore = redirectStdout(((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ) => {
    chunks.push(
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8')
        : Buffer.from(chunk),
    );
    (typeof encoding === 'function' ? encoding : callback)?.();
    return true;
  }) as typeof process.stdout.write);
  return (success) => {
    restore();
    for (const chunk of chunks) {
      if (success) write(chunk);
      else process.stderr.write(chunk);
    }
  };
}

export class JsonStreamWriter implements CommandEventStream {
  readonly enabled: boolean;
  readonly command: string;

  private completed = false;
  private lastError: string | undefined;
  private readonly writeLine: (line: string) => void;
  private readonly stages = createStageReporter({ event: (fields) => this.emit('stage', fields) });

  constructor(
    command: string,
    enabled: boolean,
    output: Pick<NodeJS.WriteStream, 'write'> = process.stdout,
  ) {
    this.command = command;
    this.enabled = enabled;
    const write = output.write.bind(output);
    this.writeLine = (line) => {
      write(`${line}\n`);
    };
  }

  isolateStdout(): () => void {
    if (!this.enabled) return () => undefined;
    const redirect = ((
      chunk: string | Uint8Array,
      encoding?: BufferEncoding,
      callback?: (error?: Error | null) => void,
    ) => process.stderr.write(chunk, encoding, callback)) as typeof process.stdout.write;
    return redirectStdout(redirect);
  }

  emit(event: string, fields: JsonFields = {}): void {
    if (!this.enabled || this.completed) return;
    this.writeLine(
      JSON.stringify({
        schemaVersion: 1,
        command: this.command,
        event,
        ...fields,
        ts: new Date().toISOString(),
      }),
    );
  }

  phase(phase: string, fields: JsonFields = {}): void {
    recordCommandStage(phase);
    this.emit('phase', { phase, ...fields });
  }

  node(nodeId: string, action: string, status: 'running' | 'passed' | 'failed'): void {
    if (status === 'running') recordCommandStage(`${nodeId}: ${action}`);
    this.emit('node', { nodeId, action, status });
  }

  stage(name: string, position: { index: number; total: number }): StageHandle {
    return this.stages.stage(name, position);
  }

  mutation(mutation: JsonFields): void {
    this.emit('mutation', { mutation });
  }

  recovery(code: string): void {
    this.emit('recovery', { code });
  }

  error(error: JsonFields): void {
    if (typeof error.message === 'string') this.lastError = error.message;
    this.emit('error', { error });
  }

  complete(status: 'pass' | 'fail' | 'unknown', exitCode: number, fields: JsonFields = {}): void {
    // A stage the platform left running ends with the command, on stderr too.
    if (status === 'pass') this.stages.close('done');
    else this.stages.close('failed', this.lastError ?? `exit ${exitCode}`);
    if (!this.enabled || this.completed) return;
    this.emit('complete', { status, exitCode, ...fields });
    this.completed = true;
  }
}

/** Ends a stream on a thrown error: an `error` event, then `complete` (fail). */
export function failStream(
  stream: JsonStreamWriter,
  error: unknown,
  code: string,
  defaultExitCode = 1,
): number {
  const exitCode =
    error !== null &&
    typeof error === 'object' &&
    'exitCode' in error &&
    typeof (error as { exitCode?: unknown }).exitCode === 'number'
      ? (error as { exitCode: number }).exitCode
      : defaultExitCode;
  stream.error({
    code: exitCode === 2 ? 'USAGE' : code,
    message: error instanceof Error ? error.message : String(error),
  });
  stream.complete('fail', exitCode);
  return exitCode;
}
