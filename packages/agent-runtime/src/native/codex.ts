import type { NativeSessionResponse } from '@farmslot/protocol';

import { JsonLineProcess } from './process.js';
import type { NativeAdapter, NativeEventInput } from './types.js';

function wireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a native protocol object');
  return value as Record<string, unknown>;
}

function wireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a native protocol string');
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function questions(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Expected native question list');
  return value.map((entry) => {
    const question = wireObject(entry);
    const options = question.options ?? [];
    if (!Array.isArray(options)) throw new Error('Expected native question options');
    return {
      id: wireString(question.id),
      prompt: wireString(question.question),
      multiSelect: false,
      options: options.map((entry) => {
        const option = wireObject(entry);
        return { label: wireString(option.label), description: optionalString(option.description) };
      }),
    };
  });
}

export const codexNativeAdapter: NativeAdapter = {
  capabilities: {
    modes: ['default', 'plan'],
    streaming: true,
    tools: true,
    approvals: true,
    questions: false,
    interrupt: true,
    resume: true,
  },
  async start(options, emit) {
    let nativeSessionId = '';
    let resolvedModel = options.model;
    let turnId: string | undefined;
    let commandId: string | undefined;
    let startingTurn: Promise<unknown> | undefined;
    const requests = new Map<
      string,
      { id: string | number; method: string; params: Record<string, unknown> }
    >();
    const publish = (event: NativeEventInput) => emit({ commandId, turnId, ...event });
    const pendingTools = new Map<string, NonNullable<NativeEventInput['tool']>>();
    const process = new JsonLineProcess(
      options.executable,
      ['app-server'],
      options,
      (message) => {
        const params = wireObject(message.params ?? {});
        const method = optionalString(message.method);
        if (params.threadId && nativeSessionId && params.threadId !== nativeSessionId) return;
        if (message.id !== undefined && method) {
          if (typeof message.id !== 'string' && typeof message.id !== 'number')
            throw new Error('Expected a native request ID');
          const requestId = String(message.id);
          if (
            [
              'item/commandExecution/requestApproval',
              'item/fileChange/requestApproval',
              'item/permissions/requestApproval',
              'item/tool/requestUserInput',
            ].includes(method)
          ) {
            requests.set(requestId, { id: message.id, method, params });
            publish({
              type:
                message.method === 'item/tool/requestUserInput'
                  ? 'question.requested'
                  : 'approval.requested',
              nativeId: requestId,
              request: {
                id: requestId,
                title:
                  message.method === 'item/tool/requestUserInput'
                    ? 'Answer runner questions'
                    : 'Allow runner action?',
                detail: optionalString(params.reason) ?? optionalString(params.command),
                tool: pendingTools.get(optionalString(params.itemId) ?? ''),
                questions: questions(params.questions),
              },
              data: { ...params, method: message.method },
            });
          } else {
            // Unsupported server requests fail closed instead of silently granting access.
            process.write({
              id: message.id,
              error: { code: -32601, message: `Unsupported native request: ${message.method}` },
            });
            publish({ type: 'error', text: `Unsupported native request: ${message.method}` });
          }
          return;
        }
        switch (method) {
          case 'turn/started':
            turnId = wireString(wireObject(params.turn).id);
            publish({ type: 'turn.started', data: { turn: params.turn } });
            break;
          case 'item/agentMessage/delta':
            publish({
              type: 'text.delta',
              nativeId: wireString(params.itemId),
              text: wireString(params.delta),
            });
            break;
          case 'item/started':
          case 'item/completed': {
            const item = wireObject(params.item);
            const itemType = wireString(item.type);
            if (!['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(itemType)) {
              const tool = {
                name: itemType,
                input: item.command ?? item.arguments ?? item.changes,
                output: item.aggregatedOutput ?? item.result,
                status: optionalString(item.status),
              };
              const itemId = wireString(item.id);
              if (message.method === 'item/started') pendingTools.set(itemId, tool);
              else pendingTools.delete(itemId);
              publish({
                type: message.method === 'item/started' ? 'tool.started' : 'tool.completed',
                nativeId: itemId,
                tool,
                data: item,
              });
            }
            break;
          }
          case 'serverRequest/resolved':
            requests.delete(String(params.requestId));
            publish({ type: 'approval.resolved', nativeId: String(params.requestId) });
            break;
          case 'turn/completed': {
            const turn = wireObject(params.turn);
            const status = turn.status;
            if (status !== 'completed' && status !== 'interrupted' && status !== 'failed')
              throw new Error('Unknown native terminal turn status');
            publish({
              type: 'turn.completed',
              status,
              data: { status, error: turn.error },
            });
            requests.clear();
            pendingTools.clear();
            turnId = undefined;
            commandId = undefined;
            break;
          }
          case 'error':
            publish({
              type: 'error',
              data: params,
              text: optionalString(wireObject(params.error ?? {}).message),
            });
            break;
        }
      },
      (error, processStopped) =>
        publish({
          type: 'session.closed',
          ...(error ? { status: 'failed' } : {}),
          data: { processStopped, ...(error ? { error: error.message } : {}) },
        }),
    );
    try {
      await process.request('initialize', {
        clientInfo: { name: 'farmslot', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      process.write({ method: 'initialized', params: {} });
      const result = wireObject(
        await process.request(options.resumeSessionId ? 'thread/resume' : 'thread/start', {
          ...(options.resumeSessionId ? { threadId: options.resumeSessionId } : {}),
          cwd: options.cwd,
          model: options.model,
          approvalPolicy: 'untrusted',
          sandbox: 'workspace-write',
        }),
      );
      nativeSessionId = wireString(wireObject(result.thread).id);
      resolvedModel = optionalString(result.model) ?? options.model;
      if (options.mode === 'plan' && !resolvedModel)
        throw new Error('Native planning mode requires the resolved model');
      if (options.resumeSessionId && nativeSessionId !== options.resumeSessionId)
        throw new Error('Codex resumed a different native session');
      publish({ type: 'session.started', nativeId: nativeSessionId });
    } catch (error) {
      await process.close();
      throw error;
    }
    return {
      nativeSessionId,
      capabilities: { ...codexNativeAdapter.capabilities, questions: options.mode === 'plan' },
      async send(text, id) {
        commandId = id;
        // A response proves acceptance; turn/started independently proves execution.
        const result = wireObject(
          await (startingTurn = process.request('turn/start', {
            threadId: nativeSessionId,
            input: [{ type: 'text', text }],
            ...(options.mode === 'plan'
              ? {
                  collaborationMode: {
                    mode: 'plan',
                    settings: {
                      model: resolvedModel,
                      reasoning_effort: 'low',
                      developer_instructions: null,
                    },
                  },
                }
              : {}),
          })),
        );
        if (commandId === id && !turnId) turnId = wireString(wireObject(result.turn).id);
        publish({
          type: 'command.accepted',
          commandId: id,
          turnId: wireString(wireObject(result.turn).id),
          text,
        });
      },
      async respond(requestId: string, response: NativeSessionResponse) {
        const request = requests.get(requestId);
        if (!request) throw new Error('Native request is stale or belongs to another session');
        let result: unknown;
        if (request.method === 'item/tool/requestUserInput') {
          if (!response.answers) throw new Error('Question response requires answers');
          result = {
            answers: Object.fromEntries(
              Object.entries(response.answers).map(([id, answers]) => [id, { answers }]),
            ),
          };
        } else {
          if (!response.decision) throw new Error('Approval response requires a decision');
          result =
            request.method === 'item/permissions/requestApproval'
              ? {
                  permissions: response.decision === 'approve' ? request.params.permissions : {},
                  scope: 'turn',
                }
              : { decision: response.decision === 'approve' ? 'accept' : 'decline' };
        }
        process.write({ id: request.id, result });
        requests.delete(requestId);
        publish({
          type: 'approval.resolved',
          nativeId: requestId,
          data: { decision: response.decision },
        });
      },
      async interrupt() {
        if (!turnId && startingTurn) await startingTurn;
        if (!turnId) throw new Error('No active native turn to interrupt');
        await process.request('turn/interrupt', { threadId: nativeSessionId, turnId });
      },
      close: () => process.close(),
    };
  },
};
