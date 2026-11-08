const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');

module.exports = function withSherpaPrebuilts(config) {
  // Expo config reads only register this action. Native prebuild runs it before EAS installs Pods.
  const acquire = (mod) => {
    execFileSync(
      process.execPath,
      [path.join(__dirname, '../scripts/install-sherpa-prebuilts.mjs')],
      {
        stdio: 'inherit',
      },
    );
    return mod;
  };
  for (const platform of ['ios', 'android']) config = withDangerousMod(config, [platform, acquire]);
  return config;
};
