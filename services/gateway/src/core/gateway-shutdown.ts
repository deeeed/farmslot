let shuttingDown = false;

/** Stop settling pipeline work before shutdown can interrupt its dependencies. */
export function beginGatewayShutdown(): void {
  shuttingDown = true;
}

export function isGatewayShuttingDown(): boolean {
  return shuttingDown;
}
