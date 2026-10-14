// Plain-Node entry only. TSX callers import the typed source entry so they
// keep their existing loader, including its later dynamic-import resolution.
import { fileURLToPath } from 'node:url';

import { register } from 'tsx/esm/api';

const loader = register({
  namespace: 'test-gateway-identity',
  tsconfig: fileURLToPath(new URL('../../packages/cli/tsconfig.json', import.meta.url)),
});
let identity;
try {
  identity = await loader.import('./test-gateway-identity-source.mts', import.meta.url);
} finally {
  await loader.unregister();
}

export const { testGatewayIdentity, testGatewayProfile } = identity;
