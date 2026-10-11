/** Executions owned by one gateway connection, independent of later reconnects. */
export class ExecRequests {
  private readonly active = new Map<
    string,
    { controller: AbortController; execution: Promise<unknown> }
  >();
  private closed = false;

  async run<T>(id: string, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Execution connection is closed.');
    if (this.active.has(id)) throw new Error('Execution request is already active.');
    const controller = new AbortController();
    const execution = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return execute(controller.signal);
    });
    this.active.set(id, { controller, execution });
    try {
      return await execution;
    } finally {
      this.active.delete(id);
    }
  }

  cancel(id: string): boolean {
    const request = this.active.get(id);
    if (!request) return false;
    request.controller.abort();
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    const requests = [...this.active.values()];
    for (const request of requests) request.controller.abort();
    // Execution callers receive failures; shutdown waits for every settlement.
    await Promise.allSettled(requests.map((request) => request.execution));
  }
}
