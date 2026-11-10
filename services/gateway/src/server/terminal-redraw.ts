/** A client that never resizes still gets its redraw after this delay. */
export const REDRAW_FALLBACK_MS = 1_500;
/** A resize this long after the join no longer asks for a redraw. */
export const REDRAW_PENDING_MS = 10_000;

interface PendingRedraw {
  timer: ReturnType<typeof setTimeout>;
  expiresAt: number;
}

/**
 * tmux does not redraw for a viewer joining a running PTY, so a redraw is requested once the
 * viewer can show it: right after its own first resize is answered (Command Center drops PTY
 * output until then), or after a fallback delay for a client that does not resize. A resize
 * within the pending window still redraws after the fallback, for a client that sized late.
 */
export function createTerminalRedraws<Client extends object>(redraw: (key: string) => void) {
  const pending = new WeakMap<Client, Map<string, PendingRedraw>>();
  const forClient = (client: Client) => {
    let keys = pending.get(client);
    if (!keys) pending.set(client, (keys = new Map()));
    return keys;
  };
  const unref = (timer: ReturnType<typeof setTimeout>) => {
    timer.unref?.();
    return timer;
  };
  /** Forgets a viewer's pending redraw: it left, sized up, or its window ended. */
  function cancel(client: Client, key: string): void {
    const keys = pending.get(client);
    const entry = keys?.get(key);
    if (!keys || !entry) return;
    clearTimeout(entry.timer);
    keys.delete(key);
  }
  return {
    /** The viewer joined a running PTY. */
    expect(client: Client, key: string): void {
      cancel(client, key);
      const keys = forClient(client);
      const expiresAt = Date.now() + REDRAW_PENDING_MS;
      const entry: PendingRedraw = {
        expiresAt,
        timer: unref(
          setTimeout(() => {
            redraw(key);
            // Kept only until the window ends, for a resize that arrives late.
            entry.timer = unref(
              setTimeout(() => cancel(client, key), Math.max(0, expiresAt - Date.now())),
            );
          }, REDRAW_FALLBACK_MS),
        ),
      };
      keys.set(key, entry);
    },
    /** The viewer's resize for `key` was answered; undefined when no PTY was resized. */
    afterResize(client: Client, key: string | undefined): void {
      const entry = key === undefined ? undefined : pending.get(client)?.get(key);
      if (key === undefined || !entry) return;
      cancel(client, key);
      if (Date.now() > entry.expiresAt) return;
      // Starts after this resize's response is sent, so the output reaches a ready client.
      setImmediate(() => redraw(key));
    },
    cancel,
    /** Redraws still pending for a client; an expired one is not kept. */
    pendingCount(client: Client): number {
      return pending.get(client)?.size ?? 0;
    },
  };
}
