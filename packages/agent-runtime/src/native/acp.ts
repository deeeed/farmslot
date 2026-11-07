import { randomUUID } from 'node:crypto';

import type {
  NativeSessionCapabilities,
  NativeSessionTool,
  NativeToolDiff,
  NativeToolKind,
} from '@farmslot/protocol';

import { type AcpPendingRequest, acpPermission } from './acp-requests.js';
import {
  type AcpAuthMethod,
  acpConfigChoices,
  type AcpObject,
  acpObject,
  AcpRpc,
  acpSessionConfigOptions,
  acpString,
  selectAcpAuthMethod,
  setAcpConfigOption,
} from './acp-rpc.js';
import { nativeChecklist } from './plan.js';
import type { NativeAdapter, NativeAdapterOptions, NativeEventInput } from './types.js';

const ACP_TOOL_KINDS: Record<string, NativeToolKind> = {
  execute: 'command',
  read: 'file-read',
  edit: 'file-edit',
  delete: 'file-edit',
  move: 'file-edit',
  search: 'search',
  fetch: 'web',
};

/**
 * What an ACP tool call does. An update that omits a field keeps the call's earlier value: Cursor
 * refreshes a shell call's input with its command without repeating the call's kind.
 */
function acpToolKind(
  update: AcpObject,
  previous: Pick<NativeSessionTool, 'kind'> | undefined,
): Pick<NativeSessionTool, 'kind' | 'command' | 'paths'> {
  const kind =
    typeof update.kind === 'string'
      ? Object.hasOwn(ACP_TOOL_KINDS, update.kind)
        ? ACP_TOOL_KINDS[update.kind]
        : 'other'
      : undefined;
  const input =
    update.rawInput && typeof update.rawInput === 'object'
      ? (update.rawInput as Record<string, unknown>)
      : {};
  const paths = (Array.isArray(update.locations) ? update.locations : []).flatMap(
    (location: unknown) => {
      const path =
        location && typeof location === 'object'
          ? (location as { path?: unknown }).path
          : undefined;
      return typeof path === 'string' ? [path] : [];
    },
  );
  return {
    ...(kind ? { kind } : {}),
    ...((kind ?? previous?.kind) === 'command' && typeof input.command === 'string'
      ? { command: input.command }
      : {}),
    ...(paths.length ? { paths } : {}),
  };
}

/** Keep standard file edits in the shared tool contract; renderers never decode ACP. */
function acpToolDiffs(content: unknown): NativeToolDiff[] | undefined {
  if (content === undefined) return undefined;
  if (!Array.isArray(content)) throw new Error('Invalid ACP tool content');
  const diffs: NativeToolDiff[] = [];
  for (const item of content) {
    const block = acpObject(item);
    if (block.type !== 'diff') continue;
    if (block.oldText !== undefined && block.oldText !== null && typeof block.oldText !== 'string')
      throw new Error('Invalid ACP previous file text');
    diffs.push({
      path: acpString(block.path),
      oldText: block.oldText ?? null,
      newText: acpString(block.newText),
    });
  }
  return diffs.length ? diffs : undefined;
}

export interface AcpAdapterConfig {
  args(options: NativeAdapterOptions): string[];
  /** Omit only for an agent that uses its existing provider login at session start. */
  authMethod?: AcpAuthMethod;
  /** Existing bindings may retain their proven legacy model command. */
  modelConfiguration?: 'advertised' | 'legacy';
  /** Apply explicit effort through the advertised thought-level option. */
  effortConfig?: boolean;
  clientCapabilities?: AcpObject;
  /** Agent-specific session policy stays at the registered adapter boundary. */
  sessionMetadata?: (options: NativeAdapterOptions) => AcpObject | undefined;
  configureModel?: (
    sessionId: string,
    session: AcpObject,
    requested: string,
    request: (method: string, params: AcpObject) => Promise<unknown>,
  ) => Promise<void>;
  defaultModeId?: string;
  /** Runner settings that have no CLI flag, added to the session's environment. */
  environment?: (options: NativeAdapterOptions) => Record<string, string>;
  modes: Array<'default' | 'plan'>;
  extensionRequest?: (method: string, params: AcpObject) => AcpPendingRequest | undefined;
}

/** A runner may run its tools without asking: inside the host review sandbox, or above the sandboxed tier. */
export function acpRunsToolsUnasked(options: NativeAdapterOptions): boolean {
  return (
    Boolean(options.processSandbox) ||
    Boolean(options.safetyTier && options.safetyTier !== 'sandboxed')
  );
}

/** Common ACP v1 flow, confirmed against the installed Cursor and Grok servers. */
export function createAcpAdapter(config: AcpAdapterConfig): NativeAdapter {
  const capabilities: NativeSessionCapabilities = {
    modes: config.modes,
    approvalModes: ['ask', 'bypass'],
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
      let approvalMode = options.approvalMode ?? 'ask';
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
        config.environment
          ? { ...options, env: { ...(options.env ?? process.env), ...config.environment(options) } }
          : options,
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
            // ACP has no portable live tool-policy setter. Keep the runner asking and grant
            // each tool request here, so returning to ask works without replacing its process.
            // Questions and plan decisions still require their own human response.
            const workerApproval =
              options.approvalMode === undefined && options.approvalPolicy === 'never';
            if (
              (approvalMode === 'bypass' || workerApproval) &&
              method === 'session/request_permission'
            ) {
              const result = request.response({ decision: 'approve' });
              // The host journals this decision before the grant. No pending request reaches
              // either client, so a bypass tool cannot flash an approval prompt.
              publish({
                type: 'approval.resolved',
                nativeId: `${typeof message.id}:${message.id}`,
                request: { ...request.event.request!, id: `${typeof message.id}:${message.id}` },
                data: {
                  decision: 'approve',
                  automatic: true,
                  ...(workerApproval ? { policy: 'worker-launch' } : { approvalMode: 'bypass' }),
                },
              });
              rpc.write({ id: message.id, result });
              return;
            }
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
          if (kind === 'plan') {
            accept();
            // Each update is the agent's whole plan; entry priority is not carried.
            publish({ type: 'plan.updated', plan: nativeChecklist(update.entries, 'content') });
          }
          if (kind === 'tool_call' || kind === 'tool_call_update') {
            accept();
            const id = acpString(update.toolCallId);
            const previous = tools.get(id);
            const blocks =
              update.content === undefined
                ? undefined
                : (() => {
                    if (!Array.isArray(update.content)) throw new Error('Invalid ACP tool content');
                    return update.content.map(acpObject);
                  })();
            const diffs = acpToolDiffs(blocks);
            const content = diffs
              ? blocks?.filter((block) => block.type !== 'diff')
              : update.content;
            const output =
              update.rawOutput ?? (Array.isArray(content) && !content.length ? undefined : content);
            const details = diffs
              ? {
                  ...update,
                  // Old/new text is stored once in tool.diffs; retain other provider metadata.
                  content: blocks?.map((block) => {
                    if (block.type !== 'diff') return block;
                    const { oldText: _old, newText: _new, ...metadata } = block;
                    return metadata;
                  }),
                }
              : update;
            const tool = {
              ...previous,
              name:
                typeof update.title === 'string' ? update.title : (previous?.name ?? 'Runner tool'),
              ...acpToolKind(update, previous),
              ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
              ...(output !== undefined ? { output } : {}),
              ...(diffs
                ? {
                    diffs,
                    paths: [
                      ...new Set([...(previous?.paths ?? []), ...diffs.map((diff) => diff.path)]),
                    ],
                  }
                : {}),
              ...(typeof update.status === 'string' ? { status: update.status } : {}),
            };
            if (!previous) publish({ type: 'tool.started', nativeId: id, tool, data: details });
            tools.set(id, tool);
            if (
              (tool.status === 'completed' || tool.status === 'failed') &&
              (previous?.status !== tool.status || diffs !== undefined)
            ) {
              publish({ type: 'tool.completed', nativeId: id, tool, data: details });
              // Terminal status can precede the provider hook's corrected file diff.
              // Repeated completion is an upsert under the same native tool identity.
            }
          }
        },
        (error, processStopped, evidence) => {
          closed = true;
          requests.clear();
          publish({
            type: 'session.closed',
            ...(error || protocolFailure ? { status: 'failed' as const } : {}),
            data: { processStopped, ...evidence, ...(error ? { error: error.message } : {}) },
          });
        },
      );
      let sessionCapabilities = { ...capabilities };
      try {
        const result = acpObject(
          await rpc.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: config.clientCapabilities ?? {},
            clientInfo: { name: 'farmslot', version: '1' },
          }),
        );
        if (result.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
        const supported = acpObject(result.agentCapabilities);
        if (config.authMethod !== undefined) {
          const authMethod = selectAcpAuthMethod(result.authMethods, config.authMethod);
          if (!authMethod)
            throw new Error('Runner did not advertise the required native login method');
          await rpc.request('authenticate', { methodId: authMethod, _meta: { headless: true } });
        }
        sessionCapabilities = { ...capabilities, resume: supported.loadSession === true };
        if (options.resumeSessionId && !sessionCapabilities.resume)
          throw new Error('Runner does not support saved-session loading');
        const sessionMetadata = config.sessionMetadata?.(options);
        const session = acpObject(
          await rpc.request(options.resumeSessionId ? 'session/load' : 'session/new', {
            cwd: options.cwd,
            mcpServers: [],
            ...(sessionMetadata ? { _meta: sessionMetadata } : {}),
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
        // Apply advertised configuration and confirm it before admitting the first prompt.
        let configuration = session;
        const configure = async (option: AcpObject, value: string) => {
          const id = acpString(option.id);
          if (!acpConfigChoices(configuration, id)?.includes(value))
            throw new Error(`ACP agent did not advertise ${id} ${JSON.stringify(value)}`);
          const configOptions = await setAcpConfigOption(
            (method, params) => rpc.request(method, params),
            nativeSessionId,
            id,
            value,
            'ACP agent',
          );
          if (configOptions.find((entry) => entry.id === id)?.currentValue !== value)
            throw new Error(`ACP agent did not confirm ${id} ${JSON.stringify(value)}`);
          configuration = { ...configuration, configOptions };
        };
        if (options.model) {
          if (config.configureModel)
            await config.configureModel(nativeSessionId, session, options.model, (method, params) =>
              rpc.request(method, params),
            );
          else {
            const model =
              config.modelConfiguration === 'legacy'
                ? undefined
                : acpSessionConfigOptions(configuration).find(
                    (option) => option.category === 'model' || option.id === 'model',
                  );
            if (model) await configure(model, options.model);
            else
              await rpc.request('session/set_model', {
                sessionId: nativeSessionId,
                modelId: options.model,
              });
          }
        }
        if (config.effortConfig && options.effort && options.effort !== 'auto') {
          const effort = acpSessionConfigOptions(configuration).find(
            (option) => option.category === 'thought_level',
          );
          if (!effort) throw new Error('ACP agent did not advertise an effort setting');
          await configure(effort, options.effort);
        }
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
        async setApprovalMode(mode) {
          if (command) throw new Error('Wait for the current turn before changing approvals');
          approvalMode = mode;
        },
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
