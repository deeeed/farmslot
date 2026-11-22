// Pi extension Farmslot loads into native Pi sessions (`pi --mode rpc`): Pi's bash tool has no
// default timeout, so a call without one gets Claude Code's 120 seconds. An explicit one is kept.
export const PI_BASH_TIMEOUT_SECONDS = 120;

export default function piBashTimeout(pi) {
  pi.on('tool_call', (event) => {
    if (event.toolName === 'bash' && event.input.timeout === undefined)
      event.input.timeout = PI_BASH_TIMEOUT_SECONDS;
  });
}
