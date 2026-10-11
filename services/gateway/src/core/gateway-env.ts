import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Reload checkout configuration, with local authentication applied last. */
export function loadGatewayEnvFiles(root: string, env: NodeJS.ProcessEnv = process.env): void {
  // Force-override checkout values for tsx watch reloads, with local auth last.
  for (const name of ['.env', '.env.local-auth']) {
    const envPath = resolve(root, name);
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
      console.log(`[env] loaded ${envPath}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        console.warn(
          `[env] ${envPath} not found — should be configured (see ${name}.sample if available)`,
        );
      } else {
        throw new Error(`Cannot load gateway configuration ${envPath}: ${code ?? 'read_failed'}`);
      }
    }
  }
}
