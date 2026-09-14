import { randomUUID } from 'node:crypto';

import { type AcpPendingRequest, acpPermission } from './acp-requests.js';
import { type AcpObject, acpObject, AcpRpc, acpString } from './acp-rpc.js';
import type { NativeAdapter, NativeAdapterOptions, NativeEventInput } from './types.js';

export interface AcpAdapterConfig {
  args(options: NativeAdapterOptions): string[];
  authMethod: string;
  defaultModeId?: string;
  modes: Array<'default' | 'plan'>;
  extensionRequest?: (method: string, params: AcpObject) => AcpPendingRequest | undefined;
}

/** Common ACP v1 flow, confirmed against the installed Cursor and Grok servers. */
export function createAcpAdapter(config: AcpAdapterConfig): NativeAdapter {
  const capabilities = {
    modes: config.modes,
    streaming: true,
    tools: true,
    approvals: true,
    questions: false,
    interrupt: true,
    resume: true,
  };
  return {
    capabilities,
    async start(options, emit) {
      if (!config.modes.includes(options.mode ?? 'default'))
        throw new Error('Unsupported ACP mode');
      let nativeSessionId = '';
      let command:
        | { id: string; turnId: string; text: string; accepted: boolean; started: boolean }
        | undefined;
      let closed = false;
      let closing = false;
      let initialized = false;
      let protocolFailure: string | undefined;
      const requests = new Map<string, { id: string | number; request: AcpPendingRequest }>();
      const tools = new Map<string, NonNullable<NativeEventInput['tool']>>();
      const publish = (event: NativeEventInput) =>
        emit({ commandId: command?.id, turnId: command?.turnId, ...event });
      const accept = (started = true) => {
        if (!command) return;
        if (!command.accepted) {
          command.accepted = true;
          publish({ type: 'command.accepted', text: command.text });
        }
        if (started && !command.started) {
          command.started = true;
          publish({ type: 'turn.started' });
        }
      };
      const rpc = new AcpRpc(
        options,
        config.args(options),
        (message) => {
          const method = typeof message.method === 'string' ? message.method : undefined;
          if (!method) return;
          const params = acpObject(message.params ?? {});
          if (
            params.sessionId !== undefined &&
            nativeSessionId &&
            params.sessionId !== nativeSessionId
          ) {
            if (message.id !== undefined)
              rpc.write({ id: message.id, error: { code: -32602, message: 'Wrong ACP session' } });
            return;
          }
          if (message.id !== undefined) {
            if (typeof message.id !== 'string' && typeof message.id !== 'number')
              throw new Error('Invalid ACP request ID');
            const request =
              method === 'session/request_permission'
                ? acpPermission(params, tools.get(String(acpObject(params.toolCall).toolCallId)))
                : config.extensionRequest?.(method, params);
            if (!request || !initialized || !command) {
              rpc.write({
                id: message.id,
                error: { code: -32601, message: 'Unsupported or inactive ACP client request' },
              });
              return;
            }
            accept();
            const key = `${typeof message.id}:${message.id}`;
            if (requests.has(key)) throw new Error('Duplicate ACP request ID');
            requests.set(key, { id: message.id, request });
            publish({
              ...request.event,
              nativeId: key,
              request: { ...request.event.request!, id: key },
            });
            return;
          }
          if (method !== 'session/update' || params.sessionId !== nativeSessionId || !command)
            return;
          const update = acpObject(params.update);
          const kind = update.sessionUpdate;
          if (kind === 'user_message_chunk') {
            accept(false);
            return;
          }
          if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
            accept();
            const content = acpObject(update.content);
            if (kind === 'agent_message_chunk' && content.type === 'text')
              publish({ type: 'text.delta', text: acpString(content.text) });
          }
          if (kind === 'tool_call' || kind === 'tool_call_update') {
            accept();
            const id = acpString(update.toolCallId);
            const previous = tools.get(id);
            const tool = {
              ...previous,
              name:
                typeof update.title === 'string' ? update.title : (previous?.name ?? 'Runner tool'),
              ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
              ...(update.rawOutput !== undefined || update.content !== undefined
                ? { output: update.rawOutput ?? update.content }
                : {}),
              ...(typeof update.status === 'string' ? { status: update.status } : {}),
            };
            if (!previous) publish({ type: 'tool.started', nativeId: id, tool, data: update });
            tools.set(id, tool);
            if (
              (update.status === 'completed' || update.status === 'failed') &&
              previous?.status !== update.status
            ) {
              publish({ type: 'tool.completed', nativeId: id, tool, data: update });
              // Retain the final tool to avoid duplicating terminal updates.
            }
          }
        },
        (error, processStopped) => {
          closed = true;
          requests.clear();
          publish({
            type: 'session.closed',
            ...(error || protocolFailure ? { status: 'failed' as const } : {}),
            data: { processStopped, ...(error ? { error: error.message } : {}) },
          });
        },
      );
      let sessionCapabilities = { ...capabilities };
      try {
        const result = acpObject(
          await rpc.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'farmslot', version: '1' },
          }),
        );
        if (result.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
        const supported = acpObject(result.agentCapabilities);
        if (
          !Array.isArray(result.authMethods) ||
          !result.authMethods.map(acpObject).some((method) => method.id === config.authMethod)
        )
          throw new Error('Runner did not advertise the required native login method');
        await rpc.request('authenticate', {
          methodId: config.authMethod,
          _meta: { headless: true },
        });
        sessionCapabilities = { ...capabilities, resume: supported.loadSession === true };
        if (options.resumeSessionId && !sessionCapabilities.resume)
          throw new Error('Runner does not support saved-session loading');
        const session = acpObject(
          await rpc.request(options.resumeSessionId ? 'session/load' : 'session/new', {
            cwd: options.cwd,
            mcpServers: [],
            ...(options.resumeSessionId ? { sessionId: options.resumeSessionId } : {}),
          }),
        );
        // ACP load success binds the requested ID. Load responses need not repeat it.
        nativeSessionId = options.resumeSessionId ?? acpString(session.sessionId);
        if (session.sessionId !== undefined && session.sessionId !== nativeSessionId)
          throw new Error('Runner loaded a different native session');
        const modes = session.modes === undefined ? undefined : acpObject(session.modes);
        const availableModes = Array.isArray(modes?.availableModes)
          ? modes.availableModes.map(acpObject)
          : [];
        sessionCapabilities.modes = [
          'default',
          ...(config.modes.includes('plan') && availableModes.some((mode) => mode.id === 'plan')
            ? ['plan' as const]
            : []),
        ];
        const modeId = options.mode === 'plan' ? 'plan' : config.defaultModeId;
        if (modeId) {
          if (!availableModes.some((mode) => mode.id === modeId))
            throw new Error('Runner did not advertise the requested execution mode');
          await rpc.request('session/set_mode', { sessionId: nativeSessionId, modeId });
        }
        // Set the exact requested model through the native session API, never silently fall back.
        if (options.model)
          await rpc.request('session/set_model', {
            sessionId: nativeSessionId,
            modelId: options.model,
          });
        initialized = true;
        publish({
          type: 'session.started',
          nativeId: nativeSessionId,
          data: { identityConfirmed: true },
        });
      } catch (error) {
        closing = true;
        await rpc.close();
        throw error;
      }
      return {
        nativeSessionId,
        capabilities: sessionCapabilities,
        async send(text, id) {
          if (closed || closing) throw new Error('ACP session is closed');
          if (command) throw new Error('ACP turn is still active');
          if (!text) throw new Error('ACP prompt must not be empty');
          command = { id, turnId: randomUUID(), text, accepted: false, started: false };
          // ACP has no separate prompt acknowledgement. Only native activity or its final
          // response proves acceptance; writing stdin does not. Keep send non-blocking.
          void rpc
            .request(
              'session/prompt',
              { sessionId: nativeSessionId, prompt: [{ type: 'text', text }] },
              null,
            )
            .then(
              (result) => {
                if (closed || closing) return;
                const response = acpObject(result);
                const stopReason = acpString(response.stopReason);
                accept();
                publish({
                  type: 'turn.completed',
                  status:
                    stopReason === 'cancelled'
                      ? 'interrupted'
                      : stopReason === 'end_turn'
                        ? 'completed'
                        : 'failed',
                  data: { stopReason },
                });
                command = undefined;
                requests.clear();
                tools.clear();
              },
              (error) => {
                if (closed || closing) return;
                publish({
                  type: 'error',
                  text: error instanceof Error ? error.message : String(error),
                });
                publish({ type: 'turn.completed', status: 'failed' });
                command = undefined;
                requests.clear();
                tools.clear();
              },
            )
            .catch((error) => {
              // A malformed terminal response invalidates the process, not just this turn.
              protocolFailure = error instanceof Error ? error.message : String(error);
              publish({
                type: 'error',
                status: 'failed',
                text: error instanceof Error ? error.message : String(error),
              });
              closing = true;
              return rpc.close().catch((cleanupError) => {
                publish({
                  type: 'session.closed',
                  status: 'failed',
                  data: {
                    processStopped: false,
                    error:
                      cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                  },
                });
              });
            });
        },
        async respond(requestId, response) {
          if (closed || closing) throw new Error('ACP session is closed');
          const pending = requests.get(requestId);
          if (!pending) throw new Error('Native request is stale or belongs to another session');
          rpc.write({ id: pending.id, result: pending.request.response(response) });
          requests.delete(requestId);
          publish({
            type: 'approval.resolved',
            nativeId: requestId,
            data: { decision: response.decision, answers: response.answers },
          });
        },
        async interrupt() {
          if (closed || closing) throw new Error('ACP session is closed');
          if (!command) throw new Error('No active native turn to interrupt');
          rpc.write({ method: 'session/cancel', params: { sessionId: nativeSessionId } });
        },
        async close() {
          closing = true;
          await rpc.close();
        },
      };
    },
  };
}
