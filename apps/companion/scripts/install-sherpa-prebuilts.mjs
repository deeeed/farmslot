import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('@siteed/sherpa-onnx.rn/package.json'));
const result = spawnSync(process.execPath, [path.join(packageRoot, 'install.js')], {
  stdio: 'inherit',
  // Native compilation needs complete libraries, even if the caller skipped them during install.
  env: {
    ...process.env,
    CI: '1',
    SKIP_SHERPA_DOWNLOAD: '0',
    SITEED_SHERPA_ONNX_ALLOW_MISSING_PREBUILTS: '0',
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
