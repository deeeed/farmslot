import { html, nothing } from 'lit';

import type {
  NativeSessionEvent,
  NativeSessionInfo,
  NativeSessionResponse,
} from '@farmslot/protocol';

interface NativeSessionRequestContext {
  event: NativeSessionEvent;
  disabled: boolean;
  session?: NativeSessionInfo;
  connected: boolean;
  answer(form: HTMLFormElement): void;
  respond(response: NativeSessionResponse): void;
}

export function renderNativeSessionRequest(ctx: NativeSessionRequestContext) {
  const event = ctx.event;
  const request = event.request;
  if (!request) return nothing;
  const disabled = ctx.disabled;
  return html`<div class="request" data-request-id=${request.id}>
    <h3>${request.title}</h3>
    ${request.detail ? html`<pre>${request.detail}</pre>` : nothing}
    ${request.tool
      ? html`<div data-testid="native-request-tool">
          <strong>${request.tool.name}</strong>
          <pre>${JSON.stringify(request.tool.input, null, 2)}</pre>
        </div>`
      : nothing}
    ${event.type === 'approval.requested' && event.data
      ? html`<details open>
          <summary>Action details</summary>
          <pre>${JSON.stringify(event.data, null, 2)}</pre>
        </details>`
      : nothing}
    ${event.type === 'question.requested'
      ? html`<form
          @submit=${(e: SubmitEvent) => {
            e.preventDefault();
            ctx.answer(e.currentTarget as HTMLFormElement);
          }}
        >
          ${(request.questions ?? []).map(
            (question) =>
              html`<fieldset ?disabled=${disabled}>
                <legend>${question.prompt}</legend>
                ${question.options.map(
                  (option) =>
                    html`<label
                      ><input
                        type=${question.multiSelect ? 'checkbox' : 'radio'}
                        name=${question.id}
                        value=${option.label}
                      />${option.label}${option.description
                        ? ` · ${option.description}`
                        : ''}</label
                    >`,
                )}
                <label
                  >Custom answer<input
                    type="text"
                    name=${`free:${question.id}`}
                    aria-label=${`Custom answer: ${question.prompt}`}
                /></label>
              </fieldset>`,
          )}<button ?disabled=${disabled || !ctx.session?.capabilities.questions} type="submit">
            Send answers
          </button>
        </form>`
      : html`<div class="actions">
          <button
            data-testid="native-approve"
            ?disabled=${disabled || !ctx.session?.capabilities.approvals}
            @click=${() => ctx.respond({ decision: 'approve' })}
          >
            Approve
          </button>
          <button
            data-testid="native-deny"
            ?disabled=${disabled || !ctx.session?.capabilities.approvals}
            @click=${() => ctx.respond({ decision: 'deny' })}
          >
            Deny
          </button>
        </div>`}
    ${disabled && ctx.connected
      ? html`<p class="meta">
          Response pending or outcome unknown. Reconnecting never resends an answer.
        </p>`
      : nothing}
  </div>`;
}
