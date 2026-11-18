import { describe, expect, it, vi } from 'vitest';
import { evaluateAssertion } from '../src/execution/action-runner.js';

/**
 * The assertion that lets a boundary test say what it means.
 *
 * The boundary scenario's objective is that a field "either accepts the value cleanly or
 * refuses it with a message. An unhandled error is a failure." It asserted that the URL was
 * still the form's, which contradicts the first outcome — a form that accepts a value
 * cleanly redirects to the record it saved — so it failed on every form that redirects on
 * success. 31 of 79 failures in a measured run were that.
 *
 * This assertion says the thing the objective actually forbids: a 5xx while handling the
 * input.
 */
describe('noServerError', () => {
  const assertion = { type: 'noServerError' as const, description: 'no server error' };

  /** Only the four fields this assertion reads; the real report carries many more. */
  const event = (statusCode: number, url = '/customers/cus-002', method = 'POST') =>
    ({ statusCode, url, method, resourceType: 'document' });

  function context(events: ReturnType<typeof event>[], settle = vi.fn().mockResolvedValue(undefined)) {
    return {
      defaultTimeoutMs: 1000,
      resolveValue: (raw?: string) => raw,
      observations: { network: () => events, console: () => [], settle }
    } as never;
  }

  const page = { url: () => 'https://app.example.test/customers/cus-002' } as never;

  it('passes when the form accepted the value and redirected', async () => {
    const outcome = await evaluateAssertion(page, assertion, context([event(302), event(200)]));
    expect(outcome.failure).toBeNull();
  });

  it('passes when the form refused the value with a 4xx', async () => {
    // A 4xx is how a well-behaved application refuses a value, which the objective allows.
    // Treating it as a failure would rebuild the original bug one status class along.
    const outcome = await evaluateAssertion(page, assertion, context([event(422)]));
    expect(outcome.failure).toBeNull();
  });

  it('fails when the application returned a server error', async () => {
    const outcome = await evaluateAssertion(page, assertion, context([event(200), event(500)]));
    expect(outcome.failure).toMatch(/server error/i);
    expect(outcome.failure).toContain('500');
  });

  it('reports how many and names the first few', async () => {
    const outcome = await evaluateAssertion(page, assertion,
      context([event(500, '/a'), event(503, '/b'), event(500, '/c'), event(500, '/d')]));
    expect(outcome.failure).toContain('4 server error(s)');
    expect(outcome.failure).toContain('/a');
    expect(outcome.failure).toContain('…');
  });

  /**
   * The failure mode that would have made this assertion worse than useless.
   *
   * Assertions run immediately after their action, and a submit's response has usually not
   * been recorded at that moment. Reading the network log straight away reports no server
   * error on a request that has not come back — a false PASS, which is the direction that
   * matters: a missed 500 is a defect shipped, where a spurious one is a wasted morning.
   */
  it('waits for the network to settle before reading it', async () => {
    const events: ReturnType<typeof event>[] = [];
    // The response only lands once settle has been awaited, as in a real submit.
    const settle = vi.fn().mockImplementation(async () => { events.push(event(500)); });

    const outcome = await evaluateAssertion(page, assertion, context(events, settle));

    expect(settle).toHaveBeenCalled();
    expect(outcome.failure).toMatch(/server error/i);
  });

  /**
   * A request that never got a response carries no status code. Not counted, deliberately:
   * a server dying mid-request is arguably what this assertion is for, but so is a
   * navigation the browser cancelled, and the two look identical in the network log. The
   * assertion claims only what its name says.
   */
  it('does not count a request that never got a response', async () => {
    const outcome = await evaluateAssertion(page, assertion,
      context([{ url: '/customers', method: 'POST', resourceType: 'document' } as never]));
    expect(outcome.failure).toBeNull();
  });

  it('is not healable, because it has no locator to re-point', async () => {
    const outcome = await evaluateAssertion(page, assertion, context([event(500)]));
    expect(outcome.isLocatorFailure).toBe(false);
  });
});
