// Evaluate before gateway stores. Lane scripts do not acquire this role by inheriting env.
import { registerGatewayStatusProcess } from './repo-root.js';

registerGatewayStatusProcess();
