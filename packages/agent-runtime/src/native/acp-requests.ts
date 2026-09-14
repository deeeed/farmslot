import type { NativeSessionResponse } from '@farmslot/protocol';

import { type AcpObject, acpObject, acpString } from './acp-rpc.js';
import type { NativeEventInput } from './types.js';

export interface AcpPendingRequest {
  event: NativeEventInput;
  response(value: NativeSessionResponse): AcpObject;
}

export function acpPermission(
  params: AcpObject,
  previous?: NativeEventInput['tool'],
): AcpPendingRequest {
  const tool = acpObject(params.toolCall);
  if (!Array.isArray(params.options)) throw new Error('ACP permission options are missing');
  const options = params.options.map(acpObject);
  const title =
    typeof tool.title === 'string' ? tool.title : (previous?.name ?? 'Allow runner action?');
  const input = tool.rawInput ?? previous?.input;
  return {
    event: {
      type: 'approval.requested',
      request: {
        id: '',
        title,
        detail: JSON.stringify(input ?? tool.content ?? []),
        tool: { name: title, input },
      },
      data: { toolCall: tool, options },
    },
    response(value) {
      if (!value.decision) throw new Error('Approval response requires a decision');
      // Always grant only this operation. Session-wide grants exceed this response's scope.
      const option = options.find(
        (option) => option.kind === (value.decision === 'approve' ? 'allow_once' : 'reject_once'),
      );
      if (!option) {
        if (value.decision === 'deny') return { outcome: { outcome: 'cancelled' } };
        throw new Error('Runner did not offer a one-time permission grant');
      }
      return { outcome: { outcome: 'selected', optionId: acpString(option.optionId) } };
    },
  };
}

/** Documented Cursor ACP extensions; no credential or agent-loop implementation. */
export function cursorRequest(method: string, params: AcpObject): AcpPendingRequest | undefined {
  if (method === 'cursor/create_plan')
    return {
      event: {
        type: 'approval.requested',
        request: {
          id: '',
          title: typeof params.name === 'string' ? params.name : 'Approve plan',
          detail: acpString(params.plan),
        },
        data: params,
      },
      response(value) {
        if (!value.decision) throw new Error('Plan approval requires a decision');
        return { outcome: { outcome: value.decision === 'approve' ? 'accepted' : 'rejected' } };
      },
    };
  if (method !== 'cursor/ask_question') return;
  if (!Array.isArray(params.questions)) throw new Error('Cursor questions are missing');
  const questions = params.questions.map((raw) => {
    const q = acpObject(raw);
    if (!Array.isArray(q.options)) throw new Error('Cursor question options are missing');
    const options = q.options.map((raw) => {
      const option = acpObject(raw);
      return { id: acpString(option.id), label: acpString(option.label) };
    });
    if (new Set(options.map((option) => option.label)).size !== options.length)
      throw new Error('Cursor question option labels are ambiguous');
    return {
      id: acpString(q.id),
      prompt: acpString(q.prompt),
      multiSelect: q.allowMultiple === true,
      options,
    };
  });
  return {
    event: {
      type: 'question.requested',
      request: {
        id: '',
        title: typeof params.title === 'string' ? params.title : 'Answer runner questions',
        questions,
      },
      data: params,
    },
    response(value) {
      if (!value.answers) throw new Error('Question response requires answers');
      return {
        outcome: {
          outcome: 'answered',
          answers: questions.map((q) => {
            const selected = value.answers![q.id];
            if (!selected?.length || (!q.multiSelect && selected.length !== 1))
              throw new Error('Each question requires a valid selection');
            return {
              questionId: q.id,
              selectedOptionIds: selected.map((label) => {
                const option = q.options.find((option) => option.label === label);
                if (!option) throw new Error('Unknown question option');
                return option.id;
              }),
            };
          }),
        },
      };
    },
  };
}
