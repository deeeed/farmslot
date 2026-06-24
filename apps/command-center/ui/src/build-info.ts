declare const __FARMSLOT_APP_VERSION__: string;

/** Semver from `@farmslot/command-center-ui` package.json (injected at build time). */
export const COMMAND_CENTER_APP_VERSION =
  typeof __FARMSLOT_APP_VERSION__ !== 'undefined' ? __FARMSLOT_APP_VERSION__ : 'dev';
