import { notificationTray } from './utils/notification-tray.js';
import { getResourceWorkspaceKey } from './resource-cache.js';
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
    const owner = getResourceWorkspaceKey();
    void publish(value).then(
      () => {
        if (owner === getResourceWorkspaceKey()) notificationTray.clear('desktop-attention');
      },
      (error: unknown) => {
        last = '';
        notificationTray.set('desktop-attention', owner, [
          {
            id: 'desktop-attention',
            title: 'Could not update macOS menu bar',
            body: error instanceof Error ? error.message : String(error),
            route: '#doctor',
            needsYou: false,
            current: true,
          },
        ]);
      },
    );
  };
  update(getState());
  subscribe(update);
}
