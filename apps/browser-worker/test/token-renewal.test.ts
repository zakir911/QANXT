import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneClient } from '../src/api/control-plane-client.js';

/**
 * A job's callback token can expire before the job is ever picked up.
 *
 * Run accddf2b designed 5,887 tests. The fleet worked through about forty a minute, and
 * every job's token was minted at run start with a two-hour life. Two hours in, 1,116
 * executions had not been attempted yet, and from that moment none of them could report
 * anything: `started` answered 401, the job went back on the queue, and it answered 401
 * again until the retry budget ran out. Queue time is the suite size over the fleet size,
 * and the control plane knows neither when it stamps the token, so no constant lifetime is
 * the right one. The worker has to be able to ask for a new one.
 */

const silent = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => silent
} as never;

function client(overrides: Record<string, unknown> = {}) {
  return new ControlPlaneClient({
    baseUrl: 'https://control.example.test',
    token: 'the-expired-one',
    logger: silent,
    maxAttempts: 2,
    job: { id: 'job-1', scope: 'execution' },
    workerSecret: 'fleet-secret',
    ...overrides
  });
}

const ok = () => new Response(null, { status: 204 });
const refused = (status: number) => new Response('refused', { status });
const minted = (token: string) => new Response(
  JSON.stringify({ token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
  { status: 200, headers: { 'content-type': 'application/json' } });

/** Every call the client made, in order, with the bearer it presented. */
function record() {
  const calls: { url: string; auth: string | null; secret: string | null }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      auth: headers.get('authorization'),
      secret: headers.get('x-worker-secret')
    });
    return responses.shift() ?? ok();
  });
  const responses: Response[] = [];
  vi.stubGlobal('fetch', fetchMock);
  return { calls, responses };
}

afterEach(() => vi.unstubAllGlobals());

describe('replacing a callback token that expired in the queue', () => {
  it('renews on a 401 and retries the call with the new token', async () => {
    const { calls, responses } = record();
    responses.push(refused(401), minted('a-fresh-one'), ok());

    await client().executionStarted('job-1', 'worker-1');

    expect(calls.map(call => call.url)).toEqual([
      'https://control.example.test/api/v1/worker/executions/job-1/started',
      'https://control.example.test/api/v1/worker/jobs/job-1/token',
      'https://control.example.test/api/v1/worker/executions/job-1/started'
    ]);
    expect(calls[0]!.auth).toBe('Bearer the-expired-one');
    expect(calls[2]!.auth).toBe('Bearer a-fresh-one');
  });

  it('presents the fleet secret to the exchange, and only there', async () => {
    const { calls, responses } = record();
    responses.push(refused(401), minted('a-fresh-one'), ok());

    await client().executionStarted('job-1', 'worker-1');

    expect(calls[1]!.secret).toBe('fleet-secret');
    expect(calls[0]!.secret).toBeNull();
    expect(calls[2]!.secret).toBeNull();
    // The secret is the fleet's, not one job's: it must never be offered as a job token.
    expect(calls.map(call => call.auth)).not.toContain('Bearer fleet-secret');
  });

  it('keeps the new token for later calls instead of renewing again', async () => {
    const { calls, responses } = record();
    responses.push(refused(401), minted('a-fresh-one'), ok(), ok());

    const subject = client();
    await subject.executionStarted('job-1', 'worker-1');
    await subject.executionStarted('job-1', 'worker-1');

    expect(calls.filter(call => call.url.endsWith('/token'))).toHaveLength(1);
    expect(calls[3]!.auth).toBe('Bearer a-fresh-one');
  });

  it('gives up when the exchange refuses, rather than looping on a dead credential', async () => {
    // The job has finished, or the secret is wrong. Either way the 401 is the real answer
    // and must reach the caller: this is the hot loop the old code fell into.
    const { calls, responses } = record();
    responses.push(refused(401), refused(404), refused(401), refused(404));

    await expect(client().executionStarted('job-1', 'worker-1')).rejects.toThrow('401');

    expect(calls.filter(call => call.url.endsWith('/token'))).toHaveLength(1);
  });

  it('does not renew when it has no secret to present', async () => {
    const { calls, responses } = record();
    responses.push(refused(401));

    await expect(client({ workerSecret: undefined }).executionStarted('job-1', 'worker-1'))
      .rejects.toThrow('401');

    expect(calls.filter(call => call.url.endsWith('/token'))).toHaveLength(0);
  });

  it('does not renew on a refusal that is about the request rather than the token', async () => {
    const { calls, responses } = record();
    responses.push(refused(403));

    await expect(client().executionStarted('job-1', 'worker-1')).rejects.toThrow('403');

    expect(calls.filter(call => call.url.endsWith('/token'))).toHaveLength(0);
  });

  it('survives an exchange that answers 200 with something that is not a token', async () => {
    const { calls, responses } = record();
    responses.push(
      refused(401),
      new Response('<html>a proxy login page</html>', { status: 200 }));

    await expect(client().executionStarted('job-1', 'worker-1')).rejects.toThrow('401');

    expect(calls.filter(call => call.url.endsWith('/token'))).toHaveLength(1);
  });

  it('does not spend a retry attempt on the renewal', async () => {
    // maxAttempts is 2. If renewing cost an attempt, the retried call would be the last one
    // and a single transient failure after it would end the job.
    const { calls, responses } = record();
    responses.push(refused(401), minted('a-fresh-one'), refused(503), ok());

    await client().executionStarted('job-1', 'worker-1');

    expect(calls).toHaveLength(4);
    expect(calls[3]!.auth).toBe('Bearer a-fresh-one');
  });
});
