const { build } = require('../package.json');

module.exports = {
  ...build,
  appId: 'io.farmslot.command-center.dev',
  productName: 'Farmslot Dev',
  extraMetadata: { desktopProfile: 'development' },
  directories: { output: 'release-dev' },
  mac: { ...build.mac, icon: 'build/icon-dev.png' },
  artifactName: 'Farmslot-Dev-${version}-${arch}.${ext}',
  protocols: [{ name: 'Farmslot Dev links', schemes: ['farmslot-dev'] }],
};
