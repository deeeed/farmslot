import { chmodSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Published prebuilds can lose their executable bit during dependency installation. */
export function ensureNodePtySpawnHelpersExecutable(callerUrl: string): void {
  const require = createRequire(callerUrl);
  const prebuilds = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds');
  let platforms: string[];
  try {
    platforms = readdirSync(prebuilds);
  } catch (error) {
    // A source-built node-pty can use its native fork without packaged spawn helpers.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const platform of platforms) {
    const helper = path.join(prebuilds, platform, 'spawn-helper');
    let mode: number;
    try {
      mode = statSync(helper).mode;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if ((mode & 0o111) !== 0o111) chmodSync(helper, mode | 0o755);
  }
}
