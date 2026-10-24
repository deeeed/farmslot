const deadline = Date.now() + 10000;
let receipt;
while (Date.now() < deadline) {
  const host = document.querySelector('farm-resource-store-notice');
  if (host) {
    const diagnostics = await host.resourceStoreDiagnostics();
    const notice = host.shadowRoot
      ?.querySelector('[data-testid="resource-store-notice"]')
      ?.textContent?.trim();
    if (
      (diagnostics.storage === 'opfs-sahpool' && diagnostics.storeCount > 0) ||
      (diagnostics.storage === 'memory' && notice)
    ) {
      receipt = {
        ...diagnostics,
        notice,
        secure: isSecureContext,
        firstPaint: performance
          .getEntriesByType('paint')
          .find((entry) => entry.name === 'first-paint')?.startTime,
        workerStarted: performance.getEntriesByName('farmslot-resource-worker-start')[0]?.startTime,
      };
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (!receipt) throw new Error('The application did not produce a local-store receipt');
if (receipt.storage === 'opfs-sahpool') {
  if (receipt.integrity !== 'ok') throw new Error('SQLite integrity check failed');
  if (!(receipt.workerStarted > receipt.firstPaint))
    throw new Error('The store worker started before first paint');
} else if (!receipt.notice?.includes('will not survive a restart'))
  throw new Error('Memory fallback has no visible notice');
return receipt;
