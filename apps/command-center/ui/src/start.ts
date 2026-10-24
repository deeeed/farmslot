// Farmslot Command Center — UI entry point

// Register components (side-effect imports)
import './components/app-shell.js';
import './components/resource-store-notice.js';

import { requestPermission } from './utils/notifications.js';
import { initializeDesktopAttention } from './desktop-attention.js';
import { gateway } from './gateway-client.js';
import { initializeResourceCache } from './resource-cache.js';
import { initState, onWorkspaceOwnerChange } from './state.js';

// Wire up state management to gateway events
initializeResourceCache();
initState();
document.body.append(document.createElement('farm-resource-store-notice'));
initializeDesktopAttention();

// Tear down principal-owned views when the account changes. Pending reads may settle
// after disconnect, but their old components cannot render into the new workspace.
// A transient disconnect keeps the views mounted.
onWorkspaceOwnerChange(() => {
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
