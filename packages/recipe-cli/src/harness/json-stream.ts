import { recordCommandStage } from './command-journal.js';
type JsonFields = Record<string, unknown>;

export class JsonStreamWriter {
  readonly enabled: boolean;
  readonly command: string;

  private completed = false;
  private readonly writeLine: (line: string) => void;

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
    const original = process.stdout.write;
    const redirect = ((
      chunk: string | Uint8Array,
      encoding?: BufferEncoding,
      callback?: (error?: Error | null) => void,
    ) => process.stderr.write(chunk, encoding, callback)) as typeof process.stdout.write;
    process.stdout.write = redirect;
    return () => {
      if (process.stdout.write === redirect) process.stdout.write = original;
    };
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

  mutation(mutation: JsonFields): void {
    this.emit('mutation', { mutation });
  }

  recovery(code: string): void {
    this.emit('recovery', { code });
  }

  error(error: JsonFields): void {
    this.emit('error', { error });
  }

  complete(status: 'pass' | 'fail' | 'unknown', exitCode: number, fields: JsonFields = {}): void {
    if (!this.enabled || this.completed) return;
    this.emit('complete', { status, exitCode, ...fields });
    this.completed = true;
  }
}
