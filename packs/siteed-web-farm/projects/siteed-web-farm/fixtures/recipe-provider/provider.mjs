import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(new URL('../recipe-tools/package.json', import.meta.url));
const { createPlainWebAdapter } = await import(
  pathToFileURL(require.resolve('@farmslot/adapter-web/plain-web')).href
);

export function createProvider() {
  return {
    runtime: createPlainWebAdapter({
      manifestPath: fileURLToPath(new URL('./web.action-manifest.json', import.meta.url)),
      url() {
        const port = Number(process.env.RECIPE_WATCHER_PORT ?? process.env.WATCHER_PORT);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          throw new Error('Use the assigned website --watcher-port.');
        return `http://127.0.0.1:${port}/`;
      },
      devServer: {
        label: 'Next.js',
        describe: () => 'The prepared siteed-web sandbox',
        stop: () => ({
          kind: 'headless',
          message: 'The slot owns the sandbox server.',
          userAction: 'Use slot teardown to stop it.',
        }),
      },
    }),
  };
}
