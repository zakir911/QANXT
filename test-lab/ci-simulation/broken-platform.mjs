/**
 * A server that answers every request the way a broken AIRA would.
 *
 * Runs as its own process, and that is not incidental. The scenario that uses it drives the
 * pipeline with `spawnSync`, which blocks the event loop of whoever called it — a responder
 * living in the same process would accept the connection and never answer, and the scenario
 * would hang rather than fail. It cost a run to find out.
 *
 * Prints its URL on the first line of stdout and then stays up until it is killed.
 */
import { createServer } from 'node:http';

const server = createServer((_, response) => {
  response.writeHead(500, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    code: 'unexpected',
    status: 500,
    title: 'An unexpected error occurred.',
    correlationId: 'sim-0001'
  }));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
});
