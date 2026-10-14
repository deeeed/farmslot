// Keep the host's page/action bindings while preferring the owned browser window.
import { captureHelperSnapshot } from '@farmslot/recipe-runner';

/**
 * @param {import('@farmslot/adapter-sdk').AdapterActions} actions
 * @param {import('@farmslot/adapter-sdk').AdapterRecording} recording
 * @returns {import('@farmslot/adapter-sdk').AdapterActions}
 */
export function browserWindowScreenshots(actions, recording) {
  const ui = actions.ui;
  if (!ui) return actions;
  return {
    ...actions,
    ui(harness, options) {
      return ui.call(
        actions,
        {
          ...harness,
          createCdpWebUiTransport(config) {
            return harness.createCdpWebUiTransport({
              ...config,
              screenshotProvider: {
                name: 'capture-helper',
                async capture({ context }) {
                  return captureHelperSnapshot(await recording.target(context));
                },
              },
            });
          },
        },
        options,
      );
    },
  };
}
