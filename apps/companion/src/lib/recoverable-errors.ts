export function isGatewayBackgroundPauseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('Gateway paused while app is in the background')
  );
}
