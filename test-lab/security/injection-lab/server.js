/**
 * Injection indicators — detection, never exploitation.
 *
 * The brief draws the line clearly: the goal is vulnerability detection, not data
 * extraction, and no destructive database operation is ever performed. So this application
 * has no database. What it has is a query layer that *behaves* the way an injectable one
 * behaves: a quote in the wrong place produces a database-shaped error, and a tautology
 * changes how many rows come back.
 *
 * That is exactly what a safe detector looks for, and it means the worst a probe can do
 * here is read a fixed array.
 */
import { createSecurityLab } from '../shared/security-lab.js';

const PORT = Number(process.env.INJECTION_LAB_PORT ?? 4408);

const app = createSecurityLab({
  name: 'QA NXT Injection Lab',
  vulnerabilities: [
    { id: 'VULN_SQL_INJECTION', description: '/api/products?name= builds a query by concatenation: quotes produce SQL errors and tautologies widen the result.' },
    { id: 'VULN_NOSQL_INJECTION', description: '/api/login accepts an operator object where a string is expected.' },
    { id: 'VULN_COMMAND_INJECTION', description: '/api/ping reports shell-shaped errors for metacharacters.' },
    { id: 'VULN_TEMPLATE_INJECTION', description: '/api/render evaluates {{ }} expressions in user input.' }
  ]
});

app.use(ctx => { app.writeSecurityHeaders(ctx); });

const PRODUCTS = [
  { id: 1, name: 'Synthetic Widget', price: 10, internalCost: 4 },
  { id: 2, name: 'Synthetic Gadget', price: 20, internalCost: 9 },
  { id: 3, name: 'Synthetic Gizmo', price: 30, internalCost: 12 }
];

/** Looks like SQL, touches no database. A quote produces the error an injectable app gives. */
app.get('/api/products', ctx => {
  const name = String(ctx.query.name ?? '');

  if (app.faults.on('VULN_SQL_INJECTION')) {
    const query = `SELECT id, name, price FROM products WHERE name = '${name}'`;
    const quotes = (name.match(/'/g) ?? []).length;
    if (quotes % 2 === 1) {
      // The unbalanced-quote error: the single most reliable injection indicator, and the
      // one a detector should key on rather than on a payload appearing in the response.
      return ctx.json(500, {
        error: 'database_error',
        message: `SQLSTATE[42000]: Syntax error or access violation: 1064 You have an error in your SQL syntax near '${name}'`,
        query
      });
    }
    if (/'\s*or\s*'?1'?\s*=\s*'?1/i.test(name) || /\bor\s+1\s*=\s*1\b/i.test(name)) {
      // A tautology returns everything, which is the behavioural indicator.
      return ctx.json(200, { products: PRODUCTS, query, matched: PRODUCTS.length });
    }
    const rows = PRODUCTS.filter(p => p.name === name);
    return ctx.json(200, { products: rows, query, matched: rows.length });
  }

  const rows = PRODUCTS.filter(p => p.name === name);
  return ctx.json(200, { products: rows.map(({ internalCost, ...rest }) => rest), matched: rows.length });
});

/** NoSQL: an operator object where a string belongs. */
app.post('/api/login', async ctx => {
  const body = await ctx.body();
  const password = body.password;
  if (app.faults.on('VULN_NOSQL_INJECTION') && password !== null && typeof password === 'object') {
    const operators = Object.keys(password).filter(k => k.startsWith('$'));
    if (operators.length > 0) {
      return ctx.json(200, { authenticated: true, via: 'operator', operators, note: 'Synthetic. No session was issued.' });
    }
  }
  if (typeof password !== 'string') return ctx.json(400, { error: 'invalid_type', field: 'password' });
  return ctx.json(401, { error: 'invalid_credentials' });
});

/** Command injection: metacharacters produce shell-shaped errors. Nothing is executed. */
app.get('/api/ping', ctx => {
  const host = String(ctx.query.host ?? '');
  if (app.faults.on('VULN_COMMAND_INJECTION') && /[;&|`$(){}<>]/.test(host)) {
    return ctx.json(500, {
      error: 'command_failed',
      message: `/bin/sh: 1: ${host}: not found`,
      command: `ping -c 1 ${host}`
    });
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) return ctx.json(400, { error: 'invalid_host' });
  return ctx.json(200, { host, reachable: true, note: 'Synthetic. Nothing was executed.' });
});

/** Template injection: an arithmetic marker that evaluates is the indicator. */
app.get('/api/render', ctx => {
  const template = String(ctx.query.template ?? '');
  if (app.faults.on('VULN_TEMPLATE_INJECTION')) {
    const rendered = template.replace(/\{\{\s*(\d+)\s*\*\s*(\d+)\s*\}\}/g,
      (_, a, b) => String(Number(a) * Number(b)));
    return ctx.json(200, { rendered, engine: 'synthetic-templates/1.0' });
  }
  return ctx.json(200, { rendered: template, engine: 'synthetic-templates/1.0' });
});

app.get('/', ctx => ctx.json(200, {
  application: 'QA NXT Injection Lab',
  notice: 'Deliberately vulnerable. No database, no shell, no template engine — only their observable behaviour.',
  endpoints: ['/api/products?name=', '/api/login', '/api/ping?host=', '/api/render?template=']
}));

app.post('/__reset', ctx => ctx.json(200, { reset: true }));

await app.listen(PORT);
