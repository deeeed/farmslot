import { connect } from 'node:net';

import type { NativeConversationInitial, NativeConversationUpdate } from '@farmslot/protocol';

import type { HostIdentity, HostRequest } from './ipc.js';

export interface NativeConversationConnection {
  initial: NativeConversationInitial;
  activate(): void;
  stop(): void;
}

/** Passive, authenticated IPC on the existing detached host. Never launches a process. */
export function subscribeHost(
  host: HostIdentity,
  request: Extract<HostRequest, { method: 'subscribe' }>,
  deliver: (update: NativeConversationUpdate) => void,
): Promise<NativeConversationConnection> {
  return new Promise((resolve, reject) => {
    const socket = connect(host.socket);
    socket.setEncoding('utf8');
    let input = '';
    let settled = false;
    let active = false;
    let stopped = false;
    let terminal = false;
    let queued: NativeConversationUpdate[] = [];
    let queuedBytes = 0;
    const timer = setTimeout(
      () => fail(new Error('Native conversation subscription timed out')),
      30_000,
    );
    function stop() {
      stopped = true;
      clearTimeout(timer);
      queued = [];
      socket.destroy();
    }
    function fail(error: Error) {
      if (stopped) return;
      if (!settled) {
        stop();
        reject(error);
      } else if (!terminal) {
        terminal = true;
        publish({ kind: 'terminal', reason: 'source-unavailable' });
        socket.destroy();
      }
    }
    function publish(update: NativeConversationUpdate) {
      if (stopped) return;
      if (update.kind === 'terminal') terminal = true;
      if (active) {
        deliver(update);
        return;
      }
      queuedBytes += Buffer.byteLength(JSON.stringify(update));
      if (queuedBytes > 1024 * 1024) {
        queued = [{ kind: 'terminal', reason: 'resync-required' }];
        terminal = true;
        socket.destroy();
      } else queued.push(update);
    }
    socket.on('connect', () => socket.end(JSON.stringify({ token: host.token, request })));
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('Native conversation source closed')));
    socket.on('data', (chunk: string) => {
      input += chunk;
      for (;;) {
        const end = input.indexOf('\n');
        if (end < 0) break;
        const line = input.slice(0, end);
        input = input.slice(end + 1);
        if (Buffer.byteLength(line) > 1024 * 1024) {
          fail(new Error('Native stream frame exceeds its bound'));
          return;
        }
        // The peer holds the private host credential and the socket belongs to this OS user.
        let frame: { value?: NativeConversationUpdate; error?: string; errorCode?: string };
        try {
          frame = JSON.parse(line);
        } catch {
          fail(new Error('Invalid native conversation frame'));
          return;
        }
        if (frame.error || !frame.value) {
          fail(
            Object.assign(
              new Error(frame.error ?? 'Invalid native stream frame'),
              frame.errorCode === 'NOT_FOUND' ? { code: 'NOT_FOUND' } : {},
            ),
          );
          return;
        }
        if (!settled) {
          if (frame.value.kind === 'delta') {
            fail(new Error('Native stream delivered a delta before its initial reply'));
            return;
          }
          settled = true;
          terminal = frame.value.kind === 'terminal';
          clearTimeout(timer);
          resolve({
            initial: frame.value,
            stop,
            activate() {
              if (stopped || active) return;
              active = true;
              const pending = queued;
              queued = [];
              for (const update of pending) {
                if (stopped) break;
                deliver(update);
              }
            },
          });
        } else publish(frame.value);
      }
      if (Buffer.byteLength(input) > 1024 * 1024)
        fail(new Error('Native stream frame exceeds its bound'));
    });
    socket.on('end', () => {
      if (input) {
        let frame: { error?: string; errorCode?: string };
        try {
          frame = JSON.parse(input);
        } catch {
          fail(new Error('Native stream ended with an incomplete frame'));
          return;
        }
        fail(
          Object.assign(
            new Error(frame.error ?? 'Native stream ended with an incomplete frame'),
            frame.errorCode === 'NOT_FOUND' ? { code: 'NOT_FOUND' } : {},
          ),
        );
      }
    });
  });
}
