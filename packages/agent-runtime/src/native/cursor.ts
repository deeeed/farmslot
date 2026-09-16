import { createAcpAdapter } from './acp.js';
import { cursorRequest } from './acp-requests.js';
import { configureCursorModel } from './cursor-model.js';

export const cursorNativeAdapter = createAcpAdapter({
  authMethod: 'cursor_login',
  clientCapabilities: { _meta: { parameterizedModelPicker: true } },
  configureModel: configureCursorModel,
  defaultModeId: 'agent',
  args(options) {
    if (options.effort) throw new Error('Cursor effort must be configured in the native model ID');
    return [
      ...(options.filesystemPolicy
        ? [
            '--trust',
            '--sandbox',
            'enabled',
            ...options.filesystemPolicy.writableRoots.flatMap((root) => ['--add-dir', root]),
          ]
        : []),
      ...(options.safetyTier && options.safetyTier !== 'sandboxed' ? ['--force'] : []),
      'acp',
    ];
  },
  modes: ['default'],
  extensionRequest: cursorRequest,
});
