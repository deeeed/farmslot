const { withGradleProperties } = require('expo/config-plugins');

/**
 * Keep native development builds aligned with the companion Metro port.
 * Android reads reactNativeDevServerPort from gradle.properties. iOS is
 * launched with RCT_METRO_PORT by scripts/agentic/run-ios.sh, matching the
 * Expo dev-client workflow.
 */
module.exports = function withMetroPort(config, { port = 7677 } = {}) {
  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort <= 0) {
    throw new Error(`withMetroPort expected a positive integer port, received: ${port}`);
  }
  return withGradleProperties(config, (config) => {
    const portString = String(normalizedPort);
    config.modResults = config.modResults.filter(
      (item) => item.type !== 'property' || item.key !== 'reactNativeDevServerPort',
    );
    config.modResults.push({
      type: 'property',
      key: 'reactNativeDevServerPort',
      value: portString,
    });
    return config;
  });
};
