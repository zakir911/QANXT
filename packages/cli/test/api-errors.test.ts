import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiClient } from '../src/api.js';
import { CliError, ExitCode } from '../src/exit-codes.js';

/**
 * How an HTTP failure becomes an exit code.
 *
 * These are the lines a pipeline reads. A misclassification does not show up as a broken
 * build — it shows up as the build failing correctly and the wrong person being asked to
 * fix it, which is far more expensive to notice.
 */

function answer(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } })));
}

/** The call, and the CliError it produced. Fails the test if it did not produce one. */
async function failureOf(): Promise<CliError> {
  const client = new ApiClient('http://platform.invalid', 'token');
  try {
    await client.get('/api/v1/testruns');
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('The call was expected to fail and did not.');
}

afterEach(() => vi.unstubAllGlobals());

describe('403 is two different refusals', () => {
  test('a policy refusal exits SECURITY_POLICY_VIOLATION, not AUTHENTICATION_ERROR', async () => {
    // BUG-0026: every 403 was an authentication error, so this code was unreachable and a
    // pipeline refused entry to production was told its credentials were wrong.
    answer(403, {
      code: 'security_policy',
      title: "Environment 'prod' is production and testing it has not been authorized.",
      status: 403
    });

    const error = await failureOf();

    expect(error.code).toBe(ExitCode.SecurityPolicyViolation);
    expect(error.message).toContain('has not been authorized');
  });

  test('the hint on a policy refusal does not send anyone to widen permissions', async () => {
    // The old hint said "Ask an organization administrator for the required role." Acting
    // on that removes the control that just did its job.
    answer(403, { code: 'security_policy', title: 'Refused.', status: 403 });

    const error = await failureOf();

    expect(error.hint).toBeDefined();
    expect(error.hint).not.toMatch(/required role/i);
    expect(error.hint).toMatch(/do not retry/i);
  });

  test('a role refusal still exits AUTHENTICATION_ERROR', async () => {
    answer(403, { code: 'forbidden', title: 'You do not have permission.', status: 403 });

    const error = await failureOf();

    expect(error.code).toBe(ExitCode.AuthenticationError);
    expect(error.hint).toMatch(/role/i);
  });

  test('a 403 with no parseable body is treated as a role refusal', async () => {
    // Failing open to "security policy" would let a proxy's HTML error page halt a
    // pipeline with a reason that never came from AIRA.
    answer(403, '<html><body>Forbidden</body></html>');

    expect((await failureOf()).code).toBe(ExitCode.AuthenticationError);
  });
});

describe('the other statuses keep their meanings', () => {
  test('401 is an authentication error', async () => {
    answer(401, { code: 'unauthorized', title: 'Expired.', status: 401 });
    expect((await failureOf()).code).toBe(ExitCode.AuthenticationError);
  });

  test('a bad request is a configuration error, not an infrastructure one', async () => {
    // Reporting this as infrastructure sends a pipeline's failure to whoever runs the
    // platform instead of to whoever wrote the configuration that caused it.
    answer(400, { code: 'validation_failed', title: 'The project does not exist.', status: 400 });
    expect((await failureOf()).code).toBe(ExitCode.ConfigurationError);
  });

  test('a 503 is an infrastructure error', async () => {
    answer(503, { code: 'queue_unavailable', title: 'The queue is unreachable.', status: 503 });
    expect((await failureOf()).code).toBe(ExitCode.InfrastructureError);
  });

  test('a 500 from AIRA is AIRA failing, not AIRA being unreachable', async () => {
    // BUG-0027: this was exit 5, which reads as "the platform is down" and goes to
    // whoever runs the deployment. They check it, find it healthy, and hand it back.
    answer(500, { code: 'unexpected', title: 'Object reference not set.', status: 500 });
    const error = await failureOf();
    expect(error.code).toBe(ExitCode.AiraInternalError);
    expect(error.hint).toMatch(/defect in AIRA/i);
  });

  test('a gateway error in front of AIRA stays infrastructure', async () => {
    // 502 and 504 come from a proxy, not from AIRA. Calling them AIRA defects would file
    // bugs against the wrong component every time a load balancer hiccups.
    for (const status of [502, 504]) {
      answer(status, '<html>Bad Gateway</html>');
      expect((await failureOf()).code).toBe(ExitCode.InfrastructureError);
    }
  });

  test('a response from AIRA that is not JSON is an AIRA defect', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops</html>',
      { status: 200, headers: { 'content-type': 'text/html' } })));
    expect((await failureOf()).code).toBe(ExitCode.AiraInternalError);
  });

  test('an unreachable platform is an infrastructure error, never a pass', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const error = await failureOf();
    expect(error.code).toBe(ExitCode.InfrastructureError);
    expect(error.code).not.toBe(ExitCode.Success);
  });
});
