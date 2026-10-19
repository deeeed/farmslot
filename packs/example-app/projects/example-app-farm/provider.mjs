// A disposable note demonstrates project actions and provider-owned cleanup.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function createProvider(context) {
  const file = path.join(context.target.value, '.agent', 'recipe-example-note.txt');
  let owned = false;
  const observe = () => {
    const exists = fs.existsSync(file);
    return {
      exists,
      stdout: owned ? fs.readFileSync(file, 'utf8') : exists ? 'unowned' : 'absent',
    };
  };
  const cleanup = () => {
    if (owned) {
      fs.unlinkSync(file);
      owned = false;
    }
    return { stdout: fs.existsSync(file) ? 'present' : 'removed' };
  };
  return {
    runtime: {
      id: 'headless',
      targets: ['cli'],
      sdkVersion: 1,
      headless: true,
      resolveSlotPorts() {},
      runtimeStatus: async () => ({
        decision: 'ready',
        reasons: ['No long-running process is required.'],
      }),
      readiness: { readyIndicator: () => 'ready' },
      logSources: () => [],
      appLogSource: () => null,
      hints: {
        launch: 'Run the smoke recipe.',
        relaunch: 'Run the smoke recipe.',
        runtimeProbeRecovery: () => 'Run farmslot doctor --conformance.',
      },
      devServer: {
        label: 'none',
        describe: () => 'No server',
        stop: () => ({
          kind: 'headless',
          message: 'No server is owned.',
          userAction: 'Run the smoke recipe.',
        }),
      },
      harness: { verify: () => ({ error: 'This headless project needs no overlay.' }) },
      runtimeContext: { forbiddenFields: [] },
      launch: async ({ usage }) =>
        usage('This headless project has no app to launch.', 'Run farmslot recipe run smoke.'),
      actions: {
        manifestPath: () =>
          fileURLToPath(new URL('./manifests/headless.action-manifest.json', import.meta.url)),
        semantic: [],
        cdpTarget: { transport: 'none', probePath: '' },
        adapters: async () => [
          {
            action: 'example.note',
            capabilities: ['host-exec', 'host-read-export'],
            async execute(node) {
              if (node.operation === 'create') {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, 'hello recipe', { flag: 'wx' });
                owned = true;
                return { output: observe() };
              }
              if (node.operation === 'observe') return { output: observe() };
              if (node.operation === 'cleanup') return { output: cleanup() };
              throw new Error('Choose create, observe or cleanup.');
            },
          },
        ],
      },
    },
    // A hosted task binds to this provider; it gates no checklist step.
    commandOptions: { task: { stepGates: [] } },
    cancel: async () => {
      cleanup();
    },
    finalize: async () => {
      cleanup();
    },
  };
}
