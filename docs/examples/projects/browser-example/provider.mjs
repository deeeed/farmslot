// Attach shared UI actions to one operator-selected browser page. The provider owns no browser process.
import { fileURLToPath } from 'node:url';

import { ADAPTER_SDK_VERSION } from '@farmslot/adapter-sdk';
import { CdpWebPage, listCdpTargets } from '@farmslot/recipe-runner/runtime/cdp';

const unsupported =
  'This provider attaches to an existing page; manage its browser outside the recipe.';
const lifecycle = fileURLToPath(new URL('./lifecycle.mjs', import.meta.url));

export const providerCommands = ['run', 'call'].map((name) => ({
  name,
  example: `farmslot recipe ${name} --help`,
  contract: { options: { '--page-id': { kind: 'value' } } },
}));

export function createProvider(context) {
  // The host scopes environment changes; the plan digest binds this page as well as its CDP port.
  if (typeof context.options?.pageId === 'string') {
    process.env.RECIPE_CDP_PAGE_ID = context.options.pageId;
  }
  async function target() {
    const port = Number(context.options?.cdpPort ?? process.env.RECIPE_CDP_PORT);
    const pageId = process.env.RECIPE_CDP_PAGE_ID;
    if (!Number.isInteger(port) || port <= 0 || typeof pageId !== 'string' || !pageId) {
      throw new Error('Select an existing page with --cdp-port and --page-id.');
    }
    const match = (await listCdpTargets('127.0.0.1', port)).find(
      (page) => page.type === 'page' && page.id === pageId,
    );
    if (!match)
      throw new Error('The selected browser page is unavailable. Choose its current page ID.');
    return match;
  }

  return {
    runtime: {
      id: 'browser',
      sdkVersion: ADAPTER_SDK_VERSION,
      headless: false,
      resolveSlotPorts() {},
      async runtimeStatus() {
        await target();
        return { decision: 'ready', reasons: [] };
      },
      devServer: {
        label: 'external server',
        describe: () => 'The application server is managed separately',
        stop: () => ({
          kind: 'stopped',
          status: 0,
          summary: 'No server process is owned by this provider.',
        }),
      },
      logSources: () => [],
      appLogSource: () => null,
      hints: {
        launch: unsupported,
        relaunch: unsupported,
        runtimeProbeRecovery: () => unsupported,
      },
      harness: {
        install: { entry: lifecycle, fallback: lifecycle, node: true },
        cleanup: { entry: lifecycle, fallback: lifecycle, node: true },
        verify: () => ({ error: unsupported }),
      },
      runtimeContext: { forbiddenFields: [] },
      launch: async () => {
        throw new Error(unsupported);
      },
      actions: {
        manifestPath: () => fileURLToPath(new URL('./web.action-manifest.json', import.meta.url)),
        semantic: [],
        cdpTarget: { transport: 'cdp', probePath: '/json/version' },
        ui: ({ createCdpWebUiTransport }) => ({
          base: createCdpWebUiTransport({
            getPage: async () => CdpWebPage.connectToTarget(await target()),
          }),
        }),
      },
    },
  };
}
