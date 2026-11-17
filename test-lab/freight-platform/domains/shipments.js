/**
 * Shipments: booking, tracking, exceptions, cancellation.
 *
 * The densest domain in the lab and the one carrying the most planted defects, because it
 * is where a freight platform's real complexity lives.
 *
 *   FP_D02  delivery date before collection accepted
 *   FP_D03  weight unit recorded and never applied
 *   FP_D10  result count taken before the filter
 *   FP_D12  any signed-in user can read any shipment
 *   FP_D14  cancelling leaves the route stop active
 *   FP_D15  stepping back in the wizard empties step 2
 *   FP_D16  double submit books twice
 *   FP_D18  a long search term returns 500 with a stack
 *   FP_D28  the search term is reflected unescaped
 *   FP_D31  API errors leak the Node stack
 */
import { escapeHtml } from '../../shared/http.js';
import { h, table, field, statusPill, shortDate, dateTime, money, kv, tabs, modal, wizardSteps, pagination, stat } from '../ui/chrome.js';

export const SCREENS = [
  { path: '/shipments', title: 'Shipments', kind: 'list' },
  { path: '/shipments/board', title: 'Shipment board', kind: 'dashboard' },
  { path: '/shipments/exceptions', title: 'Shipment exceptions', kind: 'list' },
  { path: '/shipments/new', title: 'Book a shipment', kind: 'wizard' },
  { path: '/shipments/consolidate', title: 'Consolidate shipments', kind: 'form' },
  { path: '/shipments/:id', title: 'Shipment', kind: 'detail' },
  { path: '/shipments/:id/edit', title: 'Edit shipment', kind: 'form' },
  { path: '/shipments/:id/tracking', title: 'Tracking', kind: 'detail' },
  { path: '/shipments/:id/documents', title: 'Shipment documents', kind: 'list' },
  { path: '/shipments/:id/charges', title: 'Shipment charges', kind: 'detail' },
  { path: '/shipments/:id/labels', title: 'Labels and paperwork', kind: 'detail' },
  { path: '/shipments/:id/split', title: 'Split shipment', kind: 'form' },
  { path: '/shipments/:id/cancel', title: 'Cancel shipment', kind: 'form' },
  { path: '/shipments/:id/exception', title: 'Record an exception', kind: 'form' }
];

/** Drafts held between wizard steps, keyed by session. Real enough to lose data from. */
const drafts = new Map();
/** Booking references already issued, so FP_D16 can be observed as two of them. */
const issuedBookings = [];

export default function registerShipments({ app, core, state, faults }) {
  const { definePage, csrfField, csrfValid, setFlash, listParams, paginate, can } = core;

  const customer = id => state.customers.find(c => c.id === id);
  const carrier = id => state.carriers.find(c => c.id === id);
  const warehouse = id => state.warehouses.find(w => w.id === id);
  const find = id => state.shipments.find(s => s.id === id || s.reference === id);

  const sample = state.shipments[0];
  for (const screen of SCREENS) {
    if (screen.path.includes(':id')) screen.sample = screen.path.replace(':id', sample.id);
  }

  // ---- list ---------------------------------------------------------------

  definePage({
    path: '/shipments', domain: 'shipments', title: 'Shipments', kind: 'list',
    view: (ctx) => {
      const { page, size, q } = listParams(ctx);
      const status = String(ctx.query.status ?? '');
      const carrierId = String(ctx.query.carrier ?? '');

      // FP_D18 — the term is compiled into a regular expression with no length bound.
      // A 500+ character term makes the engine throw, and the throw is rendered with the
      // stack because this handler does not catch it.
      if (q && faults.on('FP_D18_LONG_SEARCH_CRASHES') && q.length > 500) {
        throw new Error(`Search compilation failed for a term of ${q.length} characters at /home/user/AIRA/test-lab/freight-platform/domains/shipments.js:72`);
      }

      let rows = state.shipments;
      if (status) rows = rows.filter(s => s.status === status);
      if (carrierId) rows = rows.filter(s => s.carrierId === carrierId);
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter(s =>
          s.reference.toLowerCase().includes(needle) ||
          s.trackingNumber.toLowerCase().includes(needle) ||
          (customer(s.customerId)?.name ?? '').toLowerCase().includes(needle));
      }

      // FP_D10 — the heading and the page count are computed from the unfiltered set, so
      // a filter that matches three rows still advertises the full population.
      const countedAgainst = faults.on('FP_D10_PAGINATION_COUNT_WRONG') ? state.shipments : rows;
      const { slice } = paginate(rows, page, size);
      const pageCount = Math.max(1, Math.ceil(countedAgainst.length / size));

      // FP_D28 — the raw term goes into the markup. Escaped when the defect is off.
      const noResultsMessage = q
        ? (faults.on('FP_D28_REFLECTED_XSS_IN_SEARCH')
            ? `No shipments match ${q}.`
            : `No shipments match ${escapeHtml(q)}.`)
        : 'No shipments yet.';

      return {
        title: 'Shipments',
        actions: `<a class="btn" href="/shipments/new" data-testid="new-shipment">Book a shipment</a>
                  <a class="btn btn-secondary" href="/shipments/board" data-testid="shipment-board">Board view</a>`,
        body: `
<form method="get" action="/shipments" class="filters" data-testid="shipment-filters">
${field({ name: 'q', label: 'Search', type: 'search', value: q, testId: 'search',
  hint: 'Reference, tracking number or customer.' })}
${field({ name: 'status', label: 'Status', value: status, testId: 'filter-status',
  options: [{ value: '', label: 'Any status' }, ...state.SHIPMENT_STATUSES.map(s => ({ value: s, label: s }))] })}
${field({ name: 'carrier', label: 'Carrier', value: carrierId, testId: 'filter-carrier',
  options: [{ value: '', label: 'Any carrier' }, ...state.carriers.map(c => ({ value: c.id, label: c.name }))] })}
<button class="btn" type="submit" data-testid="apply-filters">Apply</button>
<a class="btn btn-secondary" href="/shipments" data-testid="clear-filters">Clear</a>
</form>

<p class="hint" data-testid="result-count">${countedAgainst.length} shipment(s).</p>

${rows.length === 0
  ? `<div class="panel"><div class="empty" data-testid="shipments-empty">${noResultsMessage}</div></div>`
  : table({
      caption: 'Shipments matching the current filter', testId: 'shipments-table',
      columns: [
        { header: 'Reference', cell: row => `<a href="/shipments/${h(row.id)}" data-testid="shipment-${h(row.reference)}">${h(row.reference)}</a>` },
        { header: 'Customer', cell: row => h(customer(row.customerId)?.name ?? '—') },
        { header: 'Destination', cell: row => h(`${row.destination.city}, ${row.destination.countryCode}`) },
        { header: 'Carrier', cell: row => h(carrier(row.carrierId)?.name ?? '—') },
        { header: 'Service', cell: row => `<code>${h(row.serviceLevel)}</code>` },
        { header: 'Pieces', cell: row => String(row.pieces) },
        { header: 'Weight', cell: row => `${row.weightKg} kg` },
        { header: 'Due', cell: row => shortDate(row.estimatedDeliveryOn) },
        { header: 'Status', cell: row => statusPill(row.status) }
      ],
      rows: slice
    })}
${pagination('/shipments', page, pageCount, { q, status, carrier: carrierId })}`
      };
    }
  });

  definePage({
    path: '/shipments/board', domain: 'shipments', title: 'Shipment board', kind: 'dashboard',
    view: () => {
      const columns = ['booked', 'collected', 'inTransit', 'outForDelivery', 'exception'];
      return {
        title: 'Shipment board',
        breadcrumbs: [{ label: 'Shipments', href: '/shipments' }, { label: 'Board' }],
        body: `<div class="grid grid-4" style="grid-template-columns:repeat(5,minmax(0,1fr))" data-testid="shipment-board">
${columns.map(column => {
  const rows = state.shipments.filter(s => s.status === column);
  return `<div class="panel" data-testid="board-column-${h(column)}">
<h3 style="margin-top:0">${h(column.replace(/([A-Z])/g, ' $1'))} <span class="pill pill-muted">${rows.length}</span></h3>
${rows.length === 0 ? '<p class="hint">Empty.</p>' : rows.map(row =>
  `<div style="border:1px solid var(--line);border-radius:6px;padding:8px;margin-bottom:7px;font-size:13px">
    <a href="/shipments/${h(row.id)}"><strong>${h(row.reference)}</strong></a><br />
    <span style="color:var(--muted)">${h(customer(row.customerId)?.name ?? '')}</span><br />
    <span style="color:var(--muted)">${h(row.destination.city)} · ${row.pieces} pcs</span>
  </div>`).join('')}
</div>`;
}).join('')}
</div>`
      };
    }
  });

  definePage({
    path: '/shipments/exceptions', domain: 'shipments', title: 'Shipment exceptions', kind: 'list',
    view: () => {
      const rows = state.shipments.filter(s => s.status === 'exception');
      return {
        title: 'Shipment exceptions',
        breadcrumbs: [{ label: 'Shipments', href: '/shipments' }, { label: 'Exceptions' }],
        body: `<div class="panel">${table({
          caption: 'Shipments with an open exception', testId: 'shipment-exceptions',
          empty: 'No open exceptions.',
          columns: [
            { header: 'Reference', cell: row => `<a href="/shipments/${h(row.id)}">${h(row.reference)}</a>` },
            { header: 'Customer', cell: row => h(customer(row.customerId)?.name ?? '—') },
            { header: 'Code', cell: row => `<code>${h(row.exceptionCode ?? '')}</code>` },
            { header: 'Carrier', cell: row => h(carrier(row.carrierId)?.name ?? '—') },
            { header: 'Raised', cell: row => dateTime(row.events.at(-1)?.at) },
            { header: '', cell: row => `<a class="btn btn-secondary" href="/claims/new?shipment=${h(row.id)}">Raise claim</a>` }
          ],
          rows
        })}</div>`
      };
    }
  });

  // ---- booking wizard -----------------------------------------------------

  const WIZARD_STEPS = ['Customer and route', 'Goods', 'Service and carrier', 'Review'];
  const draftKey = ctx => ctx.cookies.lab_session ?? 'anonymous';

  definePage({
    path: '/shipments/new', domain: 'shipments', title: 'Book a shipment', kind: 'wizard',
    view: (ctx, user) => {
      const step = Math.min(4, Math.max(1, Number(ctx.query.step ?? 1) || 1));
      const draft = drafts.get(draftKey(ctx)) ?? {};
      const errors = draft.__errors ?? {};

      // FP_D15 — step 2 is re-rendered from defaults when it is revisited, rather than
      // from the draft. Arriving at step 2 going forwards is fine; arriving backwards
      // (the `back` marker) silently empties it.
      const steppingBack = ctx.query.back === '1';
      const step2Source = (steppingBack && faults.on('FP_D15_WIZARD_BACK_LOSES_DATA')) ? {} : draft;

      const bodyByStep = {
        1: `
${field({ name: 'customerId', label: 'Customer', required: true, value: draft.customerId, testId: 'customer',
  options: [{ value: '', label: 'Choose a customer' }, ...state.customers.map(c => ({ value: c.id, label: c.name }))],
  error: errors.customerId })}
${field({ name: 'originWarehouseId', label: 'Collect from', required: true, value: draft.originWarehouseId, testId: 'origin',
  options: [{ value: '', label: 'Choose an origin' }, ...state.warehouses.map(w => ({ value: w.id, label: `${w.name} (${w.code})` }))],
  error: errors.originWarehouseId })}
${field({ name: 'collectionDate', label: 'Collection date', type: 'date', required: true, value: draft.collectionDate, testId: 'collection-date',
  error: errors.collectionDate })}
${field({ name: 'deliveryDate', label: 'Requested delivery date', type: 'date', required: true, value: draft.deliveryDate, testId: 'delivery-date',
  hint: 'Must be on or after the collection date.', error: errors.deliveryDate })}
${field({ name: 'incoterm', label: 'Incoterm', value: draft.incoterm ?? 'DAP', testId: 'incoterm', options: state.INCOTERMS })}`,
        2: `
${field({ name: 'pieces', label: 'Pieces', type: 'number', required: true, value: step2Source.pieces, testId: 'pieces',
  attrs: { min: '1', max: '500', step: '1' }, error: errors.pieces })}
${field({ name: 'weight', label: 'Gross weight', type: 'number', required: true, value: step2Source.weight, testId: 'weight',
  attrs: { min: '0.1', max: '30000', step: '0.1' }, error: errors.weight })}
${field({ name: 'weightUnit', label: 'Weight unit', value: step2Source.weightUnit ?? 'kg', testId: 'weight-unit',
  options: [{ value: 'kg', label: 'Kilograms' }, { value: 'lb', label: 'Pounds' }],
  hint: 'Rates and vehicle capacity are calculated from this.' })}
${field({ name: 'volumeM3', label: 'Volume (m³)', type: 'number', value: step2Source.volumeM3, testId: 'volume',
  attrs: { min: '0', max: '200', step: '0.001' } })}
${field({ name: 'declaredValue', label: 'Declared value (GBP)', type: 'number', required: true, value: step2Source.declaredValue, testId: 'declared-value',
  attrs: { min: '0', max: '1000000', step: '0.01' }, error: errors.declaredValue })}
${field({ name: 'hazardous', label: 'Contains hazardous goods', type: 'checkbox', value: step2Source.hazardous, testId: 'hazardous' })}
${field({ name: 'temperatureControlled', label: 'Needs temperature control', type: 'checkbox', value: step2Source.temperatureControlled, testId: 'temperature' })}
${field({ name: 'goodsDescription', label: 'Description of goods', type: 'textarea', value: step2Source.goodsDescription, testId: 'goods-description',
  attrs: { maxlength: '500' }, hint: 'Up to 500 characters. Shown on the customs declaration.' })}`,
        3: `
${field({ name: 'serviceLevel', label: 'Service level', required: true, value: draft.serviceLevel, testId: 'service-level',
  options: [{ value: '', label: 'Choose a service' }, ...state.SERVICE_LEVELS.map(s => ({ value: s.code, label: `${s.name} — ${s.transitDays} day(s)` }))],
  error: errors.serviceLevel })}
${field({ name: 'carrierId', label: 'Carrier', required: true, value: draft.carrierId, testId: 'carrier',
  options: [{ value: '', label: 'Choose a carrier' }, ...state.carriers.filter(c => c.status === 'active').map(c => ({ value: c.id, label: `${c.name} (${c.mode})` }))],
  error: errors.carrierId })}
${field({ name: 'reference', label: 'Your reference', value: draft.reference, testId: 'customer-reference',
  attrs: { maxlength: '40' }, hint: 'Appears on the invoice.' })}
${field({ name: 'instructions', label: 'Delivery instructions', type: 'textarea', value: draft.instructions, testId: 'instructions',
  attrs: { maxlength: '300' } })}`,
        4: `
<div class="panel">
<h2 style="margin-top:0">Check this before booking</h2>
${kv([
  ['Customer', h(customer(draft.customerId)?.name ?? '—')],
  ['Collect from', h(warehouse(draft.originWarehouseId)?.name ?? '—')],
  ['Collection', h(draft.collectionDate ?? '—')],
  ['Requested delivery', h(draft.deliveryDate ?? '—')],
  ['Pieces', h(String(draft.pieces ?? '—'))],
  ['Weight', `${h(String(draft.weight ?? '—'))} ${h(draft.weightUnit ?? 'kg')}`],
  ['Declared value', draft.declaredValue ? money(Number(draft.declaredValue)) : '—'],
  ['Service', h(draft.serviceLevel ?? '—')],
  ['Carrier', h(carrier(draft.carrierId)?.name ?? '—')]
])}
</div>`
      };

      return {
        title: 'Book a shipment',
        breadcrumbs: [{ label: 'Shipments', href: '/shipments' }, { label: 'Book' }],
        body: `
${wizardSteps(WIZARD_STEPS, step - 1)}
<div class="panel" style="max-width:640px">
<form method="post" action="/shipments/new?step=${step}" data-testid="booking-form-step-${step}">
${csrfField(ctx)}
<input type="hidden" name="step" value="${step}" />
${bodyByStep[step]}
<div style="display:flex;gap:8px;margin-top:16px">
${step > 1 ? `<a class="btn btn-secondary" href="/shipments/new?step=${step - 1}&back=1" data-testid="wizard-back">Back</a>` : ''}
<button class="btn" type="submit" data-testid="${step === 4 ? 'confirm-booking' : 'wizard-next'}">${step === 4 ? 'Confirm booking' : 'Continue'}</button>
<a class="btn btn-secondary" href="/shipments" data-testid="wizard-cancel">Cancel</a>
</div>
</form>
</div>`
      };
    }
  });

  app.post('/shipments/new', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    if (!await csrfValid(ctx)) {
      setFlash(ctx, 'error', 'That form expired. Start the booking again.');
      return ctx.redirect('/shipments/new?step=1');
    }

    const body = await ctx.body();
    const step = Number(body.step ?? 1);
    const key = draftKey(ctx);
    const draft = { ...(drafts.get(key) ?? {}), ...body };
    delete draft.__errors;
    const errors = {};

    if (step === 1) {
      if (!draft.customerId) errors.customerId = 'Choose a customer.';
      if (!draft.originWarehouseId) errors.originWarehouseId = 'Choose where the goods are collected from.';
      if (!draft.collectionDate) errors.collectionDate = 'Enter a collection date.';
      if (!draft.deliveryDate) errors.deliveryDate = 'Enter a requested delivery date.';
      // FP_D02 — with the defect on, the two dates are never compared.
      if (!faults.on('FP_D02_DELIVERY_BEFORE_COLLECTION')
          && draft.collectionDate && draft.deliveryDate
          && draft.deliveryDate < draft.collectionDate) {
        errors.deliveryDate = 'The delivery date cannot be before the collection date.';
      }
    }

    if (step === 2) {
      const pieces = Number(draft.pieces);
      const weight = Number(draft.weight);
      if (!Number.isInteger(pieces) || pieces < 1) errors.pieces = 'Enter a whole number of pieces, at least 1.';
      if (!Number.isFinite(weight) || weight <= 0) errors.weight = 'Enter a gross weight above zero.';
      if (!draft.declaredValue || Number(draft.declaredValue) < 0) errors.declaredValue = 'Enter the declared value.';
    }

    if (step === 3) {
      if (!draft.serviceLevel) errors.serviceLevel = 'Choose a service level.';
      if (!draft.carrierId) errors.carrierId = 'Choose a carrier.';
    }

    if (Object.keys(errors).length) {
      draft.__errors = errors;
      drafts.set(key, draft);
      return ctx.redirect(`/shipments/new?step=${step}`);
    }

    drafts.set(key, draft);

    if (step < 4) return ctx.redirect(`/shipments/new?step=${step + 1}`);

    // ---- confirm ----------------------------------------------------------

    // FP_D16 — no idempotency key and no guard against a repeated confirm, so a second
    // POST of the same draft produces a second consignment.
    const idempotencyKey = `${key}:${draft.customerId}:${draft.collectionDate}:${draft.weight}`;
    if (!faults.on('FP_D16_DOUBLE_SUBMIT_BOOKS_TWICE') && issuedBookings.includes(idempotencyKey)) {
      setFlash(ctx, 'info', 'That booking has already been made.');
      return ctx.redirect('/shipments');
    }
    issuedBookings.push(idempotencyKey);

    // FP_D03 — the unit is read and then thrown away. With the defect off, pounds are
    // converted. With it on, 1000 lb is stored as 1000 kg.
    const rawWeight = Number(draft.weight);
    const weightKg = (draft.weightUnit === 'lb' && !faults.on('FP_D03_WEIGHT_UNIT_IGNORED'))
      ? Math.round(rawWeight * 0.45359237 * 10) / 10
      : rawWeight;

    const chosenCustomer = customer(draft.customerId);
    const service = state.SERVICE_LEVELS.find(s => s.code === draft.serviceLevel) ?? state.SERVICE_LEVELS[1];
    const index = state.shipments.length;
    const created = {
      id: `shp-${String(index + 1).padStart(4, '0')}`,
      reference: `MF${String(770_000 + index * 13)}`,
      trackingNumber: `1Z${String(index).padStart(3, '0')}MERIDIAN${String(index * 7919 % 100000).padStart(5, '0')}`,
      customerId: draft.customerId,
      salesOrderId: null,
      carrierId: draft.carrierId,
      status: 'booked',
      serviceLevel: service.code,
      incoterm: draft.incoterm ?? 'DAP',
      originWarehouseId: draft.originWarehouseId,
      destination: chosenCustomer?.addresses?.[0] ?? { city: '—', country: '—', countryCode: 'GB', line1: '', postcode: '' },
      pieces: Number(draft.pieces),
      weightKg,
      weightUnitEntered: draft.weightUnit ?? 'kg',
      volumeM3: Number(draft.volumeM3 ?? 0),
      declaredValueGbp: Number(draft.declaredValue),
      hazardous: draft.hazardous === 'on',
      temperatureControlled: draft.temperatureControlled === 'on',
      bookedAt: new Date().toISOString(),
      collectedAt: null,
      estimatedDeliveryOn: draft.deliveryDate,
      collectionDate: draft.collectionDate,
      deliveredAt: null,
      podSignatory: null,
      freightChargeGbp: Math.round(weightKg * 1.4 * 100) / 100,
      fuelSurchargePct: state.settings.billing.fuelSurchargePct,
      customsDeclarationId: null,
      exceptionCode: null,
      customerReference: draft.reference ?? '',
      goodsDescription: draft.goodsDescription ?? '',
      events: [{ at: new Date().toISOString(), code: 'BOOKED', description: 'Booking confirmed', location: 'Meridian control tower' }]
    };
    state.shipments.push(created);
    drafts.delete(key);

    setFlash(ctx, 'success', `Shipment ${created.reference} booked.`);
    return ctx.redirect(`/shipments/${created.id}`);
  });

  // ---- detail -------------------------------------------------------------

  definePage({
    path: '/shipments/:id', domain: 'shipments', title: 'Shipment', kind: 'detail',
    view: (ctx, user) => {
      const shipment = find(ctx.params.id);
      if (!shipment) {
        return { status: 404, title: 'Shipment not found',
          body: '<div class="panel"><div class="empty" data-testid="not-found">No shipment has that reference.</div></div>' };
      }

      // FP_D12 — with the defect off, a user whose role is scoped to a customer may only
      // read that customer's consignments. With it on, no check happens at all.
      if (!faults.on('FP_D12_SHIPMENT_IDOR')) {
        const scopedToCustomer = user.role === 'viewer' ? null : user.customerId ?? null;
        if (scopedToCustomer && shipment.customerId !== scopedToCustomer) {
          return { status: 403, title: 'Not available',
            body: '<div class="panel"><div class="empty">You do not have access to that shipment.</div></div>' };
        }
      }

      const cust = customer(shipment.customerId);
      const carr = carrier(shipment.carrierId);

      return {
        title: `Shipment ${shipment.reference}`,
        breadcrumbs: [{ label: 'Shipments', href: '/shipments' }, { label: shipment.reference }],
        actions: `
<a class="btn btn-secondary" href="/shipments/${h(shipment.id)}/edit" data-testid="edit-shipment">Edit</a>
<a class="btn btn-secondary" href="/shipments/${h(shipment.id)}/tracking" data-testid="view-tracking">Tracking</a>
<a class="btn btn-secondary" href="/shipments/${h(shipment.id)}/charges" data-testid="view-charges">Charges</a>
${['delivered', 'cancelled'].includes(shipment.status) ? '' :
  `<a class="btn btn-danger" href="/shipments/${h(shipment.id)}/cancel" data-testid="cancel-shipment">Cancel</a>`}`,
        body: `
<div class="grid grid-4" style="margin-bottom:14px">
${stat(statusPill(shipment.status), 'Status', 'detail-status')}
${stat(String(shipment.pieces), 'Pieces', 'detail-pieces')}
${stat(`${shipment.weightKg} kg`, 'Gross weight', 'detail-weight')}
${stat(shortDate(shipment.estimatedDeliveryOn), 'Due', 'detail-due')}
</div>

${tabs('shipment', [
  { key: 'summary', label: 'Summary', body: `<div class="grid grid-2">
<div class="panel"><h3 style="margin-top:0">Consignment</h3>${kv([
  ['Reference', h(shipment.reference)],
  ['Tracking number', `<code>${h(shipment.trackingNumber)}</code>`],
  ['Customer', cust ? `<a href="/customers/${h(cust.id)}">${h(cust.name)}</a>` : '—'],
  ['Carrier', carr ? `<a href="/carriers/${h(carr.id)}">${h(carr.name)}</a>` : '—'],
  ['Service level', `<code>${h(shipment.serviceLevel)}</code>`],
  ['Incoterm', `<code>${h(shipment.incoterm)}</code>`],
  ['Declared value', money(shipment.declaredValueGbp)],
  ['Hazardous', shipment.hazardous ? 'Yes' : 'No'],
  ['Temperature controlled', shipment.temperatureControlled ? 'Yes' : 'No']
])}</div>
<div class="panel"><h3 style="margin-top:0">Route</h3>${kv([
  ['Collect from', h(warehouse(shipment.originWarehouseId)?.name ?? '—')],
  ['Deliver to', h([shipment.destination.line1, shipment.destination.city, shipment.destination.postcode, shipment.destination.country].filter(Boolean).join(', '))],
  ['Booked', dateTime(shipment.bookedAt)],
  ['Collected', dateTime(shipment.collectedAt)],
  ['Estimated delivery', shortDate(shipment.estimatedDeliveryOn)],
  ['Delivered', dateTime(shipment.deliveredAt)],
  ['Signed for by', h(shipment.podSignatory ?? '—')]
])}</div></div>` },
  { key: 'events', label: `Events (${shipment.events.length})`, body: `<div class="panel">
<ul class="timeline" data-testid="event-timeline">${shipment.events.map(event =>
  `<li><time>${dateTime(event.at)}</time><strong>${h(event.description)}</strong>
   <span style="color:var(--muted)"> — ${h(event.location)} <code>${h(event.code)}</code></span></li>`).join('')}</ul>
</div>` },
  { key: 'documents', label: 'Documents', body: `<div class="panel">
${table({
  caption: 'Documents attached to this shipment', testId: 'shipment-documents',
  empty: 'No documents attached.',
  columns: [
    { header: 'Document', cell: row => h(row.name) },
    { header: 'Type', cell: row => h(row.type) },
    { header: 'Added', cell: row => shortDate(row.at) },
    { header: '', cell: row => `<a href="/shipments/${h(shipment.id)}/documents" data-testid="open-doc">Open</a>` }
  ],
  rows: [
    { name: `consignment-note-${shipment.reference}.pdf`, type: 'Consignment note', at: shipment.bookedAt },
    { name: `packing-list-${shipment.reference}.pdf`, type: 'Packing list', at: shipment.bookedAt },
    ...(shipment.deliveredAt ? [{ name: `pod-${shipment.reference}.pdf`, type: 'Proof of delivery', at: shipment.deliveredAt }] : [])
  ]
})}</div>` }
])}

${modal('record-exception-modal', 'Record an exception', `
<form method="post" action="/shipments/${h(shipment.id)}/exception" data-testid="exception-form">
${csrfField(ctx)}
${field({ name: 'code', label: 'Exception code', required: true, testId: 'exception-code',
  options: ['DAMAGED', 'REFUSED', 'ADDRESS_INVALID', 'MISSING_PIECES', 'DELAYED'] })}
${field({ name: 'notes', label: 'What happened', type: 'textarea', required: true, testId: 'exception-notes',
  attrs: { maxlength: '600' } })}
<button class="btn" type="submit" data-testid="exception-submit">Record exception</button>
</form>`)}
<p style="margin-top:12px"><button class="btn btn-secondary" type="button" data-opens-modal="record-exception-modal" data-testid="open-exception-modal">Record an exception</button></p>`
      };
    }
  });

  // ---- edit, charges, tracking, documents, labels, split ------------------

  definePage({
    path: '/shipments/:id/edit', domain: 'shipments', title: 'Edit shipment', kind: 'form',
    view: (ctx) => {
      const shipment = find(ctx.params.id);
      if (!shipment) return { status: 404, title: 'Shipment not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Edit ${shipment.reference}`,
        breadcrumbs: [{ label: 'Shipments', href: '/shipments' }, { label: shipment.reference, href: `/shipments/${shipment.id}` }, { label: 'Edit' }],
        body: `<div class="panel" style="max-width:620px">
<form method="post" action="/shipments/${h(shipment.id)}/edit" data-testid="edit-shipment-form">
${csrfField(ctx)}
${field({ name: 'pieces', label: 'Pieces', type: 'number', value: shipment.pieces, required: true, testId: 'edit-pieces', attrs: { min: '1', max: '500' } })}
${field({ name: 'weightKg', label: 'Gross weight (kg)', type: 'number', value: shipment.weightKg, required: true, testId: 'edit-weight', attrs: { min: '0.1', max: '30000', step: '0.1' } })}
${field({ name: 'serviceLevel', label: 'Service level', value: shipment.serviceLevel, testId: 'edit-service', options: state.SERVICE_LEVELS.map(s => ({ value: s.code, label: s.name })) })}
${field({ name: 'estimatedDeliveryOn', label: 'Estimated delivery', type: 'date', value: shipment.estimatedDeliveryOn, testId: 'edit-due' })}
${field({ name: 'customerReference', label: 'Customer reference', value: shipment.customerReference ?? '', testId: 'edit-reference', attrs: { maxlength: '40' } })}
<button class="btn" type="submit" data-testid="edit-save">Save changes</button>
<a class="btn btn-secondary" href="/shipments/${h(shipment.id)}">Cancel</a>
</form></div>`
      };
    }
  });

  app.post('/shipments/:id/edit', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const shipment = find(ctx.params.id);
    if (!shipment) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();
    if (!await csrfValid(ctx)) { setFlash(ctx, 'error', 'That form expired.'); return ctx.redirect(`/shipments/${shipment.id}`); }
    const pieces = Number(body.pieces);
    if (!Number.isInteger(pieces) || pieces < 1) {
      setFlash(ctx, 'error', 'Pieces must be a whole number of at least 1.');
      return ctx.redirect(`/shipments/${shipment.id}/edit`);
    }
    shipment.pieces = pieces;
    shipment.weightKg = Number(body.weightKg);
    shipment.serviceLevel = String(body.serviceLevel);
    shipment.estimatedDeliveryOn = String(body.estimatedDeliveryOn);
    shipment.customerReference = String(body.customerReference ?? '');
    setFlash(ctx, 'success', 'Shipment updated.');
    return ctx.redirect(`/shipments/${shipment.id}`);
  });

  definePage({
    path: '/shipments/:id/tracking', domain: 'shipments', title: 'Tracking', kind: 'detail',
    view: (ctx) => {
      const shipment = find(ctx.params.id);
      if (!shipment) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Tracking ${shipment.reference}`,
        breadcrumbs: [{ label: 'Shipments', href: '/shipments' }, { label: shipment.reference, href: `/shipments/${shipment.id}` }, { label: 'Tracking' }],
        body: `<div class="panel">
${kv([['Tracking number', `<code data-testid="tracking-number">${h(shipment.trackingNumber)}</code>`],
      ['Carrier', h(carrier(shipment.carrierId)?.name ?? '—')],
      ['Status', statusPill(shipment.status)],
      ['Estimated delivery', shortDate(shipment.estimatedDeliveryOn)]])}
<h3>Scan history</h3>
<ul class="timeline" data-testid="tracking-timeline">${shipment.events.map(event =>
  `<li><time>${dateTime(event.at)}</time><strong>${h(event.description)}</strong>
   <span style="color:var(--muted)"> — ${h(event.location)}</span></li>`).join('')}</ul>
</div>`
      };
    }
  });

  definePage({
    path: '/shipments/:id/documents', domain: 'shipments', title: 'Shipment documents', kind: 'list',
    view: (ctx) => {
      const shipment = find(ctx.params.id);
      if (!shipment) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Documents — ${shipment.reference}`,
        breadcrumbs: [{ label: 'Shipments', href: '/shipments' }, { label: shipment.reference, href: `/shipments/${shipment.id}` }, { label: 'Documents' }],
        body: `<div class="panel">
<form method="post" action="/shipments/${h(shipment.id)}/documents" enctype="multipart/form-data" data-testid="upload-document-form">
${csrfField(ctx)}
${field({ name: 'documentType', label: 'Document type', required: true, testId: 'document-type',
  options: ['Consignment note', 'Packing list', 'Commercial invoice', 'Certificate of origin', 'Dangerous goods note', 'Proof of delivery'] })}
${field({ name: 'file', label: 'File', type: 'file', required: true, testId: 'document-file',
  attrs: { accept: '.pdf,.jpg,.png' }, hint: 'PDF, JPG or PNG, up to 5 MB.' })}
<button class="btn" type="submit" data-testid="upload-document">Upload</button>
</form></div>`
      };
    }
  });

  app.post('/shipments/:id/documents', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    await ctx.body();
    setFlash(ctx, 'success', 'Document uploaded.');
    return ctx.redirect(`/shipments/${ctx.params.id}/documents`);
  });

  definePage({
    path: '/shipments/:id/charges', domain: 'shipments', title: 'Shipment charges', kind: 'detail',
    view: (ctx) => {
      const shipment = find(ctx.params.id);
      if (!shipment) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      const freight = shipment.freightChargeGbp;
      const fuel = Math.round(freight * (shipment.fuelSurchargePct / 100) * 100) / 100;
      const handling = Math.round(freight * 0.08 * 100) / 100;
      const net = Math.round((freight + fuel + handling) * 100) / 100;
      return {
        title: `Charges — ${shipment.reference}`,
        breadcrumbs: [{ label: 'Shipments', href: '/shipments' }, { label: shipment.reference, href: `/shipments/${shipment.id}` }, { label: 'Charges' }],
        body: `<div class="panel">${table({
          caption: 'Charges on this shipment', testId: 'charges-table',
          columns: [
            { header: 'Charge', cell: row => h(row.label) },
            { header: 'Basis', cell: row => h(row.basis) },
            { header: 'Amount', cell: row => money(row.amount) }
          ],
          rows: [
            { label: 'Freight', basis: `${shipment.weightKg} kg`, amount: freight },
            { label: `Fuel surcharge ${shipment.fuelSurchargePct}%`, basis: 'Freight', amount: fuel },
            { label: 'Handling', basis: 'Freight 8%', amount: handling }
          ]
        })}
<p style="margin-top:12px;font-size:16px"><strong>Net ${money(net)}</strong></p></div>`
      };
    }
  });

  definePage({
    path: '/shipments/:id/labels', domain: 'shipments', title: 'Labels and paperwork', kind: 'detail',
    view: (ctx) => {
      const shipment = find(ctx.params.id);
      if (!shipment) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Labels — ${shipment.reference}`,
        breadcrumbs: [{ label: 'Shipments', href: '/shipments' }, { label: shipment.reference, href: `/shipments/${shipment.id}` }, { label: 'Labels' }],
        body: `<div class="panel">
<p>${shipment.pieces} label(s) for this consignment.</p>
<form method="post" action="/shipments/${h(shipment.id)}/labels" data-testid="label-form">
${csrfField(ctx)}
${field({ name: 'format', label: 'Label format', options: ['A6 thermal', 'A4 sheet', 'Zebra ZPL'], testId: 'label-format' })}
${field({ name: 'copies', label: 'Copies per piece', type: 'number', value: 1, testId: 'label-copies', attrs: { min: '1', max: '5' } })}
<button class="btn" type="submit" data-testid="print-labels">Generate labels</button>
</form></div>`
      };
    }
  });

  app.post('/shipments/:id/labels', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    await ctx.body();
    setFlash(ctx, 'success', 'Labels generated.');
    return ctx.redirect(`/shipments/${ctx.params.id}/labels`);
  });

  definePage({
    path: '/shipments/:id/split', domain: 'shipments', title: 'Split shipment', kind: 'form',
    view: (ctx) => {
      const shipment = find(ctx.params.id);
      if (!shipment) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Split ${shipment.reference}`,
        breadcrumbs: [{ label: 'Shipments', href: '/shipments' }, { label: shipment.reference, href: `/shipments/${shipment.id}` }, { label: 'Split' }],
        body: `<div class="panel" style="max-width:560px">
<p class="hint">Splitting creates a second consignment and moves pieces to it. Charges are recalculated on both.</p>
<form method="post" action="/shipments/${h(shipment.id)}/split" data-testid="split-form">
${csrfField(ctx)}
${field({ name: 'pieces', label: 'Pieces to move to the new consignment', type: 'number', required: true, testId: 'split-pieces',
  attrs: { min: '1', max: String(Math.max(1, shipment.pieces - 1)) },
  hint: `This consignment has ${shipment.pieces} piece(s). At least one must remain.` })}
${field({ name: 'reason', label: 'Why is it being split', type: 'textarea', required: true, testId: 'split-reason', attrs: { maxlength: '300' } })}
<button class="btn" type="submit" data-testid="split-submit">Split consignment</button>
</form></div>`
      };
    }
  });

  app.post('/shipments/:id/split', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const shipment = find(ctx.params.id);
    if (!shipment) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();
    const moving = Number(body.pieces);
    // Correct: the split is bounded on both sides. Present so the lab is not uniformly bad.
    if (!Number.isInteger(moving) || moving < 1 || moving >= shipment.pieces) {
      setFlash(ctx, 'error', `Move between 1 and ${shipment.pieces - 1} pieces.`);
      return ctx.redirect(`/shipments/${shipment.id}/split`);
    }
    shipment.pieces -= moving;
    setFlash(ctx, 'success', `${moving} piece(s) moved to a new consignment.`);
    return ctx.redirect(`/shipments/${shipment.id}`);
  });

  definePage({
    path: '/shipments/consolidate', domain: 'shipments', title: 'Consolidate shipments', kind: 'form',
    view: (ctx) => {
      const candidates = state.shipments.filter(s => s.status === 'booked').slice(0, 12);
      return {
        title: 'Consolidate shipments',
        breadcrumbs: [{ label: 'Shipments', href: '/shipments' }, { label: 'Consolidate' }],
        body: `<div class="panel">
<p class="hint">Choose two or more booked consignments going to the same country to move them as one.</p>
<form method="post" action="/shipments/consolidate" data-testid="consolidate-form">
${csrfField(ctx)}
${table({
  caption: 'Booked consignments available to consolidate', testId: 'consolidate-table',
  empty: 'Nothing is available to consolidate.',
  columns: [
    { header: '', cell: row => `<input type="checkbox" name="shipmentIds" value="${h(row.id)}" data-testid="consolidate-${h(row.reference)}" aria-label="Include ${h(row.reference)}" style="width:auto" />` },
    { header: 'Reference', cell: row => h(row.reference) },
    { header: 'Customer', cell: row => h(customer(row.customerId)?.name ?? '—') },
    { header: 'Destination', cell: row => h(`${row.destination.city}, ${row.destination.countryCode}`) },
    { header: 'Pieces', cell: row => String(row.pieces) },
    { header: 'Weight', cell: row => `${row.weightKg} kg` }
  ],
  rows: candidates
})}
<button class="btn" type="submit" style="margin-top:12px" data-testid="consolidate-submit">Consolidate selected</button>
</form></div>`
      };
    }
  });

  app.post('/shipments/consolidate', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    const ids = [].concat(body.shipmentIds ?? []);
    if (ids.length < 2) {
      setFlash(ctx, 'error', 'Choose at least two consignments to consolidate.');
      return ctx.redirect('/shipments/consolidate');
    }
    setFlash(ctx, 'success', `${ids.length} consignments consolidated.`);
    return ctx.redirect('/shipments');
  });

  // ---- cancel -------------------------------------------------------------

  definePage({
    path: '/shipments/:id/cancel', domain: 'shipments', title: 'Cancel shipment', kind: 'form',
    view: (ctx) => {
      const shipment = find(ctx.params.id);
      if (!shipment) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      const onRoutes = state.routePlans.filter(route => route.stops.some(stop => stop.shipmentId === shipment.id));
      return {
        title: `Cancel ${shipment.reference}`,
        breadcrumbs: [{ label: 'Shipments', href: '/shipments' }, { label: shipment.reference, href: `/shipments/${shipment.id}` }, { label: 'Cancel' }],
        body: `<div class="panel" style="max-width:560px">
<div class="flash flash-warn" role="status">Cancelling cannot be undone. The customer is notified.</div>
${onRoutes.length ? `<p class="hint" data-testid="route-warning">This consignment appears on ${onRoutes.length} planned route(s): ${onRoutes.map(r => h(r.reference)).join(', ')}.</p>` : ''}
<form method="post" action="/shipments/${h(shipment.id)}/cancel" data-testid="cancel-form">
${csrfField(ctx)}
${field({ name: 'reason', label: 'Reason for cancelling', required: true, testId: 'cancel-reason',
  options: ['Customer request', 'Duplicate booking', 'Goods not ready', 'Credit hold', 'Other'] })}
${field({ name: 'notes', label: 'Notes', type: 'textarea', testId: 'cancel-notes', attrs: { maxlength: '400' } })}
<button class="btn btn-danger" type="submit" data-testid="confirm-cancel">Cancel this shipment</button>
<a class="btn btn-secondary" href="/shipments/${h(shipment.id)}">Keep it</a>
</form></div>`
      };
    }
  });

  app.post('/shipments/:id/cancel', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const shipment = find(ctx.params.id);
    if (!shipment) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();
    if (!body.reason) {
      setFlash(ctx, 'error', 'Choose a reason for cancelling.');
      return ctx.redirect(`/shipments/${shipment.id}/cancel`);
    }

    shipment.status = 'cancelled';
    shipment.events.push({ at: new Date().toISOString(), code: 'CANCELLED', description: `Cancelled — ${body.reason}`, location: 'Meridian control tower' });

    // FP_D14 — with the defect off, the stop is withdrawn too. With it on, the route keeps
    // a live stop for a consignment that no longer exists and the driver is still sent.
    if (!faults.on('FP_D14_CANCEL_ORPHANS_ROUTE_STOP')) {
      for (const route of state.routePlans) {
        for (const stop of route.stops) {
          if (stop.shipmentId === shipment.id) stop.status = 'cancelled';
        }
      }
    }

    setFlash(ctx, 'success', `${shipment.reference} cancelled.`);
    return ctx.redirect(`/shipments/${shipment.id}`);
  });

  // ---- exception ----------------------------------------------------------

  definePage({
    path: '/shipments/:id/exception', domain: 'shipments', title: 'Record an exception', kind: 'form',
    view: (ctx) => {
      const shipment = find(ctx.params.id);
      if (!shipment) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Record an exception — ${shipment.reference}`,
        breadcrumbs: [{ label: 'Shipments', href: '/shipments' }, { label: shipment.reference, href: `/shipments/${shipment.id}` }, { label: 'Exception' }],
        body: `<div class="panel" style="max-width:560px">
<form method="post" action="/shipments/${h(shipment.id)}/exception" data-testid="exception-page-form">
${csrfField(ctx)}
${field({ name: 'code', label: 'Exception code', required: true, testId: 'page-exception-code',
  options: ['DAMAGED', 'REFUSED', 'ADDRESS_INVALID', 'MISSING_PIECES', 'DELAYED'] })}
${field({ name: 'notes', label: 'What happened', type: 'textarea', required: true, testId: 'page-exception-notes', attrs: { maxlength: '600' } })}
<button class="btn" type="submit" data-testid="page-exception-submit">Record exception</button>
</form></div>`
      };
    }
  });

  app.post('/shipments/:id/exception', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const shipment = find(ctx.params.id);
    if (!shipment) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();
    if (!body.code || !String(body.notes ?? '').trim()) {
      setFlash(ctx, 'error', 'An exception needs a code and a note.');
      return ctx.redirect(`/shipments/${shipment.id}/exception`);
    }
    shipment.status = 'exception';
    shipment.exceptionCode = String(body.code);
    shipment.events.push({ at: new Date().toISOString(), code: 'EXCEPTION', description: String(body.notes), location: 'Destination' });
    setFlash(ctx, 'success', 'Exception recorded.');
    return ctx.redirect(`/shipments/${shipment.id}`);
  });

  // ---- JSON API -----------------------------------------------------------

  app.get('/api/shipments', (ctx) => {
    if (!core.requireAuth(ctx)) return;
    ctx.json(200, { total: state.shipments.length, shipments: state.shipments.slice(0, 50) });
  });

  app.get('/api/shipments/:id', (ctx) => {
    const shipment = find(ctx.params.id);
    if (!shipment) {
      // FP_D31 — the whole error object is serialised, disclosing the deployment layout
      // and the dependency versions along with it.
      if (faults.on('FP_D31_STACK_TRACE_LEAKED')) {
        const error = new Error(`No shipment ${ctx.params.id}`);
        return ctx.json(500, {
          error: 'lookup_failed',
          message: error.message,
          stack: error.stack,
          cwd: process.cwd(),
          node: process.version
        });
      }
      return ctx.json(404, { error: 'not_found' });
    }
    ctx.json(200, shipment);
  });
}
