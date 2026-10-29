import { gateway } from './transport.js';

export function unresolvedRead(method: string) {
  return gateway.request(method, {});
}
