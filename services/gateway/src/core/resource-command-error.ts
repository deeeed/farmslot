/** A resource could not be observed on its owning machine. This is not provider failure. */
export class ResourceCommandUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ResourceCommandUnavailableError';
  }
}
