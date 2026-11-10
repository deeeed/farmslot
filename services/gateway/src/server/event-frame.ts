import type { EventFrame } from '@farmslot/protocol';

/** An event payload already serialized as JSON, so a fan-out serializes it once for every recipient. */
export class SerializedPayload {
  constructor(readonly json: string) {}
}

/** The text of an event frame; a serialized payload is written into it unchanged. */
export function eventFrameText(event: string, payload: unknown, seq: number): string {
  if (payload instanceof SerializedPayload)
    return `{"type":"event","event":${JSON.stringify(event)},"payload":${payload.json},"seq":${seq}}`;
  const frame: EventFrame = { type: 'event', event, payload, seq };
  return JSON.stringify(frame);
}
