import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(new URL('../recipe-tools/package.json', import.meta.url));
const { createPlainWebAdapter } = await import(
  pathToFileURL(require.resolve('@farmslot/adapter-web/plain-web')).href
);

export function createProvider(context) {
  const cdp = context?.ports?.cdp?.value ?? context?.slot?.ports?.metro_port;
  const application = context?.ports?.watcher?.value ?? context?.slot?.ports?.port;
  if (cdp !== undefined) process.env.RECIPE_CDP_PORT = String(cdp);
  if (application !== undefined) process.env.RECIPE_WATCHER_PORT = String(application);
  return {
    runtime: createPlainWebAdapter({
      manifestPath: fileURLToPath(new URL('./web.action-manifest.json', import.meta.url)),
      url() {
        const port = Number(process.env.RECIPE_WATCHER_PORT ?? process.env.WATCHER_PORT);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          throw new Error('Use the assigned website --watcher-port.');
        return `http://127.0.0.1:${port}/`;
      },
      serverLabel: JSON.parse(readFileSync(new URL('./web-project.json', import.meta.url), 'utf8'))
        .serverLabel,
    }),
  };
}
