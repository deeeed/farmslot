const development = require('./development.cjs');

// A temporary Electron userData directory does not isolate macOS restore state.
// Validation must also have a bundle identity separate from the installed app.
module.exports = {
  ...development,
  appId: 'io.farmslot.command-center.validation',
  directories: { output: '../../temp/desktop-validation' },
};
