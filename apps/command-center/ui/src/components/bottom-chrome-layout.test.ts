import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mock, test } from 'node:test';

// The cache status row and the transfer bar sit below the app in flow. As fixed overlays they
// covered the bottom of every view, including the Co-Pilot composer and its approval controls.
mock.module('@farmslot/local-store/browser', {
  namedExports: {
    browserResourceStoreDiagnostics: () => ({}),
    createBrowserSqliteResourceStore: async () => ({}),
  },
});
mock.module('../resource-cache.js', {
  namedExports: {
    getResourceCache: () => undefined,
    getResourceStoreMetadata: () => undefined,
    getResourceStoreNotice: () => '',
    getResourceWorkspaceKey: () => '',
    subscribeResourceCache: () => () => undefined,
  },
});
mock.module('../gateway-client.js', { namedExports: { gateway: {} } });

const { ResourceStoreNotice } = await import('./resource-store-notice.js');
const { FileTransferProgressBanner } = await import('./shared/file-transfer-progress-banner.js');

test('bottom status row and transfer bar never overlay the content', () => {
  for (const component of [ResourceStoreNotice, FileTransferProgressBanner]) {
    const css = [component.styles]
      .flat()
      .map((style) => String(style))
      .join('\n');
    assert.doesNotMatch(css, /position:\s*fixed/, `${component.name} must stay in flow`);
  }
  const index = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const rule = (selector: string) =>
    [...index.matchAll(new RegExp(`(?:^|\\n)\\s*${selector} \\{([^}]*)\\}`, 'g'))]
      .map((match) => match[1])
      .join(';');
  for (const declaration of [/display:\s*flex/, /flex-direction:\s*column/])
    assert.match(rule('body'), declaration);
  for (const declaration of [/flex:\s*1 1 0/, /min-height:\s*0/])
    assert.match(rule('farm-app'), declaration);
});
