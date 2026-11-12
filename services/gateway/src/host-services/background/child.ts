// Entry point of the gateway-background process (forked by client.ts): the request loop in
// serve.ts with the real operation handlers.
import { backgroundHandlers, COMMAND_OPERATIONS } from './handlers.js';
import { serveBackgroundRequests } from './serve.js';

serveBackgroundRequests(backgroundHandlers, COMMAND_OPERATIONS);
