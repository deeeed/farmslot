const { AndroidConfig, withAndroidManifest, withGradleProperties } = require('expo/config-plugins');

/**
 * Keep native development builds aligned with the companion Metro port.
 * Android reads reactNativeDevServerPort from gradle.properties. iOS is
 * launched with RCT_METRO_PORT by scripts/agentic/run-ios.sh, matching the
 * Expo dev-client workflow.
 *
 * Also applies generic Android network policy that must survive prebuild.
 */
module.exports = function withMetroPort(
  config,
  { port = 7677, usesCleartextTraffic = false } = {},
) {
  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort <= 0) {
    throw new Error(`withMetroPort expected a positive integer port, received: ${port}`);
  }

  config = withGradleProperties(config, (config) => {
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

  if (!usesCleartextTraffic) return config;
  return withAndroidManifest(config, (config) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    application.$['android:usesCleartextTraffic'] = 'true';
    application.$['tools:replace'] = mergeToolsReplace(
      application.$['tools:replace'],
      'android:usesCleartextTraffic',
    );
    return config;
  });
};

function mergeToolsReplace(existing, value) {
  const values = new Set(
    String(existing || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  values.add(value);
  return [...values].join(',');
}
