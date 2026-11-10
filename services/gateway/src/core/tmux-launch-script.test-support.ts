import { buildLaunchCommand, wrapWorkerShellCommand } from '../runners/launch-command.js';

import type { SlotVars } from './config.js';

/** Public-safe paths and environment typical of a pinned recipe worker. */
export function syntheticPiLaunch(vars: SlotVars): string {
  const farm = '/tmp/synthetic-farm';
  const revision = '0123456789abcdef'.repeat(4);
  const libraries = [
    'framework',
    'runner',
    'mobile',
    'extension',
    'shared',
    'qa',
    'browser',
    'devices',
    'auth',
    'accounts',
    'perps',
    'transactions',
    'notifications',
    'settings',
    'network',
    'hardware',
    'permissions',
    'routing',
    'accessibility',
    'performance',
  ];
  const worker = {
    ...vars,
    machineEnv: {
      FARMSLOT_HOME: farm,
      FARMSLOT_POOL_DIR: `${farm}/config/pool`,
      FARMSLOT_PROJECTS_DIR: `${farm}/config/projects`,
      FARMSLOT_RUNS_DIR: `${farm}/state/runs`,
      NODE_EXTRA_CA_CERTS: `${farm}/config/certificates/synthetic-ca.pem`,
      PATH: [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        `${farm}/code/bin`,
        `${farm}/tools/node/bin`,
        `${farm}/tools/java/bin`,
        `${farm}/tools/android/platform-tools`,
      ].join(':'),
    },
  };
  return wrapWorkerShellCommand(
    buildLaunchCommand(worker, 'pi', 'litellm/glm-5p3-flash', 'Synthetic task', {
      taskDir: `${farm}/state/runs/synthetic-run/task`,
      runtimeDir: '.agent',
      supportDir: `${farm}/code/support/${revision}`,
    }),
    {
      vars: worker,
      projectJson: {
        command_env: {
          set: {
            RECIPE_LIBRARY_PATH: libraries
              .map(
                (library) =>
                  `${farm}/state/sources/projects/demo/recipes/libraries/${library}/revisions/${revision}`,
              )
              .join(':'),
            SYNTHETIC_ENDPOINT: 'http://127.0.0.1:7777',
            SYNTHETIC_LABEL: "worker's synthetic environment",
          },
        },
      },
    },
  );
}
