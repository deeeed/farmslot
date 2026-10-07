// Compiles the call shapes a host (mm-harness, a dapp team's plugin) uses against
// the emitted web-dapp declarations, so a wrong JSDoc type fails `yarn typecheck`.
import {
  bindWebDappPolicy,
  createWebDappAdapter,
  launchWebDappBrowser,
  loadSigners,
  readinessCheck,
  SIGNER_MODULE_ENV,
  stopWebDappBrowser,
  webDappLeafPath,
  webDappReadiness,
  webDappRuntimeFile,
} from '@farmslot/adapter-web/web-dapp';

export async function consumerCalls(target: string) {
  const adapter = createWebDappAdapter({
    id: 'terminal',
    cli: 'mm-harness',
    signerModule: '/host/signers.mjs',
    hooks: {
      actions: {
        manifestPath: () => '/host/web-dapp.action-manifest.json',
        semantic: [],
        cdpTarget: { transport: 'chrome-cdp', probePath: 'json/version' },
      },
      harness: { restart: 'mm-harness launch' },
    },
  });
  const id: string = adapter.id;
  const status = await adapter.runtimeStatus(target);
  const decision: string = status.decision;
  const sources = adapter.logSources(target).map((source) => source.path);
  const bound = bindWebDappPolicy({ extends: 'web-dapp', policy: { module: '/host/policy.mjs' } });
  const leaf: string = webDappLeafPath('launch');
  const file: string = webDappRuntimeFile(target, 'browser.json');
  const signers = await loadSigners({ [SIGNER_MODULE_ENV]: '/host/signers.mjs' });
  const state = await launchWebDappBrowser(
    { target, 'cdp-port': '9222', 'app-port': '3000', signer: 'injected', account: 'dev1' },
    process.env,
  );
  const stopped = await stopWebDappBrowser(target, { cdpPort: 9222 });
  const report = await webDappReadiness({ target, signers, signer: 'injected' });
  const extensionCheck = readinessCheck('extension', true, 'ready', { required: true });
  return { id, decision, sources, bound, leaf, file, state, stopped, report, extensionCheck };
}
