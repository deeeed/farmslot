import { randomUUID } from 'node:crypto';

import type { NativeSessionResponse } from '@farmslot/protocol';

import { JsonLineProcess } from './process.js';
import type { NativeAdapter, NativeEventInput } from './types.js';

type JsonRecord = Record<string, unknown>;

/** Upstream fixed hook-history loss in 2.1.83 and interrupted-tool resume in 2.1.265. */
export function claudeResumeUnavailableReason(version: string): string | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version.trim());
  const [major, minor, patch] = match ? match.slice(1).map(Number) : [];
  if (major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 265)))) return;
  return 'Saved-session recovery requires a session started with Claude Code 2.1.265 or newer. Earlier versions can lose message/tool history; update the native runner and start a new session.';
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' ? (value as JsonRecord) : {};
}

function textContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return (
    content
      .map((block) => {
        const value = record(block);
        return value.type === 'text' && typeof value.text === 'string' ? value.text : '';
      })
      .join('') || undefined
  );
}

function toolUseBlocks(content: unknown): JsonRecord[] {
  if (!Array.isArray(content)) return [];
  return content
    .map(record)
    .filter(
      (block) =>
        block.type === 'tool_use' ||
        block.type === 'server_tool_use' ||
        block.type === 'mcp_tool_use',
    );
}

function toolResultBlocks(content: unknown): JsonRecord[] {
  if (!Array.isArray(content)) return [];
  return content.map(record).filter((block) => block.type === 'tool_result');
}

/**
 * Claude Code's documented stream-json mode is bidirectional: the host sends
 * user/control messages over stdin and receives structured events over stdout.
 * This deliberately runs the installed Claude binary; it does not reproduce
 * Claude's agent loop or authentication through an SDK.
 */
export const claudeNativeAdapter: NativeAdapter = {
  resumeUnavailableReason: claudeResumeUnavailableReason,
  capabilities: {
    modes: ['default'],
    streaming: true,
    tools: true,
    approvals: true,
    questions: true,
    interrupt: true,
    resume: true,
  },
  async start(options, emit) {
    const nativeSessionId = options.resumeSessionId ?? randomUUID();
    let identityConfirmed = false;
    let commandId: string | undefined;
    let turnId: string | undefined;
    let turnStarted = false;
    let closed = false;
    let protocolFailure: Error | undefined;
    let initialized = false;
    let interruptedCommandId: string | undefined;
    let pendingInterrupt:
      | {
          requestId: string;
          commandId: string;
          resolve(): void;
          reject(error: Error): void;
          timer: NodeJS.Timeout;
        }
      | undefined;
    let resolveInitialized: (() => void) | undefined;
    let rejectInitialized: ((error: Error) => void) | undefined;
    const pendingCommands = new Map<string, string>();
    const pendingRequests = new Map<string, JsonRecord>();
    const activeTools = new Set<string>();
    const publish = (event: NativeEventInput) => emit({ commandId, turnId, ...event });
    const finishTurn = (data: JsonRecord = {}) => {
      if (!turnStarted && !commandId) return;
      publish({
        type: 'turn.completed',
        status:
          interruptedCommandId !== undefined && interruptedCommandId === commandId
            ? 'interrupted'
            : data.isError === true
              ? 'failed'
              : data.subtype === 'interrupted'
                ? 'interrupted'
                : 'completed',
        data,
      });
      turnId = undefined;
      interruptedCommandId = undefined;
      turnStarted = false;
      commandId = undefined;
      activeTools.clear();
    };
    const startTurn = (nativeId?: string) => {
      if (turnStarted) return;
      turnStarted = true;
      turnId = nativeId;
      publish({ type: 'turn.started', nativeId });
    };

    let process: JsonLineProcess;
    const failStartup = (error: Error) => {
      if (protocolFailure) return;
      protocolFailure = error;
      if (!initialized) rejectInitialized?.(error);
      publish({ type: 'error', status: 'failed', text: error.message });
    };
    const onMessage = (message: JsonRecord) => {
      if (protocolFailure) return;
      // Resume startup hooks use a temporary process session before loading the
      // saved conversation. Only conversation events bind its native identity.
      const conversationEvent =
        ['user', 'assistant', 'stream_event', 'result', 'control_request'].includes(
          String(message.type),
        ) ||
        (message.type === 'system' && message.subtype === 'init');
      const sessionId =
        conversationEvent && typeof message.session_id === 'string'
          ? message.session_id
          : undefined;
      if (sessionId) {
        if (nativeSessionId !== sessionId) {
          failStartup(new Error('Claude reported a different native session identity'));
          process.child.kill();
          return;
        }
        if (!identityConfirmed) {
          identityConfirmed = true;
          publish({
            type: 'session.started',
            nativeId: nativeSessionId,
            data: { identityConfirmed: true },
          });
        }
      }

      if (message.type === 'control_response') {
        const response = record(message.response);
        if (pendingInterrupt && response.request_id === pendingInterrupt.requestId) {
          const pending = pendingInterrupt;
          pendingInterrupt = undefined;
          clearTimeout(pending.timer);
          if (response.subtype === 'success') {
            // This CLI reports an interrupted result as success. Only its native
            // control acknowledgement for the still-active turn authorizes the mapping.
            if (commandId === pending.commandId) interruptedCommandId = pending.commandId;
            pending.resolve();
          } else {
            pending.reject(new Error('Claude rejected the interrupt request'));
          }
          return;
        }
        if (response.request_id === 'farmslot-initialize') {
          if (response.subtype === 'success') {
            initialized = true;
            resolveInitialized?.();
          } else {
            rejectInitialized?.(new Error('Claude rejected stream-json initialization'));
          }
        }
        return;
      }

      if (message.type === 'control_request') {
        const requestId = typeof message.request_id === 'string' ? message.request_id : undefined;
        if (!requestId) {
          publish({ type: 'error', text: 'Claude sent a control request without an id' });
          return;
        }
        const request = record(message.request);
        const subtype = request.subtype;
        if (subtype === 'can_use_tool') {
          pendingRequests.set(requestId, request);
          const toolName = typeof request.tool_name === 'string' ? request.tool_name : undefined;
          const input = record(request.input);
          const toolUseId =
            typeof request.tool_use_id === 'string' ? request.tool_use_id : undefined;
          if (toolName === 'AskUserQuestion') {
            const questions = Array.isArray(input.questions)
              ? input.questions.map(record).flatMap((question) =>
                  typeof question.question === 'string'
                    ? [
                        {
                          // Claude's native handler indexes answers by the question text.
                          id: question.question,
                          prompt: question.question,
                          options: Array.isArray(question.options)
                            ? question.options.map(record).flatMap((option) =>
                                typeof option.label === 'string'
                                  ? [
                                      {
                                        label: option.label,
                                        ...(typeof option.description === 'string'
                                          ? { description: option.description }
                                          : {}),
                                      },
                                    ]
                                  : [],
                              )
                            : [],
                          multiSelect: question.multiSelect === true,
                        },
                      ]
                    : [],
                )
              : [];
            publish({
              type: 'question.requested',
              nativeId: requestId,
              request: { id: requestId, title: 'Answer runner questions', questions },
              data: { toolName, input, toolUseId },
            });
          } else {
            publish({
              type: 'approval.requested',
              nativeId: requestId,
              request: {
                id: requestId,
                title: 'Allow runner action?',
                detail: typeof input.command === 'string' ? input.command : toolName,
              },
              data: { toolName, input, toolUseId },
            });
          }
          return;
        }
        // A host must not grant control operations it has not implemented.
        process.write({
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: requestId,
            error: `Unsupported Claude control request: ${String(subtype)}`,
          },
        });
        publish({ type: 'error', text: `Unsupported Claude control request: ${String(subtype)}` });
        return;
      }

      if (message.type === 'user') {
        const replayedText = textContent(record(message.message).content);
        if (replayedText) {
          const acceptedCommandId = pendingCommands.get(replayedText);
          if (acceptedCommandId) {
            pendingCommands.delete(replayedText);
            commandId = acceptedCommandId;
            publish({ type: 'command.accepted', commandId: acceptedCommandId, text: replayedText });
          }
        }
        for (const result of toolResultBlocks(record(message.message).content)) {
          const toolId = typeof result.tool_use_id === 'string' ? result.tool_use_id : undefined;
          if (toolId && activeTools.delete(toolId)) {
            publish({
              type: 'tool.completed',
              nativeId: toolId,
              tool: {
                name: 'Claude tool',
                output: result.content,
                status: result.is_error === true ? 'failed' : 'completed',
              },
              data: result,
            });
          }
        }
        return;
      }

      if (message.type === 'stream_event') {
        const event = record(message.event);
        if (event.type === 'message_start') {
          const eventMessage = record(event.message);
          startTurn(typeof eventMessage.id === 'string' ? eventMessage.id : undefined);
        }
        if (event.type === 'content_block_delta') {
          const delta = record(event.delta);
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            startTurn();
            publish({
              type: 'text.delta',
              nativeId: typeof event.index === 'number' ? String(event.index) : undefined,
              text: delta.text,
            });
          }
        }
        return;
      }

      if (message.type === 'assistant') {
        startTurn();
        const assistant = record(message.message);
        for (const tool of toolUseBlocks(assistant.content)) {
          const toolId = typeof tool.id === 'string' ? tool.id : undefined;
          if (toolId && !activeTools.has(toolId)) {
            activeTools.add(toolId);
            publish({
              type: 'tool.started',
              nativeId: toolId,
              tool: {
                name: typeof tool.name === 'string' ? tool.name : 'Claude tool',
                input: tool.input,
              },
              data: tool,
            });
          }
        }
        return;
      }

      if (message.type === 'result') {
        if (message.is_error === true) {
          const errors = Array.isArray(message.errors)
            ? message.errors.filter((error): error is string => typeof error === 'string')
            : [];
          publish({
            type: 'error',
            text:
              (typeof message.result === 'string' && message.result) ||
              errors.join('\n') ||
              'Native runner reported a failed turn',
            data: { subtype: message.subtype },
          });
        }
        finishTurn({ subtype: message.subtype, isError: message.is_error });
      }
    };

    process = new JsonLineProcess(
      options.executable,
      [
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--replay-user-messages',
        '--permission-prompt-tool',
        'stdio',
        ...(options.model ? ['--model', options.model] : []),
        ...(options.resumeSessionId
          ? ['--resume', options.resumeSessionId]
          : ['--session-id', nativeSessionId]),
      ],
      options,
      onMessage,
      (error, processStopped) => {
        if (pendingInterrupt) {
          clearTimeout(pendingInterrupt.timer);
          pendingInterrupt.reject(
            error ?? new Error('Claude closed before interrupt acknowledgement'),
          );
          pendingInterrupt = undefined;
        }
        if (closed) return;
        const failure =
          protocolFailure ??
          (error || !initialized
            ? (error ?? new Error('Claude closed before initialization'))
            : undefined);
        if (!initialized)
          rejectInitialized?.(failure ?? new Error('Claude closed before initialization'));
        closed = true;
        publish({
          type: 'session.closed',
          ...(failure ? { status: 'failed' } : {}),
          data: { processStopped, ...(failure ? { error: failure.message } : {}) },
        });
      },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        resolveInitialized = resolve;
        rejectInitialized = reject;
        const timeout = setTimeout(
          () => reject(new Error('Claude stream-json initialization timed out')),
          30_000,
        );
        resolveInitialized = () => {
          clearTimeout(timeout);
          resolve();
        };
        rejectInitialized = (error) => {
          clearTimeout(timeout);
          reject(error);
        };
        process.write({
          type: 'control_request',
          request_id: 'farmslot-initialize',
          request: { subtype: 'initialize', hooks: null },
        });
      });
      if (!nativeSessionId)
        throw new Error('Claude did not provide a native session id during initialization');
      if (options.resumeSessionId && nativeSessionId !== options.resumeSessionId) {
        throw new Error('Claude resumed a different native session');
      }
      if (!identityConfirmed)
        publish({
          type: 'session.started',
          nativeId: nativeSessionId,
          data: { identityConfirmed: false },
        });
    } catch (error) {
      await process.close();
      throw error;
    }

    return {
      nativeSessionId,
      async send(text, id) {
        if (!text) throw new Error('Claude prompt must not be empty');
        // Correlation is assigned before writing. Native replay may arrive after
        // tool requests and streamed output, so send must not wait for that replay.
        commandId = id;
        pendingCommands.set(text, id);
        try {
          process.write({ type: 'user', message: { role: 'user', content: text } });
        } catch (error) {
          pendingCommands.delete(text);
          commandId = undefined;
          throw error;
        }
      },
      async respond(requestId: string, response: NativeSessionResponse) {
        const request = pendingRequests.get(requestId);
        if (!request) throw new Error('Native request is stale or belongs to another session');
        const toolName = typeof request.tool_name === 'string' ? request.tool_name : undefined;
        if (toolName === 'AskUserQuestion') {
          if (!response.answers) throw new Error('Question response requires answers');
          const input = record(request.input);
          const answers: Record<string, string | string[]> = {};
          for (const rawQuestion of Array.isArray(input.questions) ? input.questions : []) {
            const question = record(rawQuestion);
            if (typeof question.question !== 'string') continue;
            const selected = response.answers[question.question];
            if (!selected || selected.length === 0) continue;
            answers[question.question] = question.multiSelect === true ? selected : selected[0]!;
          }
          process.write({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: requestId,
              response: { behavior: 'allow', updatedInput: { ...input, answers } },
            },
          });
        } else {
          if (!response.decision) throw new Error('Approval response requires a decision');
          process.write({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: requestId,
              response:
                response.decision === 'approve'
                  ? { behavior: 'allow', updatedInput: request.input }
                  : { behavior: 'deny', message: 'User declined tool execution.' },
            },
          });
        }
        pendingRequests.delete(requestId);
        publish({
          type: 'approval.resolved',
          nativeId: requestId,
          data: { decision: response.decision, answers: response.answers },
        });
      },
      async interrupt() {
        if (!commandId) throw new Error('No active native turn to interrupt');
        if (pendingInterrupt) throw new Error('Claude interrupt acknowledgement is pending');
        const interruptedId = commandId;
        await new Promise<void>((resolve, reject) => {
          const requestId = `farmslot-interrupt:${interruptedId}`;
          const timer = setTimeout(() => {
            pendingInterrupt = undefined;
            reject(new Error('Claude interrupt acknowledgement timed out'));
          }, 30_000);
          pendingInterrupt = { requestId, commandId: interruptedId, resolve, reject, timer };
          try {
            process.write({
              type: 'control_request',
              request_id: requestId,
              request: { subtype: 'interrupt' },
            });
          } catch (error) {
            clearTimeout(timer);
            pendingInterrupt = undefined;
            reject(error);
          }
        });
      },
      async close() {
        if (closed) return;
        await process.close();
      },
    };
  },
};
