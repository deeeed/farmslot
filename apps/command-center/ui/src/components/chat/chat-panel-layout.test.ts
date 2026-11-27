import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { litText } from '../../testing/lit-text.js';

mock.module('./native-session-view.js', { namedExports: {} });
mock.module('./chat-message.js', { namedExports: {} });
mock.module('../shared/review-dispatch-picker.js', { namedExports: {} });
mock.module('./native-session-observation.js', {
  namedExports: { observeNativeArchiveResource: () => () => undefined },
});
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      connectionState: 'connected',
      authenticatedConnection: { capabilities: { conversationStreaming: 1 } },
    },
  },
});
mock.module('../../resource-cache.js', {
  namedExports: {
    getResourceCache: () => undefined,
    getResourceWorkspaceKey: () => 'scope',
    getResourceWorkspaceAccess: () => 'farm',
    subscribeResourceCache: () => () => undefined,
  },
});
mock.module('../../utils/url-state.js', {
  namedExports: {
    hashParams: () => new URLSearchParams('copilotTarget=copilot'),
    navigateHash: () => undefined,
    buildHash: () => '#copilot',
    hashRoute: () => 'copilot',
  },
});

const { ChatPanel } = await import('./chat-panel.js');

test('the Co-Pilot panel scrolls as a whole and keeps a usable conversation when controls crowd it', () => {
  const panel = new ChatPanel();
  panel.open = true;
  const text = litText(panel.render());
  const host = /chat-panel \{([^}]*)\}/.exec(text)?.[1] ?? '';
  assert.match(host, /min-height: 0;/);
  assert.match(host, /overflow-y: auto;/);
  assert.match(text, /chat-panel > :not\(native-session-view\) \{\s*flex: none;\s*\}/);
  assert.match(text, /chat-panel native-session-view \{\s*flex: 1 1 0;\s*min-height: 560px;\s*\}/);
});
