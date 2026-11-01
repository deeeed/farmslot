import type { NativeProcessExitEvidence } from '@farmslot/protocol';

import { JsonLineProcess, NativeRequestRefused } from './process.js';
import type { NativeAdapterOptions } from './types.js';

export type PiRecord = Record<string, unknown>;

/**
 * Pi's JSONL RPC (`pi --mode rpc`): a command carries a string `id`, and Pi answers it with one
 * `response` record. Every other record goes to `onRecord`.
 */
export class PiRpc {
  private process: JsonLineProcess;
  private nextId = 0;
  private pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer?: NodeJS.Timeout }
  >();
  // A reply that arrives after its request timed out is dropped, not a protocol failure.
  private expired = new Set<string>();

  constructor(
    options: Pick<
      NativeAdapterOptions,
      'cwd' | 'env' | 'onSpawn' | 'onProcessSnapshot' | 'signal' | 'processSandbox'
    > & { executable: string },
    args: string[],
    onRecord: (record: PiRecord) => void,
    onExit: (
      error: Error | undefined,
      stopped: boolean,
      evidence: NativeProcessExitEvidence,
    ) => void,
  ) {
    this.process = new JsonLineProcess(
      options.executable,
      args,
      options,
      (message) => {
        if (message.type !== 'response') {
          onRecord(message);
          return;
        }
        const id = typeof message.id === 'string' ? message.id : undefined;
        if (id !== undefined && this.expired.delete(id)) return;
        const request = id === undefined ? undefined : this.pending.get(id);
        // A response without a known ID (such as a parse failure) breaks correlation.
        if (!request) throw new Error(`Pi sent an unmatched ${String(message.command)} response`);
        this.pending.delete(id!);
        clearTimeout(request.timer);
        if (message.success === true) request.resolve(message.data);
        else
          request.reject(
            new NativeRequestRefused(
              `Pi ${String(message.command)} failed: ${String(message.error)}`,
            ),
          );
      },
      (error, stopped, evidence) => {
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(error ?? new Error('Pi process closed'));
        }
        this.pending.clear();
        onExit(error, stopped, evidence);
      },
    );
  }

  /** `timeoutMs` undefined waits for the reply. */
  request(record: PiRecord, timeoutMs: number | undefined = 30_000): Promise<unknown> {
    const id = `farmslot-pi-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              this.expired.add(id);
              reject(new Error(`Pi ${String(record.type)} timed out; acceptance is unknown`));
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.process.write({ id, ...record });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  write(record: PiRecord): void {
    this.process.write(record);
  }
  close(): Promise<void> {
    return this.process.close();
  }
}
