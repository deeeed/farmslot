// Explicit operator readers can inspect status, but core writers still require the gateway role.
import { registerGatewayStatusReader } from './repo-root.js';

registerGatewayStatusReader();
