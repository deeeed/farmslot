import { JsonLineProcess } from './process.js';
import type { NativeAdapterOptions } from './types.js';

export type AcpObject = Record<string, unknown>;
export function acpObject(value: unknown): AcpObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an ACP object');
  return value as AcpObject;
}
export function acpString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected an ACP string');
  return value;
}

/** ACP uses JSON-RPC 2.0; a prompt response may take the entire agent turn. */
export class AcpRpc {
  private process: JsonLineProcess;
  private nextId = 0;
  private pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer?: NodeJS.Timeout;
    }
  >();

  constructor(
    options: NativeAdapterOptions,
    args: string[],
    onMessage: (message: AcpObject) => void,
    onExit: (error: Error | undefined, stopped: boolean) => void,
  ) {
    this.process = new JsonLineProcess(
      options.executable,
      args,
      options,
      (message) => {
        if (message.jsonrpc !== '2.0') throw new Error('Expected ACP JSON-RPC 2.0');
        const pending =
          typeof message.id === 'string' && !message.method
            ? this.pending.get(message.id)
            : undefined;
        if (!pending) {
          onMessage(message);
          return;
        }
        const error = message.error === undefined ? undefined : acpObject(message.error);
        const failure = error
          ? new Error(`ACP request failed (${String(error.code)}): ${acpString(error.message)}`)
          : undefined;
        this.pending.delete(message.id as string);
        clearTimeout(pending.timer);
        if (failure) pending.reject(failure);
        else pending.resolve(message.result);
      },
      (error, stopped) => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error ?? new Error('ACP process closed'));
        }
        this.pending.clear();
        onExit(error, stopped);
      },
    );
  }

  request(method: string, params: unknown, timeoutMs: number | null = 30_000): Promise<unknown> {
    const id = `farmslot-acp-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`ACP request timed out: ${method}; acceptance is unknown`));
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  write(message: AcpObject): void {
    this.process.write({ jsonrpc: '2.0', ...message });
  }
  close(): Promise<void> {
    return this.process.close();
  }
}
