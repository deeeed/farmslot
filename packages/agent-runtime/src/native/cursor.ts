import { createAcpAdapter } from './acp.js';
import { cursorRequest } from './acp-requests.js';

export const cursorNativeAdapter = createAcpAdapter({
  authMethod: 'cursor_login',
  defaultModeId: 'agent',
  args(options) {
    if (options.effort) throw new Error('Cursor effort must be configured in the native model ID');
    return [
      ...(options.safetyTier && options.safetyTier !== 'sandboxed' ? ['--force'] : []),
      'acp',
    ];
  },
  modes: ['default'],
  extensionRequest: cursorRequest,
});
