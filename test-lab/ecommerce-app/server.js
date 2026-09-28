/**
 * QA NXT Demo Commerce.
 *
 * The lab's multi-step business journey: sign in, search, open a product, add it to a
 * basket, change the quantity, apply a coupon, check out with an address and a card, and
 * receive an order confirmation. Each step depends on the one before it, which is what
 * makes it a fair test of a generated journey — a test that skips a step cannot pass by
 * accident, and a test that loses the session halfway shows it.
 *
 * Prices, stock and coupons are held server-side and recomputed on every request, so a
 * total shown on screen can be checked against what the server believes.
 */
import { createLabApp, escapeHtml } from '../shared/http.js';
import { createFaultEngine } from '../shared/faults.js';
import { SESSION_COOKIE, createSessionStore } from '../shared/sessions.js';
import { layout } from '../shared/render.js';

const PORT = Number(process.env.COMMERCE_PORT ?? 4310);
const APPLICATION = 'QA NXT Demo Commerce';

const FAULTS = [
  { id: 'FAULT_LOGIN_BUTTON_RENAMED', description: 'The sign-in control is relabelled and re-identified.' },
  { id: 'FAULT_API_500', description: 'The product search API answers 500.' },
  { id: 'FAULT_SLOW_ELEMENT', description: 'The product grid is rendered after a delay.' },
  { id: 'FAULT_COUPON_IGNORED', description: 'A coupon is accepted on screen but never applied to the total.' },
  { id: 'FAULT_WRONG_TOTAL', description: 'The basket total is miscalculated.' },
  { id: 'FAULT_CHECKOUT_500', description: 'Placing the order fails with HTTP 500.' },
  { id: 'FAULT_DYNAMIC_LOCATOR', description: 'Product tiles carry per-session test ids.' },
  { id: 'FAULT_JS_ERROR', description: 'The basket script throws.' },
  { id: 'FAULT_OUT_OF_STOCK_HIDDEN', description: 'An out-of-stock product can still be added to the basket.' }
];

const faults = createFaultEngine(FAULTS, { parameters: { slowElementMs: 3500 } });
const sessions = createSessionStore({ maxFailedAttempts: 5 });
const app = createLabApp({ name: APPLICATION, version: '1.0.0', faults });

const USERS = [{ id: 'usr-shopper', username: 'alice', password: 'Password123!', displayName: 'Alice Fernsby' }];

const PRODUCTS = [
  { id: 'p-101', name: 'Field Notebook', category: 'Stationery', price: 8.5, stock: 24, blurb: 'Pocket-sized, squared paper, 96 pages.' },
  { id: 'p-102', name: 'Fountain Pen', category: 'Stationery', price: 42, stock: 6, blurb: 'Medium nib, converter included.' },
  { id: 'p-103', name: 'Desk Lamp', category: 'Home', price: 64.99, stock: 11, blurb: 'Warm LED, three brightness levels.' },
  { id: 'p-104', name: 'Ceramic Mug', category: 'Home', price: 14, stock: 40, blurb: 'Stoneware, 350 ml, dishwasher safe.' },
  { id: 'p-105', name: 'Cable Organiser', category: 'Office', price: 11.25, stock: 0, blurb: 'Six clips, adhesive backing. Out of stock.' },
  { id: 'p-106', name: 'Monitor Stand', category: 'Office', price: 89, stock: 4, blurb: 'Beech, two heights, cable channel.' },
  { id: 'p-107', name: 'Travel Flask', category: 'Outdoors', price: 27.5, stock: 15, blurb: 'Keeps drinks hot for eight hours.' },
  { id: 'p-108', name: 'Rain Shell', category: 'Outdoors', price: 128, stock: 3, blurb: 'Two-layer, taped seams, packs small.' },
  { id: 'p-109', name: 'Reading Light', category: 'Home', price: 19.99, stock: 21, blurb: 'Clip-on, rechargeable.' },
  { id: 'p-110', name: 'Index Cards', category: 'Stationery', price: 4.75, stock: 60, blurb: 'Pack of 200, ruled.' },
  { id: 'p-111', name: 'Laptop Sleeve', category: 'Office', price: 34, stock: 9, blurb: 'Felt, fits 14 inch.' },
  { id: 'p-112', name: 'Trail Socks', category: 'Outdoors', price: 16.5, stock: 33, blurb: 'Merino blend, two pairs.' }
];

const COUPONS = { SAVE10: { kind: 'percent', value: 10 }, FIVEOFF: { kind: 'amount', value: 5 } };
const PAGE_SIZE = 6;

/** Basket and order state, keyed by session token. */
const baskets = new Map();
let orders = [];

const nav = [
  ['/products', 'Shop', 'nav-products'],
  ['/cart', 'Basket', 'nav-cart'],
  ['/orders', 'Orders', 'nav-orders']
];

const tid = (name, salt) => `data-testid="${faults.on('FAULT_DYNAMIC_LOCATOR') && salt ? `${name}--${salt}` : name}"`;
const money = (value) => `£${value.toFixed(2)}`;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function shopper(ctx) {
  const { session } = sessions.resolve(ctx.cookies[SESSION_COOKIE]);
  return session ?? null;
}

function requireShopper(handler) {
  return async (ctx) => {
    const session = shopper(ctx);
    if (!session) return ctx.redirect('/login', 303);
    ctx.session = session;
    ctx.basket = baskets.get(session.token) ?? { lines: [], coupon: null };
    return handler(ctx);
  };
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

app.get('/', ctx => ctx.redirect('/login'));

app.get('/login', ctx => ctx.html(200, layout({
  title: 'Sign in',
  application: APPLICATION,
  body: `
<h1 data-testid="page-title">Sign in to shop</h1>
<form method="post" action="/login" class="card" style="max-width:400px" data-testid="login-form">
  <div class="field">
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" data-testid="username" />
  </div>
  <div class="field">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" data-testid="password" />
  </div>
  ${faults.on('FAULT_LOGIN_BUTTON_RENAMED')
    ? '<button type="submit" class="primary" data-testid="signin-submit">Sign In</button>'
    : '<button type="submit" class="primary" data-testid="login-submit">Log in</button>'}
  ${ctx.query.error ? '<p class="error" role="alert" data-testid="login-error">That username and password do not match.</p>' : ''}
</form>
<p class="muted">Use <code>alice</code> / <code>Password123!</code>.</p>`
})));

app.post('/login', async (ctx) => {
  const body = await ctx.body();
  const result = sessions.signIn(USERS, String(body.username ?? ''), String(body.password ?? ''));
  if (!result.ok) return ctx.redirect('/login?error=1', 303);
  ctx.setCookie(SESSION_COOKIE, result.token, { maxAge: 3600 });
  baskets.set(result.token, { lines: [], coupon: null });
  return ctx.redirect('/products', 303);
});

app.get('/logout', (ctx) => {
  sessions.signOut(ctx.cookies[SESSION_COOKIE]);
  ctx.clearCookie(SESSION_COOKIE);
  return ctx.redirect('/login', 303);
});

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

app.get('/products', requireShopper(async (ctx) => {
  if (faults.on('FAULT_SLOW_ELEMENT')) await sleep(faults.parameter('slowElementMs'));

  const query = (ctx.query.q ?? '').toLowerCase();
  const category = ctx.query.category ?? 'all';
  const page = Math.max(1, Number(ctx.query.page ?? 1));

  let rows = PRODUCTS;
  if (query) rows = rows.filter(product => product.name.toLowerCase().includes(query) || product.blurb.toLowerCase().includes(query));
  if (category !== 'all') rows = rows.filter(product => product.category === category);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const salt = ctx.session.token.slice(0, 6);
  const categories = ['all', ...new Set(PRODUCTS.map(product => product.category))];

  ctx.html(200, layout({
    title: 'Shop', application: APPLICATION, nav, active: 'nav-products',
    body: `
<h1 data-testid="page-title">Shop</h1>
<form method="get" action="/products" class="card" data-testid="product-filters">
  <div class="row">
    <div class="field" style="flex:2">
      <label for="q">Search</label>
      <input id="q" name="q" value="${escapeHtml(ctx.query.q ?? '')}" placeholder="What are you looking for?" data-testid="product-search" />
    </div>
    <div class="field" style="flex:1">
      <label for="category">Category</label>
      <select id="category" name="category" data-testid="product-category">
        ${categories.map(option => `<option value="${option}"${category === option ? ' selected' : ''}>${option === 'all' ? 'All categories' : option}</option>`).join('')}
      </select>
    </div>
    <button type="submit" class="primary" data-testid="product-search-submit">Search</button>
  </div>
</form>

<p data-testid="result-count">${rows.length} product${rows.length === 1 ? '' : 's'}</p>
${shown.length === 0 ? '<p class="muted" data-testid="products-empty">Nothing matched that search.</p>' : ''}
<div class="cards" data-testid="product-grid">
  ${shown.map(product => `
  <article class="card" ${tid(`product-tile-${product.id}`, salt)}>
    <h2><a href="/products/${product.id}" ${tid(`open-product-${product.id}`, salt)}>${escapeHtml(product.name)}</a></h2>
    <p class="muted">${escapeHtml(product.category)}</p>
    <p class="balance" ${tid(`product-price-${product.id}`, salt)}>${money(product.price)}</p>
    ${product.stock === 0 && !faults.on('FAULT_OUT_OF_STOCK_HIDDEN')
      ? `<p class="notice" data-testid="product-out-of-stock-${product.id}">Out of stock</p>`
      : `<form method="post" action="/cart/add"><input type="hidden" name="productId" value="${product.id}" />
         <button type="submit" class="primary" ${tid(`add-to-cart-${product.id}`, salt)}>Add to basket</button></form>`}
  </article>`).join('')}
</div>

<div class="row" style="margin-top:14px" data-testid="pagination">
  <a class="button" href="/products?page=${Math.max(1, page - 1)}&q=${encodeURIComponent(ctx.query.q ?? '')}&category=${encodeURIComponent(category)}" data-testid="page-previous">Previous</a>
  <span data-testid="page-indicator">Page ${page} of ${pages}</span>
  <a class="button" href="/products?page=${Math.min(pages, page + 1)}&q=${encodeURIComponent(ctx.query.q ?? '')}&category=${encodeURIComponent(category)}" data-testid="page-next">Next</a>
</div>`
  }));
}));

app.get('/products/:id', requireShopper((ctx) => {
  const product = PRODUCTS.find(candidate => candidate.id === ctx.params.id);
  if (!product) return ctx.html(404, layout({
    title: 'Not found', application: APPLICATION, nav,
    body: '<h1 data-testid="not-found">No such product</h1>'
  }));

  ctx.html(200, layout({
    title: product.name, application: APPLICATION, nav, active: 'nav-products',
    body: `
<p><a href="/products" data-testid="back-to-products">← Back to the shop</a></p>
<h1 data-testid="product-name">${escapeHtml(product.name)}</h1>
<p class="muted" data-testid="product-category">${escapeHtml(product.category)}</p>
<p data-testid="product-blurb">${escapeHtml(product.blurb)}</p>
<p class="balance" data-testid="product-price">${money(product.price)}</p>
<p data-testid="product-stock">${product.stock === 0 ? 'Out of stock' : `${product.stock} in stock`}</p>
${product.stock === 0 && !faults.on('FAULT_OUT_OF_STOCK_HIDDEN') ? '' : `
<form method="post" action="/cart/add" class="row">
  <input type="hidden" name="productId" value="${product.id}" />
  <div class="field"><label for="quantity">Quantity</label>
    <input id="quantity" name="quantity" type="number" min="1" max="10" value="1" data-testid="product-quantity" /></div>
  <button type="submit" class="primary" data-testid="add-to-cart">Add to basket</button>
</form>`}`
  }));
}));

app.get('/api/products', async (ctx) => {
  if (faults.on('FAULT_API_500')) return ctx.json(500, { error: 'internal_error', message: 'The catalogue is unavailable.' });
  return ctx.json(200, { products: PRODUCTS });
});

// ---------------------------------------------------------------------------
// Basket
// ---------------------------------------------------------------------------

function priceBasket(basket) {
  const lines = basket.lines.map(line => {
    const product = PRODUCTS.find(candidate => candidate.id === line.productId);
    return { ...line, name: product.name, price: product.price, lineTotal: Number((product.price * line.quantity).toFixed(2)) };
  });

  const subtotal = Number(lines.reduce((sum, line) => sum + line.lineTotal, 0).toFixed(2));
  let discount = 0;
  // The ignored-coupon fault keeps the coupon on screen and drops it from the arithmetic.
  if (basket.coupon && !faults.on('FAULT_COUPON_IGNORED')) {
    const rule = COUPONS[basket.coupon];
    discount = rule.kind === 'percent' ? Number((subtotal * rule.value / 100).toFixed(2)) : Math.min(rule.value, subtotal);
  }
  const shipping = subtotal > 50 || subtotal === 0 ? 0 : 3.95;
  const honest = Number((subtotal - discount + shipping).toFixed(2));

  return {
    lines, subtotal, discount, shipping,
    total: faults.on('FAULT_WRONG_TOTAL') ? Number((honest + 7.77).toFixed(2)) : honest,
    honestTotal: honest
  };
}

app.post('/cart/add', requireShopper(async (ctx) => {
  const body = await ctx.body();
  const product = PRODUCTS.find(candidate => candidate.id === body.productId);
  if (!product) return ctx.redirect('/products', 303);
  if (product.stock === 0 && !faults.on('FAULT_OUT_OF_STOCK_HIDDEN')) return ctx.redirect('/products', 303);

  const quantity = Math.max(1, Math.min(10, Number(body.quantity ?? 1)));
  const existing = ctx.basket.lines.find(line => line.productId === product.id);
  if (existing) existing.quantity = Math.min(10, existing.quantity + quantity);
  else ctx.basket.lines.push({ productId: product.id, quantity });

  baskets.set(ctx.session.token, ctx.basket);
  return ctx.redirect('/cart', 303);
}));

app.post('/cart/update', requireShopper(async (ctx) => {
  const body = await ctx.body();
  const line = ctx.basket.lines.find(candidate => candidate.productId === body.productId);
  if (line) {
    const quantity = Number(body.quantity);
    if (quantity <= 0) ctx.basket.lines = ctx.basket.lines.filter(candidate => candidate !== line);
    else line.quantity = Math.min(10, quantity);
  }
  baskets.set(ctx.session.token, ctx.basket);
  return ctx.redirect('/cart', 303);
}));

app.post('/cart/coupon', requireShopper(async (ctx) => {
  const body = await ctx.body();
  const code = String(body.coupon ?? '').trim().toUpperCase();
  if (!COUPONS[code]) return ctx.redirect('/cart?coupon=invalid', 303);
  ctx.basket.coupon = code;
  baskets.set(ctx.session.token, ctx.basket);
  return ctx.redirect('/cart?coupon=applied', 303);
}));

app.get('/cart', requireShopper((ctx) => {
  const priced = priceBasket(ctx.basket);
  ctx.html(200, layout({
    title: 'Basket', application: APPLICATION, nav, active: 'nav-cart',
    body: `
<h1 data-testid="page-title">Your basket</h1>
${ctx.query.coupon === 'applied' ? `<p class="confirmation" role="status" data-testid="coupon-applied">Coupon ${escapeHtml(ctx.basket.coupon ?? '')} applied.</p>` : ''}
${ctx.query.coupon === 'invalid' ? '<p class="notice" role="alert" data-testid="coupon-invalid">That coupon code is not recognised.</p>' : ''}

${priced.lines.length === 0 ? '<p class="muted" data-testid="cart-empty">Your basket is empty.</p>' : `
<table data-testid="cart-table">
  <thead><tr><th>Item</th><th>Price</th><th>Quantity</th><th>Line total</th></tr></thead>
  <tbody>
    ${priced.lines.map(line => `
    <tr data-testid="cart-row-${line.productId}">
      <td>${escapeHtml(line.name)}</td>
      <td data-testid="cart-price-${line.productId}">${money(line.price)}</td>
      <td>
        <form method="post" action="/cart/update" class="row">
          <input type="hidden" name="productId" value="${line.productId}" />
          <input name="quantity" type="number" min="0" max="10" value="${line.quantity}" style="width:72px"
                 data-testid="cart-quantity-${line.productId}" />
          <button type="submit" data-testid="cart-update-${line.productId}">Update</button>
        </form>
      </td>
      <td data-testid="cart-line-total-${line.productId}">${money(line.lineTotal)}</td>
    </tr>`).join('')}
  </tbody>
</table>

<form method="post" action="/cart/coupon" class="row" style="margin-top:14px" data-testid="coupon-form">
  <div class="field"><label for="coupon">Coupon code</label>
    <input id="coupon" name="coupon" placeholder="SAVE10" data-testid="coupon-code" /></div>
  <button type="submit" data-testid="apply-coupon">Apply coupon</button>
</form>

<div class="card" data-testid="cart-summary" style="margin-top:14px;max-width:340px">
  <p>Subtotal <strong data-testid="cart-subtotal">${money(priced.subtotal)}</strong></p>
  <p>Discount <strong data-testid="cart-discount">${money(priced.discount)}</strong></p>
  <p>Delivery <strong data-testid="cart-shipping">${money(priced.shipping)}</strong></p>
  <p>Total <strong data-testid="cart-total">${money(priced.total)}</strong></p>
</div>

<p style="margin-top:14px"><a class="button primary" href="/checkout" data-testid="go-to-checkout">Checkout</a></p>`}`,
    script: faults.on('FAULT_JS_ERROR') ? `throw new Error('LAB_FAULT_JS_ERROR: basket script failed');` : ''
  }));
}));

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

app.get('/checkout', requireShopper((ctx) => renderCheckout(ctx, {}, {})));

function renderCheckout(ctx, values, errors) {
  const priced = priceBasket(ctx.basket);
  const error = (field) => errors[field] ? `<p class="error" data-testid="checkout-error-${field}">${escapeHtml(errors[field])}</p>` : '';
  const value = (field) => escapeHtml(values[field] ?? '');

  ctx.html(Object.keys(errors).length ? 422 : 200, layout({
    title: 'Checkout', application: APPLICATION, nav, active: 'nav-cart',
    body: `
<h1 data-testid="page-title">Checkout</h1>
${priced.lines.length === 0 ? '<p class="muted" data-testid="checkout-empty">There is nothing to check out.</p>' : `
<p data-testid="checkout-total">Total to pay ${money(priced.total)}</p>
${errors.order ? `<p class="notice" role="alert" data-testid="checkout-error">${escapeHtml(errors.order)}</p>` : ''}

<form method="post" action="/checkout" class="card" novalidate data-testid="checkout-form">
  <h2>Delivery address</h2>
  <div class="field"><label for="name">Name</label>
    <input id="name" name="name" value="${value('name')}" data-testid="checkout-name" />${error('name')}</div>
  <div class="field"><label for="line1">Address line 1</label>
    <input id="line1" name="line1" value="${value('line1')}" data-testid="checkout-line1" />${error('line1')}</div>
  <div class="field"><label for="postcode">Postcode</label>
    <input id="postcode" name="postcode" value="${value('postcode')}" data-testid="checkout-postcode" />${error('postcode')}</div>

  <h2>Payment</h2>
  <div class="field"><label for="card">Card number</label>
    <input id="card" name="card" inputmode="numeric" placeholder="4000 0000 0000 0002" value="${value('card')}" data-testid="checkout-card" />${error('card')}</div>
  <div class="field"><label for="expiry">Expiry (MM/YY)</label>
    <input id="expiry" name="expiry" placeholder="04/29" value="${value('expiry')}" data-testid="checkout-expiry" />${error('expiry')}</div>
  <div class="field"><label for="cvc">Security code</label>
    <input id="cvc" name="cvc" inputmode="numeric" value="${value('cvc')}" data-testid="checkout-cvc" />${error('cvc')}</div>

  <button type="submit" class="primary" data-testid="place-order">Place order</button>
</form>`}`
  }));
}

app.post('/checkout', requireShopper(async (ctx) => {
  const body = await ctx.body();
  const errors = {};
  if (!String(body.name ?? '').trim()) errors.name = 'Enter the delivery name.';
  if (!String(body.line1 ?? '').trim()) errors.line1 = 'Enter the first line of the address.';
  if (!/^[A-Za-z0-9 ]{5,9}$/.test(String(body.postcode ?? '').trim())) errors.postcode = 'Enter a valid postcode.';
  if (!/^\d{12,19}$/.test(String(body.card ?? '').replace(/\s/g, ''))) errors.card = 'Enter a card number of 12 to 19 digits.';
  if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(String(body.expiry ?? ''))) errors.expiry = 'Enter the expiry as MM/YY.';
  if (!/^\d{3,4}$/.test(String(body.cvc ?? ''))) errors.cvc = 'Enter the 3 or 4 digit security code.';

  if (Object.keys(errors).length) return renderCheckout(ctx, body, errors);

  if (faults.on('FAULT_CHECKOUT_500')) {
    return renderCheckout(ctx, body, { order: 'The order could not be placed. Please try again.' });
  }

  const priced = priceBasket(ctx.basket);
  const order = {
    id: `ord-${(orders.length + 1).toString().padStart(4, '0')}`,
    placedAt: new Date().toISOString(),
    userId: ctx.session.userId,
    lines: priced.lines,
    subtotal: priced.subtotal, discount: priced.discount, shipping: priced.shipping, total: priced.total,
    coupon: ctx.basket.coupon,
    deliverTo: { name: body.name, line1: body.line1, postcode: body.postcode },
    cardLast4: String(body.card).replace(/\s/g, '').slice(-4)
  };
  orders = [order, ...orders];
  baskets.set(ctx.session.token, { lines: [], coupon: null });
  return ctx.redirect(`/orders/${order.id}`, 303);
}));

app.get('/orders', requireShopper(ctx => ctx.html(200, layout({
  title: 'Orders', application: APPLICATION, nav, active: 'nav-orders',
  body: `
<h1 data-testid="page-title">Your orders</h1>
${orders.length === 0 ? '<p class="muted" data-testid="orders-empty">No orders yet.</p>' : `
<table data-testid="orders-table">
  <thead><tr><th>Order</th><th>Placed</th><th>Items</th><th>Total</th></tr></thead>
  <tbody>${orders.map(order => `
    <tr data-testid="order-row-${order.id}">
      <td><a href="/orders/${order.id}" data-testid="open-order-${order.id}">${order.id}</a></td>
      <td>${order.placedAt.slice(0, 10)}</td>
      <td>${order.lines.reduce((sum, line) => sum + line.quantity, 0)}</td>
      <td>${money(order.total)}</td>
    </tr>`).join('')}</tbody>
</table>`}`
}))));

app.get('/orders/:id', requireShopper((ctx) => {
  const order = orders.find(candidate => candidate.id === ctx.params.id);
  if (!order) return ctx.html(404, layout({ title: 'Not found', application: APPLICATION, nav,
    body: '<h1 data-testid="not-found">No such order</h1>' }));

  ctx.html(200, layout({
    title: `Order ${order.id}`, application: APPLICATION, nav, active: 'nav-orders',
    body: `
<div class="confirmation" role="status" data-testid="order-confirmation">
  <h1 data-testid="order-heading">Thank you — your order is confirmed</h1>
  <p>Order number <strong data-testid="order-number">${order.id}</strong></p>
</div>
<p data-testid="order-total">Total paid ${money(order.total)}</p>
<p data-testid="order-delivery">Delivering to ${escapeHtml(order.deliverTo.name)}, ${escapeHtml(order.deliverTo.postcode)}</p>
<p class="muted" data-testid="order-card">Card ending ${escapeHtml(order.cardLast4)}</p>
<table data-testid="order-lines">
  <thead><tr><th>Item</th><th>Quantity</th><th>Line total</th></tr></thead>
  <tbody>${order.lines.map(line => `
    <tr data-testid="order-line-${line.productId}">
      <td>${escapeHtml(line.name)}</td><td>${line.quantity}</td><td>${money(line.lineTotal)}</td>
    </tr>`).join('')}</tbody>
</table>`
  }));
}));

app.get('/api/cart', requireShopper(ctx => ctx.json(200, priceBasket(ctx.basket))));
app.get('/api/orders/:id', requireShopper((ctx) => {
  const order = orders.find(candidate => candidate.id === ctx.params.id);
  return order ? ctx.json(200, { order }) : ctx.json(404, { error: 'not_found' });
}));

app.post('/__reset', (ctx) => {
  baskets.clear();
  orders = [];
  return ctx.json(200, { reset: true, faults: faults.reset() });
});

await app.listen(PORT);
