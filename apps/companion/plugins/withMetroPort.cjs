const { AndroidConfig, withAndroidManifest, withGradleProperties } = require('expo/config-plugins');

/**
 * Keep native development builds aligned with the companion Metro port.
 * Android reads reactNativeDevServerPort from gradle.properties. iOS is
 * launched with RCT_METRO_PORT by scripts/agentic/run-ios.sh, matching the
 * Expo dev-client workflow.
 *
 * Also applies generic Android network policy that must survive prebuild.
 * Android cannot scope cleartext exceptions to arbitrary LAN IPs discovered at
 * runtime, so usesCleartextTraffic intentionally enables app-wide cleartext.
 * Companion still validates remote profiles separately: non-LAN/non-tailnet
 * remote profiles must use wss://.
 */
module.exports = function withMetroPort(config, { port, usesCleartextTraffic = false } = {}) {
  let normalizedPort;
  if (port !== undefined) {
    normalizedPort = Number(port);
    if (!Number.isInteger(normalizedPort) || normalizedPort <= 0 || normalizedPort > 65_535) {
      throw new Error(`withMetroPort expected a port from 1 to 65535, received: ${port}`);
    }
  }

  config = withGradleProperties(config, (config) => {
    config.modResults = updateMetroPortGradleProperties(config.modResults, normalizedPort);
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

function updateMetroPortGradleProperties(properties, port) {
  const updated = properties.filter(
    (item) => item.type !== 'property' || item.key !== 'reactNativeDevServerPort',
  );
  if (port !== undefined) {
    updated.push({
      type: 'property',
      key: 'reactNativeDevServerPort',
      value: String(port),
    });
  }
  return updated;
}

module.exports.updateMetroPortGradleProperties = updateMetroPortGradleProperties;

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
