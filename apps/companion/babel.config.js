module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // Keep Reanimated last, as required by Reanimated Babel setup.
      'react-native-reanimated/plugin',
    ],
  };
};
