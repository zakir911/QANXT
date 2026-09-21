/**
 * The HTTP kit the lab applications are built on.
 *
 * Deliberately small and dependency-free: these applications are the *subject* of
 * verification, so the less machinery between a request and the HTML it produces, the
 * easier it is to say what the application actually did. Everything here is real — real
 * routing, real cookies, real status codes, real content types.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
};

export const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function createLabApp({ name, faults, staticDir, spaFallback = false, version = '1.0.0' }) {
  const routes = [];
  const middleware = [];

  const add = (method, pattern, handler) => {
    const names = [];
    const source = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:([A-Za-z0-9_]+)/g, (_, key) => { names.push(key); return '([^/]+)'; })
      .replace(/\*/g, '.*');
    routes.push({ method, regex: new RegExp(`^${source}$`), names, handler, pattern });
  };

  const app = {
    name,
    version,
    faults,
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    put: (pattern, handler) => add('PUT', pattern, handler),
    patch: (pattern, handler) => add('PATCH', pattern, handler),
    delete: (pattern, handler) => add('DELETE', pattern, handler),
    use: (fn) => middleware.push(fn),
    listen
  };

  // ---- Fault administration, present on every lab application ---------------
  app.get('/__faults', ctx => ctx.json(200, { application: name, faults: faults.list() }));
  app.post('/__faults', async ctx => {
    const result = faults.set(await ctx.body());
    return ctx.json(result.unknown.length ? 400 : 200, { ...result, faults: faults.state() });
  });
  app.post('/__faults/reset', ctx => ctx.json(200, { faults: faults.reset() }));
  app.get('/health', ctx => ctx.json(200, {
    status: 'ok', application: name, version, uptimeSeconds: Math.round(process.uptime()),
    faults: faults.state()
  }));

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const ctx = buildContext(req, res, url);

    try {
      for (const fn of middleware) {
        const handled = await fn(ctx);
        if (handled === true || res.writableEnded) return;
      }

      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = route.regex.exec(url.pathname);
        if (!match) continue;
        ctx.params = Object.fromEntries(route.names.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
        await route.handler(ctx);
        if (!res.writableEnded) res.end();
        return;
      }

      if (staticDir) {
        const served = await serveStatic(ctx, staticDir, url.pathname);
        if (served) return;
        if (spaFallback && req.method === 'GET' && !url.pathname.startsWith('/api/')) {
          // Client-side routing: any unknown path is the application shell, which is what
          // makes a deep link into a single-page application work the way a user expects.
          const shell = await readFile(join(staticDir, 'index.html'), 'utf8').catch(() => null);
          if (shell !== null) return ctx.html(200, shell);
        }
      }

      ctx.json(404, { error: 'not_found', path: url.pathname });
    } catch (error) {
      console.error(`[${name}] ${req.method} ${url.pathname} failed:`, error);
      if (!res.writableEnded) ctx.json(500, { error: 'internal_error', message: String(error?.message ?? error) });
    }
  }

  function listen(port, host = '127.0.0.1') {
    const server = createServer(handle);
    return new Promise(done => server.listen(port, host, () => {
      console.log(`${name} listening on http://${host}:${port}`);
      done(server);
    }));
  }

  return app;
}

function buildContext(req, res, url) {
  let cachedBody;
  const ctx = {
    req, res, url, params: {},
    query: Object.fromEntries(url.searchParams.entries()),
    cookies: parseCookies(req.headers.cookie),
    setCookie(nameOfCookie, value, options = {}) {
      const parts = [`${nameOfCookie}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
      if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
      const existing = res.getHeader('Set-Cookie');
      const header = existing ? [].concat(existing, parts.join('; ')) : parts.join('; ');
      res.setHeader('Set-Cookie', header);
    },
    clearCookie(nameOfCookie) {
      ctx.setCookie(nameOfCookie, '', { maxAge: 0 });
    },
    async body() {
      if (cachedBody !== undefined) return cachedBody;
      cachedBody = await readBody(req);
      return cachedBody;
    },
    json(status, value) {
      const payload = JSON.stringify(value);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    },
    html(status, markup) {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(markup) });
      res.end(markup);
    },
    text(status, value) {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(value);
    },
    buffer(status, headers, data) {
      res.writeHead(status, headers);
      res.end(data);
    },
    redirect(location, status = 302) {
      res.writeHead(status, { location });
      res.end();
    },
    /** Destroys the socket without a response — a genuine network-layer failure. */
    destroy() {
      req.destroy();
      res.destroy();
    }
  };
  return ctx;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
  if (type.includes('multipart/form-data')) return parseMultipart(raw, type);
  return { raw };
}

/**
 * Enough multipart parsing for a file upload in a test lab: field names, filenames and
 * sizes. The lab needs to prove an upload happened and what arrived, not to store files.
 */
function parseMultipart(raw, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!boundary) return {};
  const marker = `--${boundary[1] ?? boundary[2]}`;
  const fields = {};
  for (const part of raw.split(marker)) {
    const header = /Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?/i.exec(part);
    if (!header) continue;
    const value = part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
    fields[header[1]] = header[2] === undefined
      ? value
      : { filename: header[2], size: Buffer.byteLength(value), contentType: /Content-Type: ([^\r\n]+)/i.exec(part)?.[1] ?? null };
  }
  return fields;
}

function parseCookies(header) {
  if (!header) return {};
  return Object.fromEntries(header.split(';').map(pair => {
    const index = pair.indexOf('=');
    return [pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1))];
  }).filter(([key]) => key));
}

async function serveStatic(ctx, root, pathname) {
  if (ctx.req.method !== 'GET') return false;
  const target = resolve(root, `.${normalize(pathname)}`);
  // Path traversal is a real risk even here: this application is also a security target.
  if (!target.startsWith(resolve(root))) return false;

  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return false;

  const data = await readFile(target);
  ctx.buffer(200, {
    'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
    'content-length': data.length,
    'cache-control': 'no-store'
  }, data);
  return true;
}
