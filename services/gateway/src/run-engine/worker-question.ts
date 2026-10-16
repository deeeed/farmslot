// A worker blocked on its own question or approval request waits for a person.
// The monitor hands the run to the operator with the question instead of
// nudging or calling it stuck.

import type { NativeSessionEvent } from '@farmslot/protocol';

/** Resolution recorded when the question closes and monitoring resumes. */
export const WORKER_QUESTION_CLOSED_ACTION = 'question-closed';

/** Readable text for a native worker's pending approval or question requests. */
export function nativePendingRequestText(requests: readonly NativeSessionEvent[]): string | null {
  if (!requests.length) return null;
  const text = requests
    .map(({ request }) =>
      [
        request?.title,
        request?.detail,
        ...(request?.questions ?? []).flatMap((question) => [
          question.prompt,
          ...question.options.map(
            (option) => `- ${option.label}${option.description ? `: ${option.description}` : ''}`,
          ),
        ]),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean)
    .join('\n\n');
  return text || 'The worker is waiting on a request without details.';
}

/**
 * Record this poll's open question. A pane question must show on two
 * consecutive polls before it counts; a native request is structured and
 * counts at once. Returns the question to hand off, or null.
 */
export function trackOpenQuestion(
  state: { openQuestion?: { text: string; polls: number } },
  question: string | null,
  structured = false,
): string | null {
  if (question === null) {
    state.openQuestion = undefined;
    return null;
  }
  const polls = structured ? 2 : (state.openQuestion?.polls ?? 0) + 1;
  state.openQuestion = { text: question, polls };
  return polls >= 2 ? question : null;
}

export function workerQuestionHandoffDescription(question: string): string {
  const fence = question.includes('```') ? '~~~' : '```';
  return [
    'The worker asked a question and is waiting for an answer. Answer it in the worker session; monitoring resumes when the question closes.',
    '',
    `${fence}text`,
    question.trimEnd(),
    fence,
  ].join('\n');
}
