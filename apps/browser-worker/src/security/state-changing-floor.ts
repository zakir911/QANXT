import type { SecurityScanner as Scanner } from '@qa-nxt/security-engine';

/**
 * The same scanner, with every request against it declared state-changing.
 *
 * A thin wrapper rather than a flag threaded through each check, because the checks are right
 * about their own requests and wrong only about this address, and the thing that knows which
 * address it is sits out here.
 *
 * The floor only ever raises: a check that already declares destructive keeps that.
 */
export function stateChangingScanner(scanner: Scanner): Scanner {
  const STATE_CHANGING = 2 as const;
  return new Proxy(scanner, {
    get(inner, property, receiver) {
      if (property !== 'request') return Reflect.get(inner, property, receiver);
      return (options: Parameters<Scanner['request']>[0]) => inner.request({
        ...options,
        risk: (options.risk ?? 0) > STATE_CHANGING ? options.risk : STATE_CHANGING
      });
    }
  });
}
