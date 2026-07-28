const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const { createMetroRecipeBridgeMiddleware } = require('./metro-recipe-bridge.cjs');

const projectRoot = __dirname;
const protocolRoot = path.resolve(projectRoot, '../../packages/protocol');
const configuredMetroPort = process.env.METRO_PORT;
const metroPort = configuredMetroPort === undefined ? undefined : Number(configuredMetroPort);
const requiresConfiguredMetroPort = process.env.FARMSLOT_LOCAL_RUNTIME_CONFIG === '1';

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

function isProtocolModule(modulePath) {
  if (!modulePath) return false;
  return (
    modulePath.includes('@farmslot/protocol') ||
    modulePath.startsWith(protocolRoot + path.sep) ||
    modulePath.includes(`${path.sep}packages${path.sep}protocol${path.sep}`) ||
    modulePath.startsWith(`packages${path.sep}protocol${path.sep}`)
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
  // Rewrite .js imports to .ts for @farmslot/protocol (ESM convention)
  resolveRequest: (context, moduleName, platform) => {
    // For protocol internal .js imports — rewrite to .ts
    if (
      isProtocolModule(context.originModulePath) &&
      moduleName.startsWith('.') &&
      moduleName.endsWith('.js')
    ) {
      const tsName = moduleName.replace(/\.js$/, '.ts');
      return context.resolveRequest(context, tsName, platform);
    }
    return context.resolveRequest(context, moduleName, platform);
  },
};

module.exports = config;
