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
    get(inner, property) {
      if (property !== 'request') {
        // Read from the real scanner, not through this proxy. The scanner has at least one
        // getter that reads its own fields, and anything bound to the proxy instead would
        // resolve those through the proxy too -- harmless today and the standard way to break
        // a class that later uses a private field.
        //
        // It is also the right answer rather than merely the safe one: signIn is
        // authentication, not a probe of the target, so it has no business being floored by
        // what the target does. Only requests a check makes are floored, and those come
        // through `request`.
        const value = Reflect.get(inner, property) as unknown;
        return typeof value === 'function' ? value.bind(inner) : value;
      }

      return (options: Parameters<Scanner['request']>[0]) => inner.request({
        ...options,
        risk: (options.risk ?? 0) > STATE_CHANGING ? options.risk : STATE_CHANGING
      });
    }
  });
}
