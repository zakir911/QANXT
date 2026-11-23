import { describe, expect, it } from 'vitest';
import { stateChangingScanner } from '../src/security/state-changing-floor';

/**
 * Declaring a probe honestly when the surface knows the address changes something.
 *
 * The scope guard already holds that a verb may raise a declared risk and never lower it. The
 * address deserves the same rule, and only the surface knows that part: a check describing its
 * own request as merely active is correct about a read and wrong about an approve link, and
 * the guard would wave the second through on an authorisation nobody gave.
 *
 * This nearly shipped as a real regression. `api.rate-limit` declares its fifteen requests
 * active, and before the address a check issues was resolved properly it was sending them to
 * /approve.asp with the query stripped — fifteen 404s against a page that does not exist.
 * Giving every check the working address would have made those fifteen real approvals,
 * declared as reads.
 */
const PASSIVE = 0, ACTIVE = 1, STATE_CHANGING = 2, DESTRUCTIVE = 3;

function recorder() {
  const risks: Array<number | undefined> = [];
  const scanner = {
    async request(options: { risk?: number; url: string }) {
      risks.push(options.risk);
      return { allowed: true, status: 200, responseText: '' };
    },
    async signIn() { return null; }
  };
  return { risks, scanner };
}

describe('the state-changing floor', () => {
  it('raises a probe declared active', async () => {
    const { risks, scanner } = recorder();
    await stateChangingScanner(scanner as never).request({ url: '/approve.asp', risk: ACTIVE } as never);
    expect(risks).toEqual([STATE_CHANGING]);
  });

  it('raises a probe that declares no risk at all', async () => {
    const { risks, scanner } = recorder();
    await stateChangingScanner(scanner as never).request({ url: '/approve.asp' } as never);
    expect(risks).toEqual([STATE_CHANGING]);
  });

  it('raises a probe declared passive, because reading is not what this does', async () => {
    const { risks, scanner } = recorder();
    await stateChangingScanner(scanner as never).request({ url: '/approve.asp', risk: PASSIVE } as never);
    expect(risks).toEqual([STATE_CHANGING]);
  });

  it('never lowers one already declared destructive', async () => {
    const { risks, scanner } = recorder();
    await stateChangingScanner(scanner as never).request({ url: '/approve.asp', risk: DESTRUCTIVE } as never);
    expect(risks).toEqual([DESTRUCTIVE]);
  });

  it('leaves everything else on the scanner reachable', async () => {
    const { scanner } = recorder();
    const wrapped = stateChangingScanner(scanner as never);
    expect(typeof (wrapped as unknown as { signIn: unknown }).signIn).toBe('function');
  });

  it('passes the rest of the request through untouched', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const scanner = {
      async request(options: Record<string, unknown>) {
        seen.push(options);
        return { allowed: true, status: 200, responseText: '' };
      }
    };
    await stateChangingScanner(scanner as never).request({
      url: '/approve.asp', method: 'GET', testId: 'T', headers: { authorization: 'Basic x' }
    } as never);
    expect(seen[0]).toMatchObject({
      url: '/approve.asp', method: 'GET', testId: 'T', headers: { authorization: 'Basic x' }
    });
  });
});
