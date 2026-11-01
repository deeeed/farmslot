import { randomUUID } from 'node:crypto';

import type { NativeSessionTool, NativeToolKind } from '@farmslot/protocol';

import { acpObject as piObject } from './acp-rpc.js';
import { JsonLineProcess, NativeRequestRefused } from './process.js';
import type { NativeAdapter, NativeEventInput } from './types.js';

type PiRecord = Record<string, unknown>;
const piString = (value: unknown) => (typeof value === 'string' ? value : undefined);

// Records that belong to the running agent loop; queue, retry and extension notices do not
// show that Pi took the prompt.
const RUN_EVENTS = new Set([
  'agent_start',
  'turn_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_end',
  'agent_settled',
]);
const PI_THINKING = /:(off|minimal|low|medium|high|xhigh|max)$/;

// Pi's built-in tools. Extension tools read as `other`.
const PI_TOOL_KINDS: Record<string, NativeToolKind> = {
  bash: 'command',
  read: 'file-read',
  edit: 'file-edit',
  write: 'file-edit',
  grep: 'search',
  find: 'search',
  ls: 'search',
};
function piTool(name: string, args: unknown): NativeSessionTool {
  const input = args && typeof args === 'object' ? (args as PiRecord) : {};
  const kind = Object.hasOwn(PI_TOOL_KINDS, name) ? PI_TOOL_KINDS[name] : 'other';
  const path = piString(input.path);
  return {
    name,
    input: args,
    kind,
    ...(kind === 'command' && typeof input.command === 'string' ? { command: input.command } : {}),
    ...(kind !== 'command' && path ? { paths: [path] } : {}),
  };
}

/**
 * Pi's JSONL RPC mode (`pi --mode rpc`). Pi runs its tools without asking and has no
 * sandbox of its own, as in its terminal: the session reports no approvals.
 */
export const piNativeAdapter: NativeAdapter = {
  capabilities: {
    modes: ['default'],
    streaming: true,
    tools: true,
    approvals: false,
    questions: false,
    interrupt: true,
    resume: true,
    steer: true,
  },
  async start(options, emit) {
    if ((options.mode ?? 'default') !== 'default') throw new Error('Unsupported Pi mode');
    let nativeSessionId = '';
    let command:
      | { id: string; turnId: string; text: string; accepted: boolean; failure?: string }
      | undefined;
    let closed = false;
    let nextId = 0;
    // A reply that arrives after its request timed out is dropped, not a protocol failure.
    const expired = new Set<string>();
    // Pi sends a tool's arguments only when it starts.
    const toolArgs = new Map<string, unknown>();
    const pending = new Map<
      string,
      { resolve(value: unknown): void; reject(error: Error): void; timer?: NodeJS.Timeout }
    >();
    const publish = (event: NativeEventInput) =>
      emit({ commandId: command?.id, turnId: command?.turnId, ...event });
    // The prompt reply and the run's first event can arrive in either order.
    const accept = () => {
      if (!command || command.accepted) return;
      command.accepted = true;
      publish({ type: 'command.accepted', text: command.text });
    };
    const process = new JsonLineProcess(
      options.executable,
      [
        '--mode',
        'rpc',
        ...(options.model ? ['--model', options.model] : []),
        ...(options.effort ? ['--thinking', options.effort] : []),
        ...(options.resumeSessionId ? ['--session', options.resumeSessionId] : []),
      ],
      options,
      (message) => {
        const type = message.type;
        if (type === 'response') {
          const id = piString(message.id);
          if (id !== undefined && expired.delete(id)) return;
          const request = id === undefined ? undefined : pending.get(id);
          // A response without a known ID (such as a parse failure) breaks correlation.
          if (!request) throw new Error(`Pi sent an unmatched ${String(message.command)} response`);
          pending.delete(id!);
          clearTimeout(request.timer);
          if (message.success === true) request.resolve(message.data);
          else
            request.reject(
              new NativeRequestRefused(
                `Pi ${String(message.command)} failed: ${String(message.error)}`,
              ),
            );
          return;
        }
        if (type === 'extension_ui_request') {
          const method = message.method;
          // Extension dialogs have no native surface yet; answer so Pi does not wait.
          if (['select', 'confirm', 'input', 'editor'].includes(String(method)))
            process.write({ type: 'extension_ui_response', id: message.id, cancelled: true });
          return;
        }
        if (!command || !RUN_EVENTS.has(String(type))) return;
        accept();
        switch (type) {
          case 'agent_start':
            publish({ type: 'turn.started' });
            break;
          case 'message_update': {
            const update = piObject(message.assistantMessageEvent);
            if (update.type === 'text_delta')
              publish({ type: 'text.delta', text: piString(update.delta) ?? '' });
            break;
          }
          case 'message_end': {
            // Pi retries a failed model request itself, so only the last answer decides.
            const final = piObject(message.message);
            if (final.role === 'assistant')
              command.failure =
                final.stopReason === 'error'
                  ? (piString(final.errorMessage) ?? 'Pi model request failed')
                  : undefined;
            break;
          }
          case 'tool_execution_start':
            toolArgs.set(String(message.toolCallId), message.args);
            publish({
              type: 'tool.started',
              nativeId: piString(message.toolCallId),
              tool: { ...piTool(String(message.toolName), message.args), status: 'in_progress' },
            });
            break;
          case 'tool_execution_end':
            publish({
              type: 'tool.completed',
              nativeId: piString(message.toolCallId),
              tool: {
                ...piTool(String(message.toolName), toolArgs.get(String(message.toolCallId))),
                output: message.result,
                status: message.isError === true ? 'failed' : 'completed',
              },
            });
            break;
          case 'agent_settled':
            if (command.failure && message.aborted !== true)
              publish({ type: 'error', text: command.failure });
            publish({
              type: 'turn.completed',
              status:
                message.aborted === true ? 'interrupted' : command.failure ? 'failed' : 'completed',
              data: { aborted: message.aborted === true },
            });
            command = undefined;
            toolArgs.clear();
            break;
        }
      },
      (error, processStopped, evidence) => {
        closed = true;
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.reject(error ?? new Error('Pi process closed'));
        }
        pending.clear();
        publish({
          type: 'session.closed',
          ...(error ? { status: 'failed' as const } : {}),
          data: { processStopped, ...evidence, ...(error ? { error: error.message } : {}) },
        });
      },
    );
    const request = (record: PiRecord): Promise<unknown> => {
      const id = `farmslot-pi-${++nextId}`;
      return new Promise((resolve, reject) => {
        // Pi replies to `prompt` only after its pre-run work, such as compaction, so the prompt
        // waits like ACP's session/prompt. `abort` replies once Pi has settled.
        const timeoutMs =
          record.type === 'prompt' ? undefined : record.type === 'abort' ? 60_000 : 30_000;
        const timer =
          timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                pending.delete(id);
                expired.add(id);
                reject(new Error(`Pi ${String(record.type)} timed out; acceptance is unknown`));
              }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          process.write({ id, ...record });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    };
    try {
      const state = piObject(await request({ type: 'get_state' }));
      nativeSessionId = piString(state.sessionId) ?? '';
      if (!nativeSessionId) throw new Error('Pi did not report its session');
      if (options.resumeSessionId && nativeSessionId !== options.resumeSessionId)
        throw new Error('Pi loaded a different native session');
      // Set the exact requested model, never a silent fallback. A bare ID leaves the
      // provider to Pi, and a `:<thinking>` suffix sets the level, as Pi's own `--model` does.
      if (options.model) {
        const requested = options.model.replace(PI_THINKING, '');
        const model = state.model === undefined ? {} : piObject(state.model);
        const selected = requested.includes('/')
          ? `${String(model.provider)}/${String(model.id)}`
          : model.id;
        if (selected !== requested) throw new Error(`Pi model is unavailable: ${options.model}`);
      }
      publish({
        type: 'session.started',
        nativeId: nativeSessionId,
        data: { identityConfirmed: true },
      });
    } catch (error) {
      await process.close();
      throw error;
    }
    return {
      nativeSessionId,
      capabilities: piNativeAdapter.capabilities,
      async send(text, id) {
        if (closed) throw new Error('Pi session is closed');
        if (command) throw new Error('Pi turn is still active');
        command = { id, turnId: randomUUID(), text, accepted: false };
        let data: PiRecord;
        try {
          data = piObject(await request({ type: 'prompt', message: text }));
        } catch (error) {
          command = undefined;
          throw error;
        }
        accept();
        // An extension command or input handler consumed the prompt: no run follows.
        if (data.disposition === 'handled') {
          publish({ type: 'turn.completed', status: 'completed', data: { handled: true } });
          command = undefined;
        }
      },
      // Pi delivers the message after the running turn's tool calls, before its next model call.
      async steer(text, id) {
        if (closed) throw new Error('Pi session is closed');
        if (!command)
          throw new NativeRequestRefused('Pi has no running turn to add the message to');
        const turnId = command.turnId;
        await request({ type: 'steer', message: text });
        publish({ type: 'command.accepted', commandId: id, turnId, text });
      },
      async respond() {
        throw new Error('Pi sessions have no native requests to answer');
      },
      async interrupt() {
        if (closed) throw new Error('Pi session is closed');
        if (!command) throw new Error('No active native turn to interrupt');
        // Pi keeps queued steering through an abort; a stopped turn's steer must not run later.
        await request({ type: 'clear_queue' });
        await request({ type: 'abort' });
      },
      close: () => process.close(),
    };
  },
};
