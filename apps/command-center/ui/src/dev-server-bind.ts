export interface CommandCenterDevBind {
  host?: string;
  allowedHosts?: string[];
}

/** Vite dev bind. Unset env keeps Vite's localhost-only default. */
export function commandCenterDevBind(
  env: Record<string, string | undefined>,
): CommandCenterDevBind {
  const host = env.FARMSLOT_UI_HOST?.trim();
  const allowedHosts = (env.FARMSLOT_UI_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return {
    ...(host ? { host } : {}),
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
  };
}

/** Numeric GATEWAY_PORT for the dev client. Anything else stays blank. */
export function devGatewayPortDefine(env: Record<string, string | undefined>): string {
  const port = env.GATEWAY_PORT?.trim() ?? '';
  return /^\d+$/.test(port) ? port : '';
}
