const { offlineClientCacheProof } = await import('/src/dev/offline-client-cache-proof.ts');
let result = await offlineClientCacheProof('start');
const deadline = Date.now() + 10000;
while (result.status !== 'ready' && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  result = await offlineClientCacheProof('snapshot');
}
if (result.status !== 'ready')
  throw new Error(`Resource cache did not become ready: ${JSON.stringify(result)}`);
if (result.generation !== 0) throw new Error('The original principal must report generation zero');
return result;
