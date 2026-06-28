const { getDefaultConfig } = require('expo/metro-config');
const fs = require('fs');
const path = require('path');

const { createMetroRecipeBridgeMiddleware } = require('./metro-recipe-bridge.cjs');

const projectRoot = __dirname;
const protocolRoot = path.resolve(projectRoot, '../../packages/protocol');

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
  port: 7677,
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
    // Companion must bundle protocol from dist — src/portable-bundle pulls node:path.
    if (moduleName === '@farmslot/protocol') {
      return {
        filePath: path.join(protocolRoot, 'dist/index.js'),
        type: 'sourceFile',
      };
    }
    if (moduleName.startsWith('@farmslot/protocol/')) {
      const subpath = moduleName.slice('@farmslot/protocol/'.length);
      return {
        filePath: path.join(protocolRoot, 'dist', `${subpath}.js`),
        type: 'sourceFile',
      };
    }
    if (
      context.originModulePath?.includes(`${path.sep}packages${path.sep}protocol${path.sep}dist${path.sep}`) &&
      moduleName.startsWith('.')
    ) {
      const candidate = path.resolve(path.dirname(context.originModulePath), moduleName);
      if (fs.existsSync(candidate)) {
        return { filePath: candidate, type: 'sourceFile' };
      }
    }
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
