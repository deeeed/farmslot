// Farmslot Command Center — UI entry point

// Register components (side-effect imports)
import './components/app-shell.js';

import { requestPermission } from './utils/notifications.js';
import { gateway } from './gateway-client.js';
import { initState } from './state.js';

// Wire up state management to gateway events
initState();

// Request browser notification permission (non-blocking)
requestPermission();

// Connect to the gateway
gateway.connect();
