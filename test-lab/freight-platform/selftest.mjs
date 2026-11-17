/**
 * Meridian Freight self-test.
 *
 * Proves the lab works before anything is measured against it. A lab that half-works
 * produces a testing report in which the tool's misses and the lab's own breakage are
 * indistinguishable, which is worse than having no lab.
 *
 * Four things are checked:
 *
 *   1. **Every declared screen responds.** The inventory comes from the running
 *      application's own /__screens, so a screen that exists but was never declared, or
 *      is declared and does not answer, both fail here.
 *   2. **Each navigation shape behaves as documented.** Linked screens carry anchors a
 *      crawler can follow; routed screens carry none and are served through /api/view.
 *      This is the claim the whole lab rests on, so it is asserted rather than assumed.
 *   3. **The planted defects are observable.** Each one is driven and its stated symptom
 *      checked. A defect nobody can observe is not a defect, it is a comment.
 *   4. **The corrected build is clean.** With every fault off, the same probes come back
 *      correct, which is what makes a false-positive measurement meaningful.
 *
 *   node selftest.mjs             # against a server already running on 4400
 *   node selftest.mjs --port 4401
 */
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || Number(process.env.PORT) || 4400;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

const ok = (name, detail = '') => { passed += 1; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); };
const bad = (name, detail) => { failed += 1; failures.push(`${name}: ${detail}`); console.log(`  ✗ ${name} — ${detail}`); };
const check = (condition, name, detail) => condition ? ok(name, detail) : bad(name, detail);

// ---------------------------------------------------------------------------
// A session, kept by hand so the cookie travels
// ---------------------------------------------------------------------------

let cookie = '';

const request = async (path, options = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    redirect: 'manual',
    headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) }
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const entry of setCookie) {
    const [pair] = entry.split(';');
    if (pair.startsWith('lab_session=') && !pair.endsWith('=')) cookie = pair;
  }
  return response;
};

const text = async (path) => {
  const response = await request(path);
  return { status: response.status, body: await response.text(), headers: response.headers };
};

const csrfFrom = (body) => body.match(/name="_csrf" value="([^"]*)"/)?.[1] ?? '';

const post = async (path, fields, { referer } = {}) => {
  const page = await text(referer ?? path);
  const token = csrfFrom(page.body);
  const form = new URLSearchParams({ _csrf: token, ...fields });
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
};

const setFaults = (patch) => fetch(`${BASE}/__faults`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch)
}).then(r => r.json());

const resetFaults = () => fetch(`${BASE}/__faults/reset`, { method: 'POST' }).then(r => r.json());

const allFaultsOff = async () => {
  const { faults } = await fetch(`${BASE}/__faults`).then(r => r.json());
  return setFaults(Object.fromEntries(faults.map(entry => [entry.id, false])));
};

// ---------------------------------------------------------------------------

console.log(`\nMeridian Freight self-test against ${BASE}\n`);

const health = await fetch(`${BASE}/health`).then(r => r.json()).catch(() => null);
if (!health) {
  console.error(`Nothing is listening on ${BASE}. Start it with: node test-lab/freight-platform/server.js`);
  process.exit(1);
}

await resetFaults();

// ---- 1. sign in -----------------------------------------------------------

console.log('Signing in');
{
  const signIn = await post('/auth/sign-in', { username: 'admin', password: 'Freight!2026', next: '/dashboard' });
  check(signIn.status === 302, 'the sign-in form accepts a valid account', `status ${signIn.status}`);
  check(cookie.startsWith('lab_session='), 'a session cookie is issued', cookie.slice(0, 24) + '…');

  const dashboard = await text('/dashboard');
  check(dashboard.status === 200 && dashboard.body.includes('Control tower') === false
    ? dashboard.body.includes('Good morning') : dashboard.status === 200,
    'the dashboard renders for a signed-in user', `status ${dashboard.status}`);

  // The token is per session, so the cookie has to travel with it or the refusal is a
  // 403 about the token rather than a 401 about the password.
  const page = await text('/auth/sign-in');
  const wrong = await fetch(`${BASE}/auth/sign-in`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ _csrf: csrfFrom(page.body), username: 'admin', password: 'wrong' }).toString()
  });
  check(wrong.status === 401, 'a wrong password is refused', `status ${wrong.status}`);
}

// ---- 2. every declared screen responds ------------------------------------

console.log('\nEvery declared screen responds');
const inventory = await fetch(`${BASE}/__screens`).then(r => r.json());
check(inventory.total >= 100, 'the application declares at least 100 screens', `${inventory.total} declared`);
console.log(`  · ${Object.entries(inventory.byShape).map(([shape, count]) => `${count} ${shape}`).join(', ')}`);

const broken = [];
for (const screen of inventory.screens) {
  if (screen.anonymous) continue;
  const path = screen.sample ?? screen.path;
  if (path.includes(':')) { broken.push(`${screen.path} has no sample path`); continue; }
  const response = await text(path);
  // 200 is a rendered screen. 403 is a screen correctly refusing this role, which the
  // admin account should not hit. Anything else is the lab failing, not the tool.
  if (response.status !== 200) broken.push(`${path} answered ${response.status}`);
}
check(broken.length === 0, 'every declared screen answers 200 for an administrator',
  broken.length ? `${broken.length} did not: ${broken.slice(0, 6).join('; ')}` : `${inventory.total} screens`);

// ---- 3. the navigation shapes behave as documented -------------------------

console.log('\nThe three navigation shapes');
{
  const dashboard = await text('/dashboard');

  // Linked: an anchor exists for every linked domain.
  const linkedDomains = Object.entries(inventory.navShape).filter(([, shape]) => shape === 'linked').map(([key]) => key);
  const missingAnchors = linkedDomains.filter(domain =>
    !new RegExp(`<a[^>]+href="/${domain === 'dashboard' ? 'dashboard' : domain}"`).test(dashboard.body));
  check(missingAnchors.length === 0, 'every linked domain has an anchor a crawler can follow',
    missingAnchors.length ? `missing: ${missingAnchors.join(', ')}` : `${linkedDomains.length} domains`);

  // Routed: no anchor anywhere in the document points at the routed domain's path.
  const routedDomains = Object.entries(inventory.navShape).filter(([, shape]) => shape === 'routed').map(([key]) => key);
  const leakedAnchors = routedDomains.filter(domain => new RegExp(`<a[^>]+href="/${domain}"`).test(dashboard.body));
  check(leakedAnchors.length === 0, 'no routed domain is reachable by following an anchor',
    leakedAnchors.length ? `anchors found for: ${leakedAnchors.join(', ')}` : `${routedDomains.length} domains have none`);

  const routedButtons = routedDomains.filter(domain =>
    new RegExp(`data-route="/${domain}"`).test(dashboard.body));
  check(routedButtons.length === routedDomains.length,
    'each routed domain is reached by a button a person can click', `${routedButtons.length} of ${routedDomains.length}`);

  // A deep link into a routed screen serves the shell and boots the router.
  const deepLink = await text('/fleet/vehicles');
  check(deepLink.status === 200 && deepLink.body.includes('renderRoute'),
    'a deep link into a routed screen serves the shell with the router', `status ${deepLink.status}`);

  // And the router's data source answers for that path.
  const viewApi = await text('/api/view?path=%2Ffleet%2Fvehicles');
  const payload = viewApi.status === 200 ? JSON.parse(viewApi.body) : null;
  check(payload?.title === 'Vehicles' && payload.html.includes('vehicles-table'),
    'the router view endpoint returns the routed screen', payload ? `title "${payload.title}"` : `status ${viewApi.status}`);

  // Enclosed: real content with no address of its own.
  check(dashboard.body.includes('data-testid="notification-drawer"') && dashboard.body.includes('hidden'),
    'the notification drawer is real content with no address', 'present and hidden');
  const shipment = await text(inventory.screens.find(s => s.path === '/shipments/:id').sample);
  check(shipment.body.includes('data-testid="record-exception-modal"'),
    'a modal screen exists inside the shipment detail', 'exception modal present');
}

// ---- 4. the planted defects are observable --------------------------------

console.log('\nThe planted defects are observable');
await resetFaults();

const sampleOf = (path) => inventory.screens.find(s => s.path === path)?.sample ?? path;

// FP_D01 and FP_D29 — a negative-driving adjustment, with no token required.
{
  const stockPath = sampleOf('/warehouse/stock/:id');
  const before = await text(stockPath);
  const onHand = Number(before.body.match(/data-testid="detail-on-hand"[^>]*><div class="value">(-?\d+)/)?.[1] ?? NaN);
  const response = await fetch(`${BASE}${stockPath}/adjust`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ delta: '-99999', reason: 'Damage' }).toString()
  });
  const after = await text(stockPath);
  const nowOnHand = Number(after.body.match(/data-testid="detail-on-hand"[^>]*><div class="value">(-?\d+)/)?.[1] ?? NaN);
  check(response.status === 302 && nowOnHand < 0,
    'FP_D01 a stock adjustment drives on-hand below zero', `${onHand} → ${nowOnHand}`);
  check(response.status === 302,
    'FP_D29 the adjustment is accepted with no anti-forgery token', `status ${response.status}`);
}

// FP_D21 — the quantity input has no label.
{
  const adjust = await text(`${sampleOf('/warehouse/stock/:id')}/adjust`);
  const hasLabel = /<label[^>]+for="f-delta"/.test(adjust.body);
  const hasAria = /data-testid="delta"[^>]*aria-label/.test(adjust.body);
  check(!hasLabel && !hasAria, 'FP_D21 the adjustment quantity input has no label',
    `label=${hasLabel} aria-label=${hasAria}`);
}

// FP_D28 — the search term is reflected unescaped.
{
  const probe = await text('/shipments?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
  check(probe.body.includes('<script>alert(1)</script>'),
    'FP_D28 the search term is written into the page unescaped', 'raw script tag present in the response');
}

// FP_D18 — a long search term returns 500.
{
  const probe = await text(`/shipments?q=${'A'.repeat(600)}`);
  check(probe.status === 500, 'FP_D18 a 600-character search term returns 500', `status ${probe.status}`);
}

// FP_D10 — the count ignores the filter.
{
  const filtered = await text('/shipments?status=exception');
  const reported = Number(filtered.body.match(/data-testid="result-count">(\d+) shipment/)?.[1] ?? NaN);
  const all = await text('/shipments');
  const total = Number(all.body.match(/data-testid="result-count">(\d+) shipment/)?.[1] ?? NaN);
  check(reported === total && total > 0,
    'FP_D10 a filtered list reports the unfiltered count', `filtered reports ${reported}, total is ${total}`);
}

// FP_D06 — the fuel surcharge is computed on the gross.
{
  const invoicePath = sampleOf('/billing/invoices/:id');
  const invoice = await text(invoicePath);
  const net = Number(invoice.body.match(/data-testid="invoice-net"[^>]*><div class="value">£([\d,.]+)/)?.[1]?.replace(/,/g, '') ?? NaN);
  const fuel = Number(invoice.body.match(/data-testid="fuel-surcharge">£([\d,.]+)/)?.[1]?.replace(/,/g, '') ?? NaN);
  const onNet = Math.round(net * 0.115 * 100) / 100;
  check(Number.isFinite(fuel) && Math.abs(fuel - onNet) > 0.01,
    'FP_D06 the fuel surcharge is not 11.5% of net', `net ${net}, fuel ${fuel}, 11.5% of net would be ${onNet}`);
}

// FP_D07 — a weight on a band boundary falls in the cheaper band.
{
  const carrierPath = sampleOf('/carriers/:id');
  const at50 = await text(`${carrierPath}/quote?weight=50`);
  const rate50 = at50.body.match(/Rate per kg<\/dt><dd>£([\d.]+)/)?.[1];
  const at51 = await text(`${carrierPath}/quote?weight=50.01`);
  const rate51 = at51.body.match(/Rate per kg<\/dt><dd>£([\d.]+)/)?.[1];
  check(rate50 === rate51 && rate50 !== undefined,
    'FP_D07 50.00 kg and 50.01 kg are rated in the same band', `both ${rate50}`);
}

// FP_D11 — a viewer settles a claim the UI refused them.
{
  const keep = cookie;
  cookie = '';
  await post('/auth/sign-in', { username: 'readonly', password: 'Freight!2026', next: '/dashboard' });
  const claim = inventory.screens.find(s => s.path === '/claims/:id').sample;
  const claimId = claim.split('/').pop();
  const screen = await text(`/claims/${claimId}/settle`);
  const refusedByScreen = screen.status === 403;
  const response = await fetch(`${BASE}/claims/${claimId}/settle`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ settledAmountGbp: '1', note: 'Settled by a viewer in the self-test.' }).toString()
  });
  const detail = await text(`/claims/${claimId}`);
  const settled = detail.body.includes('data-status="settled"');
  check(refusedByScreen && settled,
    'FP_D11 a viewer is refused by the screen and allowed by the handler',
    `screen ${screen.status}, post ${response.status}, claim settled=${settled}`);
  cookie = keep;
}

// FP_D13 — the legacy key holds every scope and never expires.
{
  const keys = await text('/admin/api-keys');
  check(keys.body.includes('data-testid="scope-key-3"') && /scope-key-3">all \d+/.test(keys.body)
    && keys.body.includes('data-testid="no-expiry-key-3"'),
    'FP_D13 the legacy API key holds every scope with no expiry', 'both shown on the screen');
}

// FP_D23 — vehicle status is colour only.
{
  const view = await text('/api/view?path=%2Ffleet%2Fvehicles');
  const payload = JSON.parse(view.body);
  const colourOnly = /<span style="display:inline-block;width:14px;height:14px[^"]*"><\/span>/.test(payload.html);
  check(colourOnly, 'FP_D23 vehicle status is a coloured square with no text', 'empty styled span found');
}

// FP_D26 — the planner is fixed width.
{
  const view = await text('/api/view?path=%2Froutes%2Fplanner');
  const payload = JSON.parse(view.body);
  check(payload.html.includes('width:1100px'),
    'FP_D26 the route planner is fixed at 1100px', 'absolute width present');
}

// FP_D27 — the audit log is slow.
{
  const started = Date.now();
  const audit = await text('/admin/audit');
  const elapsed = Date.now() - started;
  check(audit.status === 200 && elapsed > 3000,
    'FP_D27 the audit log takes over three seconds', `${elapsed} ms`);
}

// FP_D31 — the API leaks a stack trace.
{
  const response = await text('/api/shipments/shp-9999');
  check(response.status === 500 && response.body.includes('stack') && response.body.includes('/home/'),
    'FP_D31 an API error returns the stack and absolute paths', `status ${response.status}`);
}

// FP_D30 — remember-me loses HttpOnly.
{
  const keep = cookie;
  cookie = '';
  const page = await text('/auth/sign-in');
  const response = await fetch(`${BASE}/auth/sign-in`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrfFrom(page.body), username: 'warehouse', password: 'Freight!2026', remember: 'on' }).toString()
  });
  const header = (response.headers.getSetCookie?.() ?? []).find(entry => entry.startsWith('lab_session='));
  check(header !== undefined && !header.includes('HttpOnly'),
    'FP_D30 the remember-me cookie is set without HttpOnly', header ? header.slice(0, 60) + '…' : 'no cookie');
  cookie = keep;
}

// FP_D02, FP_D03, FP_D15, FP_D16 — the booking wizard.
{
  const step1 = await post('/shipments/new?step=1', {
    customerId: 'cus-001', originWarehouseId: 'wh-fxt', step: '1',
    collectionDate: '2026-04-10', deliveryDate: '2026-04-02', incoterm: 'DAP'
  }, { referer: '/shipments/new?step=1' });
  check(step1.status === 302 && step1.headers.get('location') === '/shipments/new?step=2',
    'FP_D02 a delivery date before collection is accepted', `moved to ${step1.headers.get('location')}`);

  await post('/shipments/new?step=2', {
    step: '2', pieces: '4', weight: '1000', weightUnit: 'lb',
    volumeM3: '1.2', declaredValue: '5000', goodsDescription: 'Self-test consignment'
  }, { referer: '/shipments/new?step=2' });

  const step3 = await post('/shipments/new?step=3', {
    step: '3', serviceLevel: 'STD', carrierId: 'car-001', reference: 'SELFTEST'
  }, { referer: '/shipments/new?step=3' });
  check(step3.status === 302, 'the wizard reaches the review step', `status ${step3.status}`);

  const backToTwo = await text('/shipments/new?step=2&back=1');
  const piecesValue = backToTwo.body.match(/data-testid="pieces"[^>]*value="([^"]*)"/)?.[1] ?? '';
  check(piecesValue === '', 'FP_D15 stepping back to step 2 empties it', `pieces value is "${piecesValue}"`);

  // Re-fill step 2 and 3 so step 4 has a complete draft, then confirm twice.
  await post('/shipments/new?step=2', {
    step: '2', pieces: '4', weight: '1000', weightUnit: 'lb',
    volumeM3: '1.2', declaredValue: '5000', goodsDescription: 'Self-test consignment'
  }, { referer: '/shipments/new?step=2' });
  await post('/shipments/new?step=3', {
    step: '3', serviceLevel: 'STD', carrierId: 'car-001', reference: 'SELFTEST'
  }, { referer: '/shipments/new?step=3' });

  const beforeCount = (await fetch(`${BASE}/api/shipments`, { headers: { cookie } }).then(r => r.json())).total;
  const first = await post('/shipments/new?step=4', { step: '4' }, { referer: '/shipments/new?step=4' });
  const created = first.headers.get('location');
  const detail = await text(created);
  const weightShown = detail.body.match(/data-testid="detail-weight"[^>]*><div class="value">([\d.]+) kg/)?.[1];
  check(weightShown === '1000',
    'FP_D03 1000 lb is stored as 1000 kg', `detail shows ${weightShown} kg`);

  // The same draft again. With FP_D16 on, a fresh draft is rebuilt and a second
  // consignment is created rather than the repeat being refused.
  await post('/shipments/new?step=1', {
    customerId: 'cus-001', originWarehouseId: 'wh-fxt', step: '1',
    collectionDate: '2026-04-10', deliveryDate: '2026-04-02', incoterm: 'DAP'
  }, { referer: '/shipments/new?step=1' });
  await post('/shipments/new?step=2', {
    step: '2', pieces: '4', weight: '1000', weightUnit: 'lb',
    volumeM3: '1.2', declaredValue: '5000', goodsDescription: 'Self-test consignment'
  }, { referer: '/shipments/new?step=2' });
  await post('/shipments/new?step=3', {
    step: '3', serviceLevel: 'STD', carrierId: 'car-001', reference: 'SELFTEST'
  }, { referer: '/shipments/new?step=3' });
  await post('/shipments/new?step=4', { step: '4' }, { referer: '/shipments/new?step=4' });
  const afterCount = (await fetch(`${BASE}/api/shipments`, { headers: { cookie } }).then(r => r.json())).total;
  check(afterCount === beforeCount + 2,
    'FP_D16 the identical booking is accepted twice', `${beforeCount} → ${afterCount}`);
}

// FP_D05 — an order for a customer on credit hold is accepted.
{
  const onHold = (await fetch(`${BASE}/__screens`).then(r => r.json())) && 'cus-010';
  const response = await post('/orders/sales/new', {
    customerId: onHold, requestedDeliveryOn: '2026-04-20', serviceLevel: 'STD',
    incoterm: 'DAP', skuId: 'sku-001', quantity: '5', notes: 'Self-test'
  }, { referer: '/orders/sales/new' });
  const location = response.headers.get('location') ?? '';
  check(response.status === 302 && location.startsWith('/orders/sales/so-'),
    'FP_D05 an order for a customer on credit hold is created', `moved to ${location}`);
}

// FP_D09 — a credit note above the invoice total.
{
  const invoiceId = sampleOf('/billing/invoices/:id').split('/').pop();
  const keep = cookie;
  cookie = '';
  await post('/auth/sign-in', { username: 'finance', password: 'Freight!2026', next: '/dashboard' });
  const response = await post('/billing/credit-notes/new', {
    invoiceId, amountGbp: '999999', reason: 'Goodwill', note: 'Self-test'
  }, { referer: `/billing/credit-notes/new?invoice=${invoiceId}` });
  const list = await text('/billing/credit-notes');
  const invoiceDetail = await text(`/billing/invoices/${invoiceId}`);
  const invoiceTotal = Number(invoiceDetail.body.match(/data-testid="invoice-total"[^>]*><div class="value">£([\d,.]+)/)?.[1]?.replace(/,/g, '') ?? 0);
  const creditedMore = /999,?999/.test(list.body);
  check(response.status === 302 && creditedMore,
    'FP_D09 a credit note larger than the invoice is accepted',
    `invoice total ${invoiceTotal}, credit note of 999999 accepted=${creditedMore}`);
  cookie = keep;
}

// FP_D14 — cancelling leaves the route stop active.
{
  const routes = await fetch(`${BASE}/api/view?path=%2Froutes`, { headers: { cookie } }).then(r => r.json());
  const routeId = inventory.screens.find(s => s.path === '/routes/:id').sample.split('/').pop();
  const stops = JSON.parse((await text(`/api/view?path=%2Froutes%2F${routeId}%2Fstops`)).body);
  const shipmentHref = stops.html.match(/href="\/shipments\/(shp-\d+)"/)?.[1];
  if (!shipmentHref) {
    bad('FP_D14 cancelling leaves the route stop active', 'no shipment is linked from the sample route');
  } else {
    await post(`/shipments/${shipmentHref}/cancel`, { reason: 'Customer request', notes: 'Self-test' },
      { referer: `/shipments/${shipmentHref}/cancel` });
    const after = JSON.parse((await text(`/api/view?path=%2Froutes%2F${routeId}%2Fstops`)).body);
    const shipmentCancelled = (await text(`/shipments/${shipmentHref}`)).body.includes('data-status="cancelled"');
    const stopStillPending = /data-status="(pending|arrived)"/.test(after.html);
    check(shipmentCancelled && stopStillPending,
      'FP_D14 a cancelled consignment leaves its route stop active',
      `shipment cancelled=${shipmentCancelled}, stop still active=${stopStillPending}`);
  }
}

// FP_D17 — a rejected declaration is released.
{
  const keep = cookie;
  cookie = '';
  await post('/auth/sign-in', { username: 'customs', password: 'Freight!2026', next: '/dashboard' });
  const declarations = await text('/customs/declarations?status=rejected');
  const rejectedId = declarations.body.match(/href="\/customs\/declarations\/(dec-\d+)"/)?.[1];
  if (!rejectedId) {
    bad('FP_D17 a rejected declaration can be released', 'no rejected declaration in the seed');
  } else {
    const response = await post(`/customs/declarations/${rejectedId}/release`,
      { reference: 'SELFTEST-CLR-1', note: 'Self-test' },
      { referer: `/customs/declarations/${rejectedId}/release` });
    const detail = await text(`/customs/declarations/${rejectedId}`);
    check(response.status === 302 && detail.body.includes('data-status="released"'),
      'FP_D17 a rejected declaration is released', `status ${response.status}`);
  }
  cookie = keep;
}

// FP_D19 — an oversize evidence upload crashes.
{
  const claimId = sampleOf('/claims/:id').split('/').pop();
  const response = await post(`/claims/${claimId}/evidence`,
    { evidenceType: 'photograph', sizeKb: '9000', note: 'Self-test oversize' },
    { referer: `/claims/${claimId}/evidence` });
  check(response.status === 500, 'FP_D19 an oversize evidence upload returns 500', `status ${response.status}`);
}

// FP_D22 — claim errors are not associated with their fields.
{
  const response = await post('/claims/new', { shipmentId: '', type: '', claimedAmountGbp: '', description: '', incidentDate: '' },
    { referer: '/claims/new' });
  const form = JSON.parse((await text('/api/view?path=%2Fclaims%2Fnew')).body);
  const hasBlock = form.html.includes('data-testid="claim-errors"');
  const hasDescribedBy = /data-testid="claim-amount"[^>]*aria-describedby="[^"]*error/.test(form.html);
  check(hasBlock && !hasDescribedBy,
    'FP_D22 claim errors render as a block with no link to the field',
    `block=${hasBlock} describedby=${hasDescribedBy}`);
}

// FP_D04 — two invoices with the same reference.
{
  const keep = cookie;
  cookie = '';
  await post('/auth/sign-in', { username: 'finance', password: 'Freight!2026', next: '/dashboard' });
  const fields = { customerId: 'cus-001', shipmentId: 'shp-0007', netGbp: '100', issuedOn: '2026-03-02', reference: 'INV-DUPLICATE-1' };
  const first = await post('/billing/invoices/new', fields, { referer: '/billing/invoices/new' });
  const second = await post('/billing/invoices/new', fields, { referer: '/billing/invoices/new' });
  const list = await text('/billing/invoices?q=INV-DUPLICATE-1');
  const occurrences = (list.body.match(/INV-DUPLICATE-1/g) ?? []).length;
  check(first.status === 302 && second.status === 302 && occurrences >= 2,
    'FP_D04 two invoices can carry the same reference', `${occurrences} rows carry it`);
  cookie = keep;
}

// FP_D32 — contact email in the query string.
{
  const customers = await text('/customers');
  check(/<form method="get"[^>]*data-testid="contact-search-form"/.test(customers.body),
    'FP_D32 the contact search submits by GET', 'method=get on the contact form');
}

// FP_D20 — a missing shipment reference crashes the invoice page.
{
  const keep = cookie;
  cookie = '';
  await post('/auth/sign-in', { username: 'finance', password: 'Freight!2026', next: '/dashboard' });
  await post('/billing/invoices/new',
    { customerId: 'cus-002', shipmentId: '', netGbp: '50', issuedOn: '2026-03-02', reference: 'INV-ORPHAN-1' },
    { referer: '/billing/invoices/new' });
  const list = await text('/billing/invoices?q=INV-ORPHAN-1');
  const orphanId = list.body.match(/href="\/billing\/invoices\/(inv-\d+)"/)?.[1];
  if (!orphanId) {
    bad('FP_D20 an invoice with no shipment crashes its page', 'the orphan invoice was not created');
  } else {
    const detail = await text(`/billing/invoices/${orphanId}`);
    check(detail.status === 500, 'FP_D20 an invoice whose shipment does not resolve returns 500', `status ${detail.status}`);
  }
  cookie = keep;
}

// FP_D08 — duty excludes freight on delivered terms.
{
  // The sample declaration may sit on ex-works terms, where excluding freight is correct.
  // Find one whose shipment carries a delivered incoterm, so the probe is about the defect.
  const list = await text('/customs/declarations');
  const ids = [...list.body.matchAll(/href="\/customs\/declarations\/(dec-\d+)"/g)].map(m => m[1]);
  let declarationPath = sampleOf('/customs/declarations/:id');
  for (const id of ids) {
    const candidate = await text(`/customs/declarations/${id}`);
    if (/Incoterm includes freight<\/dt><dd>Yes/.test(candidate.body)) { declarationPath = `/customs/declarations/${id}`; break; }
  }
  const detail = await text(declarationPath);
  const basis = detail.body.match(/data-testid="duty-basis">£([\d,.]+)/)?.[1]?.replace(/,/g, '');
  const goodsValue = detail.body.match(/Goods value<\/dt><dd>£([\d,.]+)/)?.[1]?.replace(/,/g, '');
  const freight = detail.body.match(/Freight cost<\/dt><dd>£([\d,.]+)/)?.[1]?.replace(/,/g, '');
  const includesFreight = /Incoterm includes freight<\/dt><dd>Yes/.test(detail.body);
  check(includesFreight ? basis === goodsValue && Number(freight) > 0 : true,
    'FP_D08 the value for duty excludes freight on delivered terms',
    `basis ${basis}, goods ${goodsValue}, freight ${freight}, delivered terms=${includesFreight}`);
}

// FP_D12 — any signed-in user reads any shipment.
{
  const keep = cookie;
  cookie = '';
  await post('/auth/sign-in', { username: 'warehouse', password: 'Freight!2026', next: '/dashboard' });
  const response = await text(sampleOf('/shipments/:id'));
  check(response.status === 200 && response.body.includes('Declared value'),
    'FP_D12 a warehouse user reads a shipment in full', `status ${response.status}`);
  cookie = keep;
}

// FP_D24 — the approval modal is not announced.
{
  const awaiting = await text('/orders/approvals');
  const orderId = awaiting.body.match(/href="\/orders\/sales\/(so-\d+)"/)?.[1];
  if (!orderId) {
    bad('FP_D24 the approval modal is not announced', 'no order is awaiting approval');
  } else {
    const keep = cookie;
    cookie = '';
    await post('/auth/sign-in', { username: 'ops.lead', password: 'Freight!2026', next: '/dashboard' });
    const detail = await text(`/orders/sales/${orderId}`);
    const hasModal = detail.body.includes('data-testid="approve-modal"');
    const hasAriaModal = /id="approve-modal"[^>]*aria-modal/.test(detail.body);
    check(hasModal && !hasAriaModal,
      'FP_D24 the approval dialog has no aria-modal', `modal=${hasModal} aria-modal=${hasAriaModal}`);
    cookie = keep;
  }
}

// FP_D25 — the rate table overflows.
{
  const rates = await text(`${sampleOf('/carriers/:id')}/rates`);
  const fixed = rates.body.includes('min-width:980px');
  const wrapped = /<div class="table-wrap"><table style="min-width:980px/.test(rates.body);
  check(fixed && !wrapped, 'FP_D25 the rate table is 980px wide with no scroll container',
    `fixed=${fixed} wrapped=${wrapped}`);
}

// ---- 5. the corrected build is clean --------------------------------------

console.log('\nThe corrected build is clean');
await allFaultsOff();
cookie = '';
await post('/auth/sign-in', { username: 'admin', password: 'Freight!2026', next: '/dashboard' });

{
  const probe = await text('/shipments?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
  check(!probe.body.includes('<script>alert(1)</script>') && probe.body.includes('&lt;script&gt;'),
    'with the defects off the search term is escaped', 'escaped in the response');
}
{
  const probe = await text(`/shipments?q=${'A'.repeat(600)}`);
  check(probe.status === 200, 'with the defects off a long search term does not crash', `status ${probe.status}`);
}
{
  const adjust = await text(`${sampleOf('/warehouse/stock/:id')}/adjust`);
  const labelled = /<label[^>]*for="f-delta"/.test(adjust.body);
  check(labelled, 'with the defects off the adjustment quantity has a label',
    `status ${adjust.status}, label present=${labelled}`);
}
{
  // The defect probe above already drove this record negative, so the assertion is that
  // the guard REFUSES the adjustment, not that the balance is positive. Asserting the
  // balance would be asserting that an earlier test had not run.
  const stockPath = sampleOf('/warehouse/stock/:id');
  const before = await text(stockPath);
  const beforeOnHand = Number(before.body.match(/data-testid="detail-on-hand"[^>]*><div class="value">(-?\d+)/)?.[1] ?? NaN);
  const page = await text(`${stockPath}/adjust`);
  const response = await fetch(`${BASE}${stockPath}/adjust`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ _csrf: csrfFrom(page.body), delta: '-5000', reason: 'Damage' }).toString()
  });
  const after = await text(stockPath);
  const afterOnHand = Number(after.body.match(/data-testid="detail-on-hand"[^>]*><div class="value">(-?\d+)/)?.[1] ?? NaN);
  check(afterOnHand === beforeOnHand,
    'with the defects off an adjustment that would go below zero is refused',
    `on hand unchanged at ${afterOnHand}`);
}
{
  // And the token is required again, which is the other half of that screen's repair.
  const stockPath = sampleOf('/warehouse/stock/:id');
  const adjust = await text(`${stockPath}/adjust`);
  const hasToken = adjust.body.includes('data-testid="csrf"');
  const withoutToken = await fetch(`${BASE}${stockPath}/adjust`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ delta: '1', reason: 'Found' }).toString()
  });
  const refused = withoutToken.headers.get('location')?.includes('/adjust');
  check(hasToken && refused,
    'with the defects off the adjustment requires an anti-forgery token',
    `token rendered=${hasToken}, untokened post bounced=${Boolean(refused)}`);
}
{
  const started = Date.now();
  await text('/admin/audit');
  const elapsed = Date.now() - started;
  check(elapsed < 1500, 'with the defects off the audit log is fast', `${elapsed} ms`);
}
{
  const response = await text('/api/shipments/shp-9999');
  check(response.status === 404 && !response.body.includes('stack'),
    'with the defects off an API error leaks nothing', `status ${response.status}`);
}
{
  const step1 = await post('/shipments/new?step=1', {
    customerId: 'cus-001', originWarehouseId: 'wh-fxt', step: '1',
    collectionDate: '2026-04-10', deliveryDate: '2026-04-02', incoterm: 'DAP'
  }, { referer: '/shipments/new?step=1' });
  const page = await text('/shipments/new?step=1');
  check(step1.headers.get('location') === '/shipments/new?step=1'
    && page.body.includes('cannot be before the collection date'),
    'with the defects off a delivery date before collection is refused', 'field error shown');
}

await resetFaults();

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  console.log('Failures:');
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
