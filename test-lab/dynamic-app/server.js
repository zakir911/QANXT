/**
 * The hostile application.
 *
 * Everything here is designed to defeat a naive locator: element ids and class names are
 * regenerated on every render, wrapper elements come and go so no structural path survives,
 * panels render lazily, a counter arrives late, a banner removes itself, and the feed grows
 * as you scroll. What does *not* change is the accessible surface — roles, labels and test
 * ids — because that is the distinction the product claims to exploit.
 *
 * A locator strategy that works here is one that would survive a real front-end rewrite.
 */
import { createLabApp } from '../shared/http.js';
import { createFaultEngine } from '../shared/faults.js';
import { BASE_CSS } from '../shared/render.js';

const PORT = Number(process.env.DYNAMIC_PORT ?? 4330);
const APPLICATION = 'AIRA Dynamic Lab';

const FAULTS = [
  { id: 'FAULT_DYNAMIC_LOCATOR', description: 'Test ids are regenerated on every render as well as ids and classes.' },
  { id: 'FAULT_SLOW_ELEMENT', description: 'Late content takes much longer to arrive.' },
  { id: 'FAULT_JS_ERROR', description: 'The view renderer throws on the second navigation.' },
  { id: 'FAULT_ELEMENT_DISAPPEARS', description: 'The confirm button vanishes one second after it appears.' },
  { id: 'FAULT_INFINITE_SCROLL_BROKEN', description: 'The feed stops loading after the first page.' }
];

const faults = createFaultEngine(FAULTS, { parameters: { slowElementMs: 2500 } });
const app = createLabApp({ name: APPLICATION, version: '1.0.0', faults });

const FEED_ITEMS = Array.from({ length: 120 }, (_, index) => ({
  id: `item-${String(index + 1).padStart(3, '0')}`,
  title: `Update ${index + 1}`,
  body: `Something changed in area ${String.fromCharCode(65 + (index % 6))}.`,
  severity: ['info', 'warning', 'critical'][index % 3]
}));

const ROUTES = ['/', '/feed', '/widgets', '/dialog', '/late', '/shuffle'];

for (const route of ROUTES) {
  app.get(route, ctx => ctx.html(200, shell()));
}

app.get('/api/feed', (ctx) => {
  const cursor = Number(ctx.query.cursor ?? 0);
  if (faults.on('FAULT_INFINITE_SCROLL_BROKEN') && cursor > 0) {
    return ctx.json(200, { items: [], nextCursor: null });
  }
  const items = FEED_ITEMS.slice(cursor, cursor + 20);
  const nextCursor = cursor + 20 < FEED_ITEMS.length ? cursor + 20 : null;
  return ctx.json(200, { items, nextCursor, total: FEED_ITEMS.length });
});

app.get('/api/config', ctx => ctx.json(200, {
  dynamicTestIds: faults.on('FAULT_DYNAMIC_LOCATOR'),
  lateMs: faults.on('FAULT_SLOW_ELEMENT') ? faults.parameter('slowElementMs') * 4 : faults.parameter('slowElementMs'),
  jsError: faults.on('FAULT_JS_ERROR'),
  disappearing: faults.on('FAULT_ELEMENT_DISAPPEARS')
}));

app.post('/__reset', ctx => ctx.json(200, { reset: true, faults: faults.reset() }));

/**
 * The whole client, served as one document.
 *
 * Kept in a single template on purpose: this application exists to be read while a test
 * against it is failing, and chasing behaviour across five files at that moment helps
 * nobody.
 */
function shell() {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${APPLICATION}</title>
<style>${BASE_CSS}
.feed-item{background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-bottom:8px}
.sentinel{height:24px}
</style>
</head>
<body>
<header class="masthead">
  <span class="brand" data-testid="brand">${APPLICATION}</span>
  <nav class="nav" aria-label="Main" id="nav"></nav>
</header>
<main class="content" id="view" aria-live="polite"></main>
<footer class="footer">Ids and class names change on every render. Test ids and roles do not, unless you ask for that.</footer>

<script type="module">
const NAV = [['/feed','Feed','nav-feed'],['/widgets','Widgets','nav-widgets'],
             ['/dialog','Dialog','nav-dialog'],['/late','Late content','nav-late'],['/shuffle','Shuffle','nav-shuffle']];

let config = { dynamicTestIds: false, lateMs: 2500, jsError: false, disappearing: false };
let navigations = 0;

// A fresh identifier for every element on every render: this is what a framework that
// hashes ids at build time does, and it is what a recorded CSS path cannot survive.
const uid = () => 'e' + Math.random().toString(36).slice(2, 8);
const tid = (name) => config.dynamicTestIds ? name + '--' + uid() : name;

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  node.id = uid();
  node.className = (attributes.class ?? '') + ' c' + uid();
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * Wraps content in a random number of nested divs.
 *
 * The hierarchy above an element is therefore different on every render, so a locator that
 * describes a path — div > div > section > button — is wrong the moment it is written.
 */
function shuffleWrap(node) {
  let wrapped = node;
  for (let depth = 0; depth < 1 + Math.floor(Math.random() * 3); depth++) {
    wrapped = el('div', { class: 'wrap' }, [wrapped]);
  }
  return wrapped;
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(...NAV.map(([path, label, id]) => el('a', {
    href: path, 'data-testid': tid(id),
    class: location.pathname === path ? 'active' : '',
    onclick: (event) => { event.preventDefault(); go(path); }
  }, label)));
}

function go(path) {
  history.pushState({}, '', path);
  render();
}
window.addEventListener('popstate', () => render());

async function render() {
  navigations++;
  if (config.jsError && navigations === 2) {
    throw new Error('LAB_FAULT_JS_ERROR: the view renderer failed on navigation ' + navigations);
  }

  renderNav();
  const view = document.getElementById('view');
  view.replaceChildren(el('p', { class: 'muted', 'data-testid': tid('view-loading') }, 'Rendering…'));

  const path = location.pathname;
  const content = path === '/feed' ? await feedView()
    : path === '/widgets' ? widgetsView()
    : path === '/dialog' ? dialogView()
    : path === '/late' ? lateView()
    : path === '/shuffle' ? shuffleView()
    : homeView();

  view.replaceChildren(shuffleWrap(content));
}

function homeView() {
  return el('section', {}, [
    el('h1', { 'data-testid': tid('page-title') }, 'Dynamic application'),
    el('p', { class: 'muted', 'data-testid': tid('intro') },
      'Every element below has a fresh id and class on each render. Choose a view from the navigation.'),
    el('ul', {}, NAV.map(([path, label, id]) =>
      el('li', {}, [el('a', { href: path, 'data-testid': tid('home-' + id), onclick: (event) => { event.preventDefault(); go(path); } }, label)])))
  ]);
}

// ---- Feed: infinite scrolling -------------------------------------------
async function feedView() {
  const list = el('div', { 'data-testid': tid('feed-list') });
  const status = el('p', { class: 'muted', 'data-testid': tid('feed-status') }, 'Loading…');
  const sentinel = el('div', { class: 'sentinel', 'data-testid': tid('feed-sentinel') });
  let cursor = 0;
  let loading = false;
  let done = false;

  const loadMore = async () => {
    if (loading || done) return;
    loading = true;
    status.textContent = 'Loading more…';
    const response = await fetch('/api/feed?cursor=' + cursor);
    const page = await response.json();
    for (const item of page.items) {
      list.append(el('article', { class: 'feed-item', 'data-testid': tid('feed-item-' + item.id) }, [
        el('strong', {}, item.title),
        el('span', { class: 'pill', 'data-testid': tid('feed-severity-' + item.id) }, item.severity),
        el('p', { class: 'muted' }, item.body)
      ]));
    }
    cursor = page.nextCursor ?? cursor;
    done = page.nextCursor === null;
    status.textContent = done
      ? 'All ' + list.childElementCount + ' updates loaded.'
      : list.childElementCount + ' of ' + page.total + ' updates loaded. Scroll for more.';
    loading = false;
  };

  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) void loadMore();
  });
  setTimeout(() => observer.observe(sentinel), 0);
  await loadMore();

  return el('section', {}, [
    el('h1', { 'data-testid': tid('page-title') }, 'Feed'),
    status, list, sentinel
  ]);
}

// ---- Widgets: tabs, a late counter, a self-removing banner ---------------
function widgetsView() {
  const panel = el('div', { 'data-testid': tid('tab-panel'), role: 'tabpanel' }, 'Choose a tab.');
  const tabs = ['Summary', 'Details', 'History'].map((label, index) => el('button', {
    type: 'button', role: 'tab', 'aria-selected': String(index === 0),
    'data-testid': tid('tab-' + label.toLowerCase()),
    onclick: (event) => {
      for (const other of event.target.parentElement.children) other.setAttribute('aria-selected', 'false');
      event.target.setAttribute('aria-selected', 'true');
      // Panels render lazily, and each render rebuilds the subtree from scratch.
      panel.replaceChildren(el('div', { 'data-testid': tid('panel-' + label.toLowerCase()) }, [
        el('h2', {}, label),
        el('p', {}, 'Panel content for ' + label + ', rendered at ' + new Date().toISOString())
      ]));
    }
  }, label));

  const banner = el('p', { class: 'confirmation', 'data-testid': tid('temporary-banner') },
    'This banner removes itself in three seconds.');
  setTimeout(() => banner.remove(), 3000);

  const counterSlot = el('p', { 'data-testid': tid('counter-slot') }, 'Counting…');
  setTimeout(() => {
    counterSlot.replaceChildren(el('span', { 'data-testid': tid('counter-value') }, '42'));
  }, config.lateMs);

  return el('section', {}, [
    el('h1', { 'data-testid': tid('page-title') }, 'Widgets'),
    banner,
    el('div', { class: 'tabs', role: 'tablist', 'data-testid': tid('tab-list') }, tabs),
    panel,
    counterSlot
  ]);
}

// ---- Dialog: nested components and a confirm flow -----------------------
function dialogView() {
  const outcome = el('p', { 'data-testid': tid('dialog-outcome') }, 'Nothing confirmed yet.');

  const open = el('button', { type: 'button', class: 'primary', 'data-testid': tid('open-dialog'),
    onclick: () => {
      const confirm = el('button', { type: 'button', class: 'primary', 'data-testid': tid('confirm-action'),
        onclick: () => { outcome.textContent = 'Confirmed'; backdrop.remove(); } }, 'Confirm');

      // Under the disappearing fault the control removes itself a second after it appears:
      // a test that finds it and then pauses will click into empty space.
      if (config.disappearing) setTimeout(() => confirm.remove(), 1000);

      const backdrop = el('div', { class: 'modal-backdrop', 'data-testid': tid('dialog-backdrop') }, [
        el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Confirm the action' }, [
          el('h2', {}, 'Are you sure?'),
          el('p', { class: 'muted' }, 'This dialog is built fresh each time it opens.'),
          el('div', { class: 'row' }, [
            confirm,
            el('button', { type: 'button', 'data-testid': tid('cancel-action'),
              onclick: () => { outcome.textContent = 'Cancelled'; backdrop.remove(); } }, 'Cancel')
          ])
        ])
      ]);
      document.body.append(backdrop);
    } }, 'Open the dialog');

  return el('section', {}, [
    el('h1', { 'data-testid': tid('page-title') }, 'Dialog'),
    open,
    outcome
  ]);
}

// ---- Late content -------------------------------------------------------
function lateView() {
  const slot = el('div', { 'data-testid': tid('late-slot') }, [
    el('p', { class: 'muted', 'data-testid': tid('late-pending') }, 'The content is still loading…')
  ]);
  setTimeout(() => {
    slot.replaceChildren(el('p', { 'data-testid': tid('late-content') }, 'The late content has arrived.'));
  }, config.lateMs);

  return el('section', {}, [
    el('h1', { 'data-testid': tid('page-title') }, 'Late content'),
    el('p', { class: 'muted' }, 'Arrives after ' + config.lateMs + 'ms.'),
    slot
  ]);
}

// ---- Shuffle: the hierarchy changes on every re-render ------------------
function shuffleView() {
  const target = el('button', { type: 'button', class: 'primary', 'data-testid': tid('shuffle-target'),
    onclick: () => { counter++; output.textContent = 'Pressed ' + counter + ' time(s)'; } }, 'Press me');
  const output = el('p', { 'data-testid': tid('shuffle-output') }, 'Pressed 0 time(s)');
  let counter = 0;

  const rerender = el('button', { type: 'button', 'data-testid': tid('shuffle-rerender'),
    onclick: () => render() }, 'Re-render the page');

  return el('section', {}, [
    el('h1', { 'data-testid': tid('page-title') }, 'Shuffle'),
    el('p', { class: 'muted' }, 'Each render nests this button under a different number of wrappers.'),
    shuffleWrap(shuffleWrap(target)),
    output,
    rerender
  ]);
}

config = await (await fetch('/api/config')).json();
await render();
</script>
</body>
</html>`;
}

await app.listen(PORT);
