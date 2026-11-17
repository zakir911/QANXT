/**
 * Request plumbing shared by every domain module.
 *
 * The important piece here is `definePage`, which registers one screen in a way that works
 * for all three navigation shapes without each domain knowing which shape it is:
 *
 *   linked  → GET /path renders the full shell, server-side.
 *   routed  → GET /path renders the shell with the router booted, and the router
 *             immediately asks /api/view?path=/path for the same body. A deep link works;
 *             no anchor exists.
 *   enclosed→ the screen has no path of its own at all. Its body is embedded in a parent
 *             screen's modal, drawer or tab panel, and `definePage` is not used.
 *
 * Because every screen is declared through the same call, the screen inventory the ground
 * truth is built from is the registry itself rather than a list somebody maintains by hand.
 * A screen that exists but was never declared cannot happen; a declared screen that does
 * not respond is caught by the self-test.
 */
import { escapeHtml } from '../shared/http.js';
import { shell, NAV_SHAPE } from './ui/chrome.js';

/** Every screen the application serves, filled by definePage at startup. */
export const registry = [];

export function createCore({ app, sessions, faults, state }) {
  const csrfTokens = new Map();

  // ---- session ------------------------------------------------------------

  function currentUser(ctx) {
    const token = ctx.cookies.lab_session;
    const result = sessions.resolve(token);
    if (result.expired) return { user: null, expired: true };
    if (!result.session) return { user: null, expired: false };
    const user = state.users.find(candidate => candidate.id === result.session.userId);
    return { user, expired: false, session: result.session };
  }

  function requireAuth(ctx) {
    if (faults.on('FAULT_SESSION_DROPPED')) {
      ctx.redirect('/auth/sign-in?reason=expired');
      return null;
    }
    const { user, expired } = currentUser(ctx);
    if (!user) {
      const target = encodeURIComponent(ctx.url.pathname + ctx.url.search);
      ctx.redirect(`/auth/sign-in?${expired ? 'reason=expired&' : ''}next=${target}`);
      return null;
    }
    return user;
  }

  /** Permission check used by handlers that are meant to enforce one. */
  const can = (user, permission) =>
    (state.rolePermissions[`role-${user.role}`] ?? []).includes(permission);

  // ---- anti-forgery -------------------------------------------------------

  function csrfToken(ctx) {
    const sessionToken = ctx.cookies.lab_session ?? 'anonymous';
    if (!csrfTokens.has(sessionToken)) {
      csrfTokens.set(sessionToken, `csrf-${Buffer.from(sessionToken).toString('hex').slice(0, 24)}`);
    }
    return csrfTokens.get(sessionToken);
  }

  const csrfField = (ctx) =>
    `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken(ctx))}" data-testid="csrf" />`;

  async function csrfValid(ctx) {
    const body = await ctx.body();
    return body._csrf === csrfToken(ctx);
  }

  // ---- flash --------------------------------------------------------------

  const flashes = new Map();
  const setFlash = (ctx, kind, message) => {
    flashes.set(ctx.cookies.lab_session ?? 'anonymous', { kind, message });
  };
  const takeFlash = (ctx) => {
    const key = ctx.cookies.lab_session ?? 'anonymous';
    const value = flashes.get(key) ?? null;
    flashes.delete(key);
    return value;
  };

  // ---- rendering ----------------------------------------------------------

  /**
   * Registers one screen.
   *
   * @param {object} spec
   * @param {string} spec.path          Express-style pattern, e.g. /shipments/:id
   * @param {string} spec.domain        Which sidebar section it belongs to
   * @param {string} spec.title         Static title, or a function of the view context
   * @param {string} spec.kind          list | detail | form | wizard | dashboard | report
   * @param {Function} spec.view        (ctx, user) => { title, body, breadcrumbs, actions, script }
   * @param {string} [spec.permission]  Permission required to see it
   * @param {boolean} [spec.anonymous]  Served without a session
   */
  /**
   * Screens are queued rather than registered immediately, so that `flush` can put the
   * literal paths in front of the parameterised ones.
   *
   * Without that ordering, `/shipments/:id` registered before `/shipments/consolidate`
   * swallows it: the router matches in registration order, ":id" happily matches the word
   * "consolidate", and the detail handler answers 404 because no shipment has that
   * reference. Seven screens were unreachable this way, and the symptom — a 404 on a
   * screen that plainly exists — looks exactly like a crawler's fault rather than the
   * application's. Ordering it here means a domain can declare its screens in whatever
   * order reads best and never has to think about it.
   */
  const pending = [];

  function definePage(spec) {
    pending.push(spec);
  }

  /** Parameters in a pattern. More means less specific, so it matches later. */
  const parameterCount = (pattern) => (pattern.match(/:[A-Za-z0-9_]+/g) ?? []).length;

  function flush() {
    const ordered = [...pending].sort((a, b) => {
      const byParameters = parameterCount(a.path) - parameterCount(b.path);
      if (byParameters !== 0) return byParameters;
      // A longer literal path is more specific than a shorter one that prefixes it.
      return b.path.length - a.path.length;
    });
    for (const spec of ordered) register(spec);
    pending.length = 0;
  }

  function register(spec) {
    const shape = NAV_SHAPE[spec.domain] ?? 'linked';
    registry.push({
      path: spec.path,
      domain: spec.domain,
      title: typeof spec.title === 'string' ? spec.title : spec.titleHint ?? spec.path,
      kind: spec.kind ?? 'page',
      shape,
      permission: spec.permission ?? null,
      anonymous: Boolean(spec.anonymous),
      sample: spec.sample ?? spec.path
    });

    app.get(spec.path, async (ctx) => {
      const user = spec.anonymous ? null : requireAuth(ctx);
      if (!spec.anonymous && !user) return;

      if (faults.on('FAULT_SLOW_ELEMENT') && spec.kind === 'dashboard') {
        await new Promise(resolve => setTimeout(resolve, faults.parameter('slowElementMs')));
      }

      const view = await spec.view(ctx, user);
      if (view === undefined || ctx.res.writableEnded) return;

      ctx.html(view.status ?? 200, shell({
        title: view.title,
        user,
        active: spec.domain,
        breadcrumbs: view.breadcrumbs ?? [],
        body: view.body,
        actions: view.actions ?? '',
        script: (view.script ?? '') + (faults.on('FAULT_JS_ERROR') ? '\nundefinedFunctionCall();' : ''),
        flash: takeFlash(ctx),
        // A routed screen boots the router so that a deep link renders client-side,
        // exactly as the real thing does. A linked screen does not carry the router at all.
        routed: shape === 'routed'
      }));
    });

    // The router's data source. One endpoint for every routed screen, which is how a real
    // single-page application works and why a crawler that cannot click finds none of them.
    if (shape === 'routed') {
      viewResolvers.push({ pattern: spec.path, spec });
    }
  }

  /** Patterns the /api/view endpoint can resolve, in registration order. */
  const viewResolvers = [];

  function matchResolver(pathname) {
    for (const resolver of viewResolvers) {
      const names = [];
      const source = resolver.pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/:([A-Za-z0-9_]+)/g, (_, key) => { names.push(key); return '([^/]+)'; });
      const match = new RegExp(`^${source}$`).exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(names.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
      return { spec: resolver.spec, params };
    }
    return null;
  }

  app.get('/api/view', async (ctx) => {
    const user = requireAuth(ctx);
    if (!user) return;
    const target = String(ctx.query.path ?? '');
    const [pathname, search = ''] = target.split('?');
    const matched = matchResolver(pathname);
    if (!matched) return ctx.json(404, { error: 'no_such_view', path: pathname });

    const viewCtx = {
      ...ctx,
      params: matched.params,
      query: Object.fromEntries(new URLSearchParams(search).entries()),
      url: new URL(target, ctx.url.origin)
    };
    const view = await matched.spec.view(viewCtx, user);
    if (!view) return ctx.json(404, { error: 'no_such_view', path: pathname });
    return ctx.json(200, {
      title: view.title,
      html: `${view.breadcrumbs?.length ? `<nav class="crumbs" aria-label="Breadcrumb">${view.breadcrumbs.map((crumb, index) =>
        index === view.breadcrumbs.length - 1
          ? `<span aria-current="page">${escapeHtml(crumb.label)}</span>`
          : `<a href="${crumb.href}">${escapeHtml(crumb.label)}</a>`).join('<span class="crumb-sep">/</span>')}</nav>` : ''}
<div class="page-head"><h1>${escapeHtml(view.title)}</h1>${view.actions ? `<div class="page-actions">${view.actions}</div>` : ''}</div>
${view.body}`
    });
  });

  // ---- helpers domains use ------------------------------------------------

  /** Reads page/size/sort/filter from the query in one consistent way. */
  function listParams(ctx, { defaultSize = 25 } = {}) {
    const page = Math.max(1, Number(ctx.query.page ?? 1) || 1);
    const size = Math.min(100, Math.max(5, Number(ctx.query.size ?? defaultSize) || defaultSize));
    return { page, size, q: String(ctx.query.q ?? ''), sort: String(ctx.query.sort ?? '') };
  }

  const paginate = (rows, page, size) => ({
    slice: rows.slice((page - 1) * size, page * size),
    pageCount: Math.max(1, Math.ceil(rows.length / size))
  });

  return {
    definePage, flush, registry, requireAuth, currentUser, can,
    csrfToken, csrfField, csrfValid, setFlash, takeFlash,
    listParams, paginate
  };
}
