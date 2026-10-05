'use strict';

const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendBlockList(blockList, pattern) {
  if (Array.isArray(blockList)) return [...blockList, pattern];
  return blockList instanceof RegExp ? [blockList, pattern] : [pattern];
}

function blockListFlags(blockList) {
  const first = Array.isArray(blockList) ? blockList[0] : blockList;
  return first instanceof RegExp && first.ignoreCase ? 'i' : '';
}

function resolveExpoConfigLoader(projectRoot) {
  const requireFromProject = createRequire(path.join(projectRoot, 'package.json'));
  let requireUtilsPath;
  try {
    requireUtilsPath = requireFromProject.resolve('@expo/require-utils');
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    return null;
  }
  const { loadModuleSync } = requireFromProject(requireUtilsPath);
  return typeof loadModuleSync === 'function' ? loadModuleSync : null;
}

async function loadProductConfig(configPath, baseConfig, projectRoot) {
  let loaded;
  const expoConfigLoader = resolveExpoConfigLoader(projectRoot);
  if (expoConfigLoader) {
    loaded = expoConfigLoader(configPath);
  } else {
    try {
      loaded = require(configPath);
    } catch (error) {
      if (error?.code !== 'ERR_REQUIRE_ESM') throw error;
      loaded = await import(pathToFileURL(configPath).href);
    }
  }

  const moduleValue = await loaded;
  const exported =
    moduleValue?.__esModule || moduleValue?.[Symbol.toStringTag] === 'Module'
      ? moduleValue.default
      : moduleValue;
  const config = await exported;
  return typeof config === 'function' ? config(baseConfig) : config;
}

module.exports = async function harnessMetroConfig(baseConfig) {
  const projectRoot = path.resolve(process.env.RECIPE_RN_METRO_PROJECT_ROOT || process.cwd());
  const productConfigPath = path.resolve(
    process.env.RECIPE_RN_METRO_BASE_CONFIG || path.join(projectRoot, 'metro.config.js'),
  );
  if (productConfigPath === __filename) {
    throw new Error(
      'RECIPE_RN_METRO_BASE_CONFIG must reference the product Metro config, not the harness wrapper.',
    );
  }
  let productConfig = baseConfig;
  if (fs.existsSync(productConfigPath)) {
    productConfig = await loadProductConfig(productConfigPath, baseConfig, projectRoot);
  }

  const tempRoot = path.join(projectRoot, 'temp');
  const existingBlockList = productConfig.resolver?.blockList ?? baseConfig.resolver?.blockList;
  const tempPattern = new RegExp(
    `^${escapeRegExp(tempRoot)}(?:${escapeRegExp(path.sep)}|$)`,
    blockListFlags(existingBlockList),
  );
  // Inline environment values affect transformed JavaScript. Keep separate
  // cache generations for those inputs instead of deleting the shared cache.
  const envFingerprint = process.env.RECIPE_RN_METRO_ENV_FINGERPRINT;
  return {
    ...productConfig,
    ...(envFingerprint
      ? { cacheVersion: `${productConfig.cacheVersion ?? ''}:mm-env:${envFingerprint}` }
      : {}),
    resolver: {
      ...productConfig.resolver,
      blockList: appendBlockList(existingBlockList, tempPattern),
    },
  };
};
