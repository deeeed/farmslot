// gateway-tls.ts — shared transport constant for the gateway's optional TLS
// (wss://) listener. Homed in the protocol so the gateway daemon
// (services/gateway) and the CLI (packages/cli) share one source of truth for
// the port instead of each hard-coding the literal.

/**
 * Default port the gateway serves wss:// (and https `/health`) on when TLS is
 * configured. Distinct from the plaintext ws:// port (7777) so both transports
 * can coexist on one daemon. Overridable via FARMSLOT_GATEWAY_TLS_PORT.
 */
export const DEFAULT_GATEWAY_TLS_PORT = 7778;
