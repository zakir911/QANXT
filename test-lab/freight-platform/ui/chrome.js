/**
 * Page furniture for Meridian Freight.
 *
 * ## Why this file decides what the lab is worth
 *
 * An enterprise application is not one shape. The same product usually carries all three of
 * these at once, because it was built over eight years by four teams:
 *
 *   1. **Linked** — ordinary `<a href>` navigation, server-rendered. A crawler follows it.
 *   2. **Routed** — a client-side router. The nav is `<button>` elements that call
 *      `history.pushState` and swap the view. The URL changes and a deep link works, but
 *      there is no `href` in the DOM for a crawler to follow.
 *   3. **Enclosed** — modals, drawers, tab panels and wizard steps. The content is real and
 *      a user reaches it by clicking, but the URL never changes, so there is no address to
 *      deep-link or enumerate.
 *
 * The lab deliberately carries all three in realistic proportions, because an application
 * built entirely in shape 1 would flatter any crawler, and one built entirely in shape 2
 * would condemn every crawler. Neither result transfers to a real application. What
 * transfers is "it reached 94% of linked screens, 0% of routed screens and 0% of enclosed
 * screens", which names the gap precisely enough to act on.
 *
 * NAV_SHAPE below is the single source of truth for which domain is which, and
 * ground-truth.json is generated from it, so the two cannot drift.
 */
import { escapeHtml } from '../../shared/http.js';

/**
 * How each domain is navigated. Chosen to mirror how enterprise products actually age:
 * the oldest modules are server-rendered, the modules rewritten most recently are routed,
 * and the workflows bolted on last live in modals.
 */
export const NAV_SHAPE = {
  dashboard: 'linked',
  shipments: 'linked',
  orders: 'linked',
  warehouse: 'linked',
  carriers: 'linked',
  customers: 'linked',
  billing: 'linked',
  customs: 'linked',
  fleet: 'routed',
  routes: 'routed',
  claims: 'routed',
  admin: 'routed',
  reports: 'linked'
};

export const DOMAINS = [
  { key: 'dashboard', label: 'Dashboard', path: '/dashboard', icon: '▦' },
  { key: 'shipments', label: 'Shipments', path: '/shipments', icon: '▸' },
  { key: 'orders', label: 'Orders', path: '/orders', icon: '≡' },
  { key: 'warehouse', label: 'Warehouse', path: '/warehouse', icon: '▣' },
  { key: 'routes', label: 'Routes', path: '/routes', icon: '⇢' },
  { key: 'fleet', label: 'Fleet', path: '/fleet', icon: '▤' },
  { key: 'carriers', label: 'Carriers', path: '/carriers', icon: '◈' },
  { key: 'customers', label: 'Customers', path: '/customers', icon: '◉' },
  { key: 'billing', label: 'Billing', path: '/billing', icon: '£' },
  { key: 'customs', label: 'Customs', path: '/customs', icon: '⚑' },
  { key: 'claims', label: 'Claims', path: '/claims', icon: '⚠' },
  { key: 'reports', label: 'Reports', path: '/reports', icon: '◲' },
  { key: 'admin', label: 'Admin', path: '/admin', icon: '⚙' }
];

/**
 * The full chrome: masthead, sidebar, breadcrumb, content.
 *
 * `navShape` controls how the sidebar is rendered for the whole application, not per link:
 * a real product's sidebar is one component, and whether it emits anchors or buttons is a
 * property of that component. Domains whose NAV_SHAPE is 'routed' are emitted as buttons
 * even in the linked sidebar, which is exactly what a half-migrated product looks like.
 */
export function shell({
  title,
  user,
  active = '',
  breadcrumbs = [],
  body,
  actions = '',
  script = '',
  flash = null,
  routed = false,
  subNav = []
}) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · Meridian Freight</title>
<style>${CSS}</style>
</head>
<body>
<header class="masthead">
  <span class="brand" data-testid="brand">Meridian Freight</span>
  <span class="env-badge">Synthetic lab</span>
  <div class="masthead-right">
    <button type="button" class="icon-button" data-testid="open-notifications" aria-label="Notifications" aria-haspopup="dialog">◔<span class="badge-dot" data-testid="notification-count">4</span></button>
    <button type="button" class="icon-button" data-testid="open-user-menu" aria-label="Account menu" aria-expanded="false" aria-haspopup="menu">${escapeHtml(user?.displayName ?? 'Signed out')} ▾</button>
  </div>
</header>
<div class="frame">
  <nav class="sidebar" aria-label="Sections">
    ${DOMAINS.map(domain => navItem(domain, active)).join('')}
  </nav>
  <main class="content" id="view-root" data-testid="view-root">
    ${breadcrumbs.length ? `<nav class="crumbs" aria-label="Breadcrumb">${breadcrumbs.map((crumb, index) =>
      index === breadcrumbs.length - 1
        ? `<span aria-current="page">${escapeHtml(crumb.label)}</span>`
        : `<a href="${crumb.href}">${escapeHtml(crumb.label)}</a>`).join('<span class="crumb-sep">/</span>')}</nav>` : ''}
    ${subNav.length ? `<nav class="subnav" aria-label="Section pages">${subNav.map(entry =>
      entry.routed
        ? `<button type="button" class="subnav-link${entry.current ? ' current' : ''}" role="link"
            data-route="${entry.href}" data-testid="subnav-${escapeHtml(entry.key)}"${entry.current ? ' aria-current="page"' : ''}>${escapeHtml(entry.label)}</button>`
        : `<a class="subnav-link${entry.current ? ' current' : ''}" href="${entry.href}"
            data-testid="subnav-${escapeHtml(entry.key)}"${entry.current ? ' aria-current="page"' : ''}>${escapeHtml(entry.label)}</a>`
      ).join('')}</nav>` : ''}
    <div class="page-head">
      <h1>${escapeHtml(title)}</h1>
      ${actions ? `<div class="page-actions">${actions}</div>` : ''}
    </div>
    ${flash ? `<div class="flash flash-${escapeHtml(flash.kind)}" role="${flash.kind === 'error' ? 'alert' : 'status'}" data-testid="flash">${escapeHtml(flash.message)}</div>` : ''}
    ${body}
  </main>
</div>

<!-- The notification drawer and user menu are "enclosed" screens: real content, reachable
     only by clicking, with no address of their own. -->
<div class="drawer" id="notification-drawer" data-testid="notification-drawer" role="dialog" aria-label="Notifications" aria-modal="false" hidden>
  <div class="drawer-head"><strong>Notifications</strong><button type="button" class="icon-button" data-testid="close-notifications" aria-label="Close">✕</button></div>
  <ul class="drawer-list">
    <li><strong>Customs hold</strong><span>MF770039 held at Rotterdam pending documentation.</span></li>
    <li><strong>MOT due</strong><span>Vehicle MF42 KLM expires in 9 days.</span></li>
    <li><strong>Credit limit</strong><span>Quayside Seafood is at 94% of its limit.</span></li>
    <li><strong>Integration degraded</strong><span>Accounting ledger has failed 31 times.</span></li>
  </ul>
</div>
<div class="menu" id="user-menu" data-testid="user-menu" role="menu" hidden>
  <a role="menuitem" href="/account/profile" data-testid="menu-profile">Your profile</a>
  <a role="menuitem" href="/account/preferences" data-testid="menu-preferences">Preferences</a>
  <a role="menuitem" href="/account/sessions" data-testid="menu-sessions">Active sessions</a>
  <form method="post" action="/auth/sign-out"><button role="menuitem" type="submit" data-testid="menu-sign-out">Sign out</button></form>
</div>

<script type="module">
${CHROME_SCRIPT}
${ROUTER_SCRIPT}
${script}
</script>
</body>
</html>`;
}

function navItem(domain, active) {
  const isActive = active === domain.key;
  const label = `<span class="nav-icon" aria-hidden="true">${domain.icon}</span>${escapeHtml(domain.label)}`;
  // A routed domain emits a button, not an anchor. This is the whole point of the lab:
  // the control is visible, keyboard-reachable and obviously navigation to a person, and
  // carries no href for a crawler to follow.
  if (NAV_SHAPE[domain.key] === 'routed') {
    return `<button type="button" class="nav-link${isActive ? ' active' : ''}" role="link"
      data-route="${domain.path}" data-testid="nav-${domain.key}"${isActive ? ' aria-current="page"' : ''}>${label}</button>`;
  }
  return `<a class="nav-link${isActive ? ' active' : ''}" href="${domain.path}"
    data-testid="nav-${domain.key}"${isActive ? ' aria-current="page"' : ''}>${label}</a>`;
}

/** Opens and closes the enclosed surfaces. Present on every page. */
const CHROME_SCRIPT = `
const byId = (id) => document.getElementById(id);
const toggle = (element, open) => { if (element) element.hidden = !open; };

document.querySelector('[data-testid="open-notifications"]')?.addEventListener('click', () => {
  const drawer = byId('notification-drawer');
  toggle(drawer, drawer.hidden);
});
document.querySelector('[data-testid="close-notifications"]')?.addEventListener('click', () => toggle(byId('notification-drawer'), false));

const userMenuButton = document.querySelector('[data-testid="open-user-menu"]');
userMenuButton?.addEventListener('click', () => {
  const menu = byId('user-menu');
  const open = menu.hidden;
  toggle(menu, open);
  userMenuButton.setAttribute('aria-expanded', String(open));
});

// Tabs: panels that exist in the DOM but are only reachable by clicking.
for (const tablist of document.querySelectorAll('[role="tablist"]')) {
  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab) return;
    const panelId = tab.getAttribute('aria-controls');
    for (const other of tablist.querySelectorAll('[role="tab"]')) {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      const panel = document.getElementById(other.getAttribute('aria-controls'));
      if (panel) panel.hidden = !selected;
    }
    document.getElementById(panelId)?.focus?.();
  });
}

// Modals: opened by a trigger, closed by its dismiss control or Escape.
for (const trigger of document.querySelectorAll('[data-opens-modal]')) {
  trigger.addEventListener('click', () => {
    const modal = document.getElementById(trigger.dataset.opensModal);
    if (!modal) return;
    modal.hidden = false;
    modal.querySelector('input,select,textarea,button')?.focus();
  });
}
for (const dismiss of document.querySelectorAll('[data-closes-modal]')) {
  dismiss.addEventListener('click', () => {
    const modal = document.getElementById(dismiss.dataset.closesModal);
    if (modal) modal.hidden = true;
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const modal of document.querySelectorAll('.modal:not([hidden])')) modal.hidden = true;
});
`;

/**
 * The client-side router, loaded on every page.
 *
 * Fetches a JSON view description and renders it, pushing the new URL. A deep link to a
 * routed path works because the server serves the shell and the router renders on load.
 * What does not exist, anywhere, is an anchor a crawler could follow to get there.
 *
 * It used to load only on routed pages, which was wrong in a way worth recording: the
 * sidebar renders a routed domain as a `data-route` button on EVERY page, so on a linked
 * page those buttons had no handler and clicking "Fleet" from the dashboard did nothing
 * at all. A person could only reach those four domains by typing the URL. The first
 * navigation-mode measurement scored 0 of 37 routed screens and the cause was this, not
 * the crawler. A real half-migrated application loads its router in the shell, globally,
 * which is what this now does.
 */
const ROUTER_SCRIPT = `
async function renderRoute(path, push) {
  const root = document.getElementById('view-root');
  root.setAttribute('aria-busy', 'true');
  const response = await fetch('/api/view?path=' + encodeURIComponent(path), { headers: { accept: 'application/json' } });
  if (!response.ok) {
    root.innerHTML = '<div class="flash flash-error" role="alert" data-testid="flash">That view could not be loaded.</div>';
    root.removeAttribute('aria-busy');
    return;
  }
  const view = await response.json();
  document.title = view.title + ' · Meridian Freight';
  root.innerHTML = view.html;
  root.removeAttribute('aria-busy');
  if (push) history.pushState({ path }, '', path);
  for (const button of root.querySelectorAll('[data-route]')) {
    button.addEventListener('click', () => renderRoute(button.dataset.route, true));
  }
  document.dispatchEvent(new CustomEvent('view:rendered', { detail: { path } }));
}

for (const button of document.querySelectorAll('[data-route]')) {
  button.addEventListener('click', () => renderRoute(button.dataset.route, true));
}
window.addEventListener('popstate', (event) => {
  if (event.state?.path) renderRoute(event.state.path, false);
});
`;

export const CSS = `
:root{--ink:#131a26;--muted:#5d6b80;--line:#dfe5ee;--bg:#f4f6fa;--panel:#fff;--brand:#10243f;--accent:#1457d6;--danger:#b32020;--warn:#9a6508;--ok:#0f7a52;--radius:8px}
*{box-sizing:border-box}
body{margin:0;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
a{color:var(--accent)}
.masthead{display:flex;align-items:center;gap:14px;background:var(--brand);color:#fff;padding:10px 18px;position:sticky;top:0;z-index:40}
.brand{font-weight:700;letter-spacing:.2px}
.env-badge{font-size:11px;background:rgba(255,255,255,.16);padding:2px 8px;border-radius:999px}
.masthead-right{margin-left:auto;display:flex;gap:8px;align-items:center}
.icon-button{background:rgba(255,255,255,.1);color:#fff;border:0;padding:6px 12px;border-radius:var(--radius);cursor:pointer;font-size:13px;position:relative}
.icon-button:hover{background:rgba(255,255,255,.2)}
.badge-dot{background:#e8513c;border-radius:999px;font-size:10px;padding:1px 5px;margin-left:5px}
.frame{display:flex;min-height:calc(100vh - 44px)}
.sidebar{width:198px;flex:0 0 198px;background:#fff;border-right:1px solid var(--line);padding:10px 8px;display:flex;flex-direction:column;gap:1px}
.nav-link{display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:6px;color:var(--ink);text-decoration:none;font-size:14px;background:none;border:0;width:100%;text-align:left;cursor:pointer;font-family:inherit}
.nav-link:hover{background:#eef2f9}
.nav-link.active{background:#e6edfb;color:var(--accent);font-weight:600}
.nav-icon{opacity:.6;width:14px;display:inline-block}
.content{flex:1;padding:18px 24px 64px;max-width:1220px;min-width:0}
.crumbs{font-size:13px;color:var(--muted);margin-bottom:8px}
.subnav{display:flex;gap:4px;flex-wrap:wrap;margin:0 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.subnav-link{font:inherit;font-size:13px;padding:4px 10px;border-radius:999px;background:#fff;border:1px solid var(--line);color:var(--ink);text-decoration:none;cursor:pointer;white-space:nowrap}
.subnav-link:hover{background:#eef2f9}
.subnav-link.current{background:#e6edfb;border-color:#c5d4f6;color:var(--accent);font-weight:600}
.crumbs a{color:var(--muted)}
.crumb-sep{margin:0 6px;opacity:.6}
.page-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:14px}
h1{font-size:23px;margin:0}
h2{font-size:16px;margin:22px 0 9px}
h3{font-size:14px;margin:16px 0 7px}
.page-actions{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:15px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
th,td{text-align:left;padding:8px 11px;border-bottom:1px solid var(--line);font-size:13.5px;vertical-align:top}
th{background:#f7f9fc;font-weight:600;font-size:12.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted)}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:#fafcff}
.table-wrap{overflow-x:auto}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:600;border:1px solid}
.pill-ok{background:#e7f6ef;color:var(--ok);border-color:#b9e4d1}
.pill-warn{background:#fdf3e2;color:var(--warn);border-color:#f0d9ae}
.pill-danger{background:#fdeaea;color:var(--danger);border-color:#f3c4c4}
.pill-info{background:#e9eefc;color:var(--accent);border-color:#c5d4f6}
.pill-muted{background:#eef1f6;color:var(--muted);border-color:#dde3ec}
.btn{display:inline-block;background:var(--accent);color:#fff;border:1px solid var(--accent);padding:7px 14px;border-radius:6px;font-size:13.5px;cursor:pointer;text-decoration:none;font-family:inherit}
.btn:hover{filter:brightness(1.08)}
.btn-secondary{background:#fff;color:var(--ink);border-color:var(--line)}
.btn-danger{background:var(--danger);border-color:var(--danger)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.field{margin-bottom:13px}
.field label,.label{display:block;font-size:13px;font-weight:600;margin-bottom:4px}
.hint{font-size:12px;color:var(--muted);margin-top:3px}
input[type=text],input[type=email],input[type=password],input[type=number],input[type=date],input[type=time],input[type=tel],input[type=url],input[type=search],select,textarea{
  width:100%;padding:7px 10px;border:1px solid var(--line);border-radius:6px;font:inherit;font-size:14px;background:#fff}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
input[aria-invalid=true],select[aria-invalid=true],textarea[aria-invalid=true]{border-color:var(--danger)}
.error{color:var(--danger);font-size:12.5px;margin-top:3px}
.grid{display:grid;gap:14px}
.grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.grid-4{grid-template-columns:repeat(4,minmax(0,1fr))}
.stat{background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:13px}
.stat .value{font-size:25px;font-weight:700;line-height:1.1}
.stat .caption{font-size:12.5px;color:var(--muted);margin-top:3px}
.flash{padding:10px 13px;border-radius:6px;margin-bottom:14px;font-size:14px;border:1px solid}
.flash-success{background:#e7f6ef;color:var(--ok);border-color:#b9e4d1}
.flash-error{background:#fdeaea;color:var(--danger);border-color:#f3c4c4}
.flash-info{background:#e9eefc;color:var(--accent);border-color:#c5d4f6}
.flash-warn{background:#fdf3e2;color:var(--warn);border-color:#f0d9ae}
.filters{display:flex;gap:9px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px}
.filters .field{margin:0;min-width:150px}
[role=tablist]{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:14px;flex-wrap:wrap}
[role=tab]{background:none;border:0;border-bottom:2px solid transparent;padding:8px 13px;font:inherit;font-size:13.5px;cursor:pointer;color:var(--muted)}
[role=tab][aria-selected=true]{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.drawer{position:fixed;top:44px;right:0;width:330px;height:calc(100vh - 44px);background:#fff;border-left:1px solid var(--line);box-shadow:-6px 0 22px rgba(16,36,63,.1);z-index:50;overflow:auto}
.drawer-head{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-bottom:1px solid var(--line)}
.drawer-head .icon-button{background:#eef2f9;color:var(--ink)}
.drawer-list{list-style:none;margin:0;padding:0}
.drawer-list li{padding:11px 15px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:3px;font-size:13px}
.drawer-list strong{font-size:13px}
.drawer-list span{color:var(--muted)}
.menu{position:fixed;top:44px;right:12px;background:#fff;border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 8px 24px rgba(16,36,63,.14);z-index:60;min-width:180px;padding:5px}
.menu a,.menu button{display:block;width:100%;text-align:left;padding:8px 11px;border-radius:5px;color:var(--ink);text-decoration:none;font:inherit;font-size:13.5px;background:none;border:0;cursor:pointer}
.menu a:hover,.menu button:hover{background:#eef2f9}
/* [hidden] is display:none in the UA stylesheet, and a class setting display beats it on
   specificity. Without the second rule every modal was a full-screen overlay sitting over
   the page, swallowing clicks on the three detail screens that carry one — and the markup
   said hidden, so an HTML-only check passed. */
.modal{position:fixed;inset:0;background:rgba(16,36,63,.42);display:flex;align-items:center;justify-content:center;z-index:70;padding:20px}
.modal[hidden]{display:none}
.modal-card{background:#fff;border-radius:10px;padding:20px;max-width:560px;width:100%;max-height:88vh;overflow:auto}
.modal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.modal-head h2{margin:0}
.steps{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap}
.step{padding:5px 12px;border-radius:999px;font-size:12.5px;background:#eef1f6;color:var(--muted);border:1px solid var(--line)}
.step.current{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:600}
.step.done{background:#e7f6ef;color:var(--ok);border-color:#b9e4d1}
.timeline{list-style:none;margin:0;padding:0;border-left:2px solid var(--line);margin-left:7px}
.timeline li{position:relative;padding:0 0 15px 18px;font-size:13.5px}
.timeline li::before{content:'';position:absolute;left:-6px;top:5px;width:10px;height:10px;border-radius:50%;background:var(--accent)}
.timeline time{display:block;color:var(--muted);font-size:12px}
.empty{text-align:center;color:var(--muted);padding:34px 14px;font-size:14px}
.kv{display:grid;grid-template-columns:168px 1fr;gap:7px 14px;font-size:13.5px}
.kv dt{color:var(--muted)}
.kv dd{margin:0}
.pagination{display:flex;gap:6px;align-items:center;margin-top:12px;font-size:13px}
.pagination a,.pagination span{padding:5px 10px;border:1px solid var(--line);border-radius:5px;text-decoration:none;color:var(--ink);background:#fff}
.pagination .current{background:var(--accent);color:#fff;border-color:var(--accent)}
.required-mark{color:var(--danger);margin-left:2px}
@media (max-width:860px){
  .frame{flex-direction:column}
  .sidebar{width:100%;flex:none;flex-direction:row;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line)}
  .nav-link{white-space:nowrap}
  .grid-4,.grid-3,.grid-2{grid-template-columns:1fr}
  .content{padding:14px 16px 48px}
}
`;

// ---------------------------------------------------------------------------
// Component builders
// ---------------------------------------------------------------------------

export const h = escapeHtml;

export function statusPill(status) {
  const map = {
    active: 'ok', delivered: 'ok', paid: 'ok', released: 'ok', completed: 'ok', approved: 'ok',
    accepted: 'ok', received: 'ok', settled: 'ok', available: 'ok', connected: 'ok', closed: 'ok',
    draft: 'muted', prospect: 'muted', pending: 'muted', planned: 'muted', sent: 'muted',
    booked: 'info', inTransit: 'info', collected: 'info', submitted: 'info', issued: 'info',
    dispatched: 'info', inProgress: 'info', investigating: 'info', allocated: 'info', onLeave: 'muted',
    customsHold: 'warn', held: 'warn', awaitingApproval: 'warn', awaitingEvidence: 'warn',
    overdue: 'warn', disputed: 'warn', degraded: 'warn', partiallyReceived: 'warn',
    outForDelivery: 'warn', onHold: 'warn', inMaintenance: 'warn', creditNoted: 'warn',
    exception: 'danger', cancelled: 'danger', rejected: 'danger', suspended: 'danger',
    expired: 'danger', failed: 'danger', offRoad: 'danger', disconnected: 'danger'
  };
  const label = String(status).replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
  return `<span class="pill pill-${map[status] ?? 'muted'}" data-status="${h(status)}">${h(label)}</span>`;
}

export const money = (value, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value ?? 0);

export const shortDate = (value) => value ? String(value).slice(0, 10) : '—';

export const dateTime = (value) => value ? String(value).replace('T', ' ').slice(0, 16) : '—';

/** A data table with a caption a screen reader can use and an honest empty state. */
export function table({ caption, columns, rows, empty = 'Nothing to show.', testId }) {
  if (!rows.length) return `<div class="panel"><div class="empty" data-testid="${h(testId)}-empty">${h(empty)}</div></div>`;
  return `<div class="table-wrap"><table data-testid="${h(testId)}">
<caption class="sr-only" style="position:absolute;left:-9999px">${h(caption)}</caption>
<thead><tr>${columns.map(c => `<th scope="col">${h(c.header)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((row, index) => `<tr data-row-index="${index}">${columns.map(c =>
  `<td>${c.cell(row, index)}</td>`).join('')}</tr>`).join('')}</tbody>
</table></div>`;
}

/**
 * A form field. `error` renders an `aria-describedby`-linked message, which is what makes
 * validation observable rather than merely coloured.
 */
export function field({
  name, label, type = 'text', value = '', required = false, hint = '', error = '',
  options = null, attrs = {}, testId = null, rows = 3
}) {
  const id = `f-${name}`;
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  const common = [
    `id="${id}"`, `name="${h(name)}"`,
    `data-testid="${h(testId ?? name)}"`,
    required ? 'required' : '',
    error ? 'aria-invalid="true"' : '',
    describedBy ? `aria-describedby="${describedBy}"` : '',
    ...Object.entries(attrs).map(([key, val]) => val === true ? key : `${key}="${h(val)}"`)
  ].filter(Boolean).join(' ');

  let control;
  if (options) {
    control = `<select ${common}>${options.map(option => {
      const optionValue = typeof option === 'string' ? option : option.value;
      const optionLabel = typeof option === 'string' ? option : option.label;
      return `<option value="${h(optionValue)}"${String(value) === String(optionValue) ? ' selected' : ''}>${h(optionLabel)}</option>`;
    }).join('')}</select>`;
  } else if (type === 'textarea') {
    control = `<textarea ${common} rows="${rows}">${h(value)}</textarea>`;
  } else if (type === 'checkbox') {
    return `<div class="field"><label for="${id}" style="display:flex;gap:8px;align-items:center;font-weight:500">
      <input type="checkbox" ${common} ${value ? 'checked' : ''} style="width:auto" />${h(label)}</label>
      ${hint ? `<div class="hint" id="${id}-hint">${h(hint)}</div>` : ''}
      ${error ? `<div class="error" id="${id}-error">${h(error)}</div>` : ''}</div>`;
  } else {
    control = `<input type="${h(type)}" ${common} value="${h(value)}" />`;
  }

  return `<div class="field">
<label for="${id}">${h(label)}${required ? '<span class="required-mark" aria-hidden="true">*</span>' : ''}</label>
${control}
${hint ? `<div class="hint" id="${id}-hint">${h(hint)}</div>` : ''}
${error ? `<div class="error" id="${id}-error">${h(error)}</div>` : ''}
</div>`;
}

export function stat(value, caption, testId) {
  return `<div class="stat" data-testid="${h(testId)}"><div class="value">${value}</div><div class="caption">${h(caption)}</div></div>`;
}

export function tabs(id, items) {
  return `<div role="tablist" aria-label="Sections" data-testid="${h(id)}-tablist">
${items.map((item, index) => `<button role="tab" id="${h(id)}-tab-${index}" aria-controls="${h(id)}-panel-${index}"
  aria-selected="${index === 0}" data-testid="${h(id)}-tab-${h(item.key)}">${h(item.label)}</button>`).join('')}
</div>
${items.map((item, index) => `<div role="tabpanel" id="${h(id)}-panel-${index}" aria-labelledby="${h(id)}-tab-${index}"
  tabindex="0" data-testid="${h(id)}-panel-${h(item.key)}"${index === 0 ? '' : ' hidden'}>${item.body}</div>`).join('')}`;
}

export function modal(id, title, body) {
  return `<div class="modal" id="${h(id)}" data-testid="${h(id)}" role="dialog" aria-modal="true" aria-label="${h(title)}" hidden>
<div class="modal-card">
<div class="modal-head"><h2>${h(title)}</h2>
<button type="button" class="icon-button" style="background:#eef2f9;color:var(--ink)" data-closes-modal="${h(id)}" aria-label="Close">✕</button></div>
${body}
</div></div>`;
}

export function wizardSteps(steps, currentIndex) {
  return `<div class="steps" data-testid="wizard-steps">${steps.map((label, index) =>
    `<span class="step ${index === currentIndex ? 'current' : index < currentIndex ? 'done' : ''}"
      data-testid="step-${index + 1}"${index === currentIndex ? ' aria-current="step"' : ''}>${index + 1}. ${h(label)}</span>`).join('')}</div>`;
}

export function kv(pairs) {
  return `<dl class="kv">${pairs.map(([key, value]) =>
    `<dt>${h(key)}</dt><dd>${value}</dd>`).join('')}</dl>`;
}

export function pagination(basePath, page, pageCount, query = {}) {
  if (pageCount <= 1) return '';
  const link = (target, label, current = false) => {
    const params = new URLSearchParams({ ...query, page: String(target) });
    return current
      ? `<span class="current" aria-current="page">${h(label)}</span>`
      : `<a href="${basePath}?${params}" data-testid="page-${target}">${h(label)}</a>`;
  };
  const items = [];
  if (page > 1) items.push(link(page - 1, 'Previous'));
  for (let n = 1; n <= pageCount; n += 1) items.push(link(n, String(n), n === page));
  if (page < pageCount) items.push(link(page + 1, 'Next'));
  return `<nav class="pagination" aria-label="Pagination" data-testid="pagination">${items.join('')}
    <span style="border:0;background:none;color:var(--muted)">Page ${page} of ${pageCount}</span></nav>`;
}
