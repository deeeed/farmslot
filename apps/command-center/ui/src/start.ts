// Farmslot Command Center — UI entry point

// Register components (side-effect imports)
import './components/app-shell.js';

import { requestPermission } from './utils/notifications.js';
import { gateway } from './gateway-client.js';
import { initState } from './state.js';

// Wire up state management to gateway events
initState();

// Tear down principal-owned views on authentication changes. Pending reads may
// settle after disconnect, but their old components cannot render into the new workspace.
let workspaceIdentity = '';
gateway.onConnectionChange(() => {
  const identity = JSON.stringify([
    gateway.gatewayUrl,
    gateway.authenticatedPrincipalId,
    gateway.workspaceAccess,
  ]);
  if (identity === workspaceIdentity) return;
  workspaceIdentity = identity;
  if (gateway.workspaceAccess === 'native') history.replaceState(null, '', '#native');
  const current = document.querySelector('farm-app');
  current?.replaceWith(document.createElement('farm-app'));
});

// Request browser notification permission (non-blocking)
requestPermission();

// macOS can leave a socket looking open after sleep even though its transport died.
window.farmslotDesktop?.onResume(() => gateway.reconnect());

// Connect to the gateway
gateway.connect();
