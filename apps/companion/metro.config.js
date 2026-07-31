const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const { createMetroRecipeBridgeMiddleware } = require('./metro-recipe-bridge.cjs');
const { isProtocolSourceModule } = require('./metro-protocol-source.cjs');

// Always anchored to this file — independent of process.cwd() / launch folder.
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');
const protocolRoot = path.resolve(monorepoRoot, 'packages/protocol');
const originResolveBases = [projectRoot, monorepoRoot, protocolRoot, process.cwd()];
const configuredMetroPort = process.env.METRO_PORT;
const metroPort = configuredMetroPort ? Number(configuredMetroPort) : undefined;
const requiresConfiguredMetroPort =
  (process.env.APP_VARIANT || 'development') === 'development' &&
  process.env.FARMSLOT_LOCAL_RUNTIME_CONFIG === '1';

if (requiresConfiguredMetroPort && metroPort === undefined) {
  throw new Error(
    'METRO_PORT must come from the Farmslot slot/worktree configuration for development.',
  );
}
if (
  metroPort !== undefined &&
  (!Number.isInteger(metroPort) || metroPort <= 0 || metroPort > 65_535)
) {
  throw new Error(
    `METRO_PORT must be an integer from 1 to 65535, received: ${configuredMetroPort}`,
  );
}

function shouldRewriteProtocolJsImport(originModulePath, moduleName) {
  return (
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js') &&
    isProtocolSourceModule(originModulePath, protocolRoot, originResolveBases)
  );
}

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot);

// Isolated metro port
config.server = {
  ...config.server,
  ...(metroPort === undefined ? {} : { port: metroPort }),
  enhanceMiddleware: (middleware) => {
    const recipeBridge = createMetroRecipeBridgeMiddleware();
    return (req, res, next) => {
      if (recipeBridge.handle(req, res)) return;
      return middleware(req, res, next);
    };
  },
};

// Keep Expo's SDK 52+ workspace autodetection intact. It adds the monorepo
// root node_modules and workspace packages to Metro's watched file map; if we
// replace watchFolders/nodeModulesPaths here, Metro can resolve hoisted Expo
// files that it cannot hash.
config.resolver = {
  ...config.resolver,
  unstable_enablePackageExports: true,
  enablePackageExports: true,
  sourceExts: [...config.resolver.sourceExts, 'cjs', 'mjs'],
  // Rewrite .js imports to .ts for @farmslot/protocol source (ESM convention).
  // Nested deps under packages/protocol/node_modules are excluded; if a rewrite
  // still misses, fall back to the original .js so third-party packages work.
  resolveRequest: (context, moduleName, platform) => {
    if (shouldRewriteProtocolJsImport(context.originModulePath, moduleName)) {
      const tsName = moduleName.replace(/\.js$/, '.ts');
      try {
        return context.resolveRequest(context, tsName, platform);
      } catch {
        return context.resolveRequest(context, moduleName, platform);
      }
    }
    return context.resolveRequest(context, moduleName, platform);
  },
};

module.exports = config;
