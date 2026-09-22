/**
 * A receiver for notifications, so delivery is something that can be observed.
 *
 * AIRA's notification providers POST to a URL somebody configured. Verifying that by
 * reading the provider proves nothing; verifying it by pointing it at Slack needs a Slack
 * workspace. This is the third option: a real HTTP server that accepts the real request,
 * keeps it, and lets a test read back exactly what arrived — headers, body and all.
 *
 * It is deliberately not a mock of Slack. It does not pretend to be any particular
 * service, and nothing here licenses a claim that Slack accepts the payload; what it
 * licenses is a claim that AIRA sent one, that the body had a given shape, and that the
 * signature verified.
 *
 *   GET  /health              is it up
 *   POST /hook                accepts anything, records it
 *   POST /hook/slow           takes longer than the provider's timeout
 *   POST /hook/500            answers 500 (retryable)
 *   POST /hook/400            answers 400 (not retryable)
 *   POST /hook/redirect       answers 302 to somewhere else
 *   GET  /received            everything received, newest last
 *   POST /reset               forget everything
 *
 * A test that needs to check a signature passes the same secret as `?secret=…` on the
 * delivery URL, and this verifies it the way a real receiver would.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.SINK_PORT ?? 4360);

/** Everything that has arrived. Bounded, so a long run cannot exhaust memory. */
const received = [];
const MAX_RECEIVED = 500;

const json = (response, status, body) => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text)
  });
  response.end(text);
};

const readBody = request => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  request.on('data', chunk => {
    size += chunk.length;
    // A notification is a few hundred bytes. Anything approaching a megabyte is not one,
    // and accepting it would let a defect in the sender fill this process's memory.
    if (size > 1_000_000) { reject(new Error('body too large')); request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  request.on('error', reject);
});

/**
 * Verifies an X-Aira-Signature the way a receiver would.
 *
 * Constant-time, and not because this sink matters — because the check a real receiver
 * copies from an example should be the right one, and a test that passes against a `===`
 * comparison would not tell anybody the example was wrong.
 */
function verify(body, header, secret) {
  if (!header || !secret) return null;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (request.method === 'GET' && path === '/health') {
    return json(response, 200, { status: 'ok', service: 'notification-sink', received: received.length });
  }

  if (request.method === 'GET' && path === '/received') {
    return json(response, 200, { received });
  }

  if (request.method === 'POST' && path === '/reset') {
    received.length = 0;
    return json(response, 200, { status: 'reset' });
  }

  if (request.method === 'POST' && path.startsWith('/hook')) {
    let body;
    try {
      body = await readBody(request);
    } catch {
      return json(response, 413, { error: 'body too large' });
    }

    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* recorded as unparsed */ }

    const secret = url.searchParams.get('secret');
    const signature = request.headers['x-aira-signature'] ?? null;

    received.push({
      at: new Date().toISOString(),
      path,
      headers: {
        'content-type': request.headers['content-type'] ?? null,
        'x-aira-event': request.headers['x-aira-event'] ?? null,
        'x-aira-signature': signature
      },
      signatureValid: verify(body, signature, secret),
      bodyText: body,
      body: parsed
    });
    if (received.length > MAX_RECEIVED) received.shift();

    if (path === '/hook/slow') {
      // Longer than the provider's ten-second timeout, so a test can observe what a
      // provider does when a receiver hangs rather than assume it.
      await new Promise(resolve => setTimeout(resolve, 15_000));
      return json(response, 200, { status: 'eventually' });
    }
    if (path === '/hook/500') return json(response, 500, { error: 'receiver_unavailable' });
    if (path === '/hook/400') return json(response, 400, { error: 'i_will_never_accept_this' });
    if (path === '/hook/redirect') {
      response.writeHead(302, { location: `http://127.0.0.1:${PORT}/hook` });
      return response.end();
    }

    return json(response, 200, { status: 'received' });
  }

  return json(response, 404, { error: 'not_found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`notification-sink listening on http://127.0.0.1:${PORT}`);
});
