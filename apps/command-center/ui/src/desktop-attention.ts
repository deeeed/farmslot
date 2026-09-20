import { ATTENTION_ALERT_EVENT } from './utils/notifications.js';
import { getState, subscribe } from './state.js';

export function initializeDesktopAttention(): void {
  const publish = window.farmslotDesktop?.updateAttention;
  if (!publish) return;
  let last = '';
  const update = (state: ReturnType<typeof getState>) => {
    const value = {
      connected: state.connection === 'connected',
      ready: state.hydrated.decisions,
      decisions: state.decisions.length,
    };
    const key = JSON.stringify(value);
    if (key === last) return;
    last = key;
    void publish(value).catch((error: unknown) => {
      last = '';
      window.dispatchEvent(
        new CustomEvent(ATTENTION_ALERT_EVENT, {
          detail: {
            title: 'Could not update macOS menu bar',
            body: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    });
  };
  update(getState());
  subscribe(update);
}
