/**
 * Carriers: contracts, rate cards, service levels and performance.
 *
 *   FP_D07  a weight exactly on a band boundary is rated in the cheaper band
 *   FP_D25  the rate card table forces the whole page to scroll sideways on a phone
 */
import { h, table, field, statusPill, shortDate, money, kv, tabs, stat } from '../ui/chrome.js';

export const SCREENS = [
  { path: '/carriers', title: 'Carriers', kind: 'list' },
  { path: '/carriers/new', title: 'Add a carrier', kind: 'form' },
  { path: '/carriers/performance', title: 'Carrier performance', kind: 'report' },
  { path: '/carriers/onboarding', title: 'Carrier onboarding', kind: 'form' },
  { path: '/carriers/:id', title: 'Carrier', kind: 'detail' },
  { path: '/carriers/:id/contracts', title: 'Carrier contracts', kind: 'list' },
  { path: '/carriers/:id/rates', title: 'Rate card', kind: 'detail' },
  { path: '/carriers/:id/services', title: 'Service levels', kind: 'list' },
  { path: '/carriers/:id/documents', title: 'Carrier documents', kind: 'list' },
  { path: '/carriers/:id/quote', title: 'Quote a rate', kind: 'form' }
];

export default function registerCarriers({ app, core, state, faults }) {
  const { definePage, csrfField, setFlash } = core;

  const find = id => state.carriers.find(c => c.id === id || c.code === id);
  const rateCard = carrierId => state.rateCards.find(r => r.carrierId === carrierId);

  for (const screen of SCREENS) {
    if (screen.path.includes(':id')) screen.sample = screen.path.replace(':id', state.carriers[0].id);
  }

  /**
   * Band selection. The published card says a weight on a boundary belongs to the upper
   * band; FP_D07 makes the code disagree by using < instead of <=.
   */
  const bandFor = (card, weightKg) => faults.on('FP_D07_RATE_BAND_BOUNDARY')
    ? card.bands.find(band => weightKg >= band.fromKg && weightKg < band.toKg) ?? card.bands.at(-1)
    : card.bands.find(band => weightKg > band.fromKg && weightKg <= band.toKg) ?? card.bands[0];

  definePage({
    path: '/carriers', domain: 'carriers', title: 'Carriers', kind: 'list',
    view: (ctx) => {
      const mode = String(ctx.query.mode ?? '');
      const rows = mode ? state.carriers.filter(c => c.mode === mode) : state.carriers;
      return {
        title: 'Carriers',
        actions: `<a class="btn" href="/carriers/new" data-testid="new-carrier">Add a carrier</a>
                  <a class="btn btn-secondary" href="/carriers/performance" data-testid="carrier-performance">Performance</a>`,
        body: `<form method="get" action="/carriers" class="filters" data-testid="carrier-filters">
${field({ name: 'mode', label: 'Mode', value: mode, testId: 'filter-mode',
  options: [{ value: '', label: 'Any mode' }, 'road', 'air', 'sea'] })}
<button class="btn" type="submit" data-testid="carrier-apply">Apply</button></form>
${table({
  caption: 'Carriers Meridian books with', testId: 'carriers-table', empty: 'No carriers match.',
  columns: [
    { header: 'Carrier', cell: row => `<a href="/carriers/${h(row.id)}" data-testid="carrier-${h(row.code)}">${h(row.name)}</a>` },
    { header: 'Code', cell: row => `<code>${h(row.code)}</code>` },
    { header: 'Mode', cell: row => h(row.mode) },
    { header: 'Own fleet', cell: row => row.ownFleet ? 'Yes' : 'No' },
    { header: 'On time', cell: row => `${row.onTimePct}%` },
    { header: 'Damage rate', cell: row => `${row.damageRatePct}%` },
    { header: 'Insurance expires', cell: row => shortDate(row.insuranceExpiry) },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows
})}`
      };
    }
  });

  definePage({
    path: '/carriers/new', domain: 'carriers', title: 'Add a carrier', kind: 'form',
    view: (ctx) => ({
      title: 'Add a carrier',
      breadcrumbs: [{ label: 'Carriers', href: '/carriers' }, { label: 'Add' }],
      body: `<div class="panel" style="max-width:600px">
<form method="post" action="/carriers/new" data-testid="new-carrier-form">
${csrfField(ctx)}
${field({ name: 'name', label: 'Carrier name', required: true, testId: 'carrier-name', attrs: { maxlength: '120' } })}
${field({ name: 'code', label: 'Short code', required: true, testId: 'carrier-code',
  attrs: { maxlength: '8', pattern: '[A-Z0-9]{2,8}' }, hint: 'Two to eight capitals or digits.' })}
${field({ name: 'mode', label: 'Mode', required: true, testId: 'carrier-mode', options: ['road', 'air', 'sea'] })}
${field({ name: 'scacCode', label: 'SCAC code', testId: 'carrier-scac', attrs: { maxlength: '4', pattern: '[A-Z]{2,4}' } })}
${field({ name: 'contactEmail', label: 'Bookings email', type: 'email', required: true, testId: 'carrier-email' })}
${field({ name: 'contactPhone', label: 'Bookings telephone', type: 'tel', testId: 'carrier-phone' })}
${field({ name: 'insuranceExpiry', label: 'Insurance expires on', type: 'date', required: true, testId: 'carrier-insurance',
  hint: 'A carrier cannot be booked after this date.' })}
<button class="btn" type="submit" data-testid="carrier-submit">Add carrier</button>
</form></div>`
    })
  });

  app.post('/carriers/new', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    const name = String(body.name ?? '').trim();
    const code = String(body.code ?? '').trim().toUpperCase();
    if (!name || !/^[A-Z0-9]{2,8}$/.test(code)) {
      setFlash(ctx, 'error', 'A name and a two to eight character code are required.');
      return ctx.redirect('/carriers/new');
    }
    // Correct: the code is checked for uniqueness, unlike the invoice reference.
    if (state.carriers.some(c => c.code === code)) {
      setFlash(ctx, 'error', `The code ${code} is already in use.`);
      return ctx.redirect('/carriers/new');
    }
    const created = {
      id: `car-${String(state.carriers.length + 1).padStart(3, '0')}`,
      code, name, mode: String(body.mode ?? 'road'), status: 'active', ownFleet: false,
      scacCode: String(body.scacCode ?? ''), contactEmail: String(body.contactEmail ?? ''),
      contactPhone: String(body.contactPhone ?? ''), onTimePct: 0, damageRatePct: 0, claimsOpen: 0,
      insuranceExpiry: String(body.insuranceExpiry ?? ''), contracts: [], serviceLevels: ['STD']
    };
    state.carriers.push(created);
    state.rateCards.push({
      id: `rc-${created.id}`, carrierId: created.id, name: `${created.name} 2026 standard`,
      effectiveFrom: new Date().toISOString().slice(0, 10), effectiveTo: '2027-12-31', currency: 'GBP',
      minimumChargeGbp: 45,
      bands: [
        { fromKg: 0, toKg: 50, ratePerKgGbp: 2.4 }, { fromKg: 50, toKg: 250, ratePerKgGbp: 1.6 },
        { fromKg: 250, toKg: 1000, ratePerKgGbp: 1.05 }, { fromKg: 1000, toKg: 99999, ratePerKgGbp: 0.7 }
      ],
      surcharges: [{ code: 'FUEL', name: 'Fuel', percent: 11.5 }]
    });
    setFlash(ctx, 'success', `${created.name} added.`);
    return ctx.redirect(`/carriers/${created.id}`);
  });

  definePage({
    path: '/carriers/:id', domain: 'carriers', title: 'Carrier', kind: 'detail',
    view: (ctx) => {
      const carrier = find(ctx.params.id);
      if (!carrier) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty" data-testid="not-found">No such carrier.</div></div>' };
      const shipments = state.shipments.filter(s => s.carrierId === carrier.id);
      return {
        title: carrier.name,
        breadcrumbs: [{ label: 'Carriers', href: '/carriers' }, { label: carrier.name }],
        actions: `<a class="btn btn-secondary" href="/carriers/${h(carrier.id)}/rates" data-testid="view-rates">Rate card</a>
<a class="btn btn-secondary" href="/carriers/${h(carrier.id)}/contracts" data-testid="view-contracts">Contracts</a>
<a class="btn" href="/carriers/${h(carrier.id)}/quote" data-testid="quote-rate">Quote a rate</a>`,
        body: `<div class="grid grid-4" style="margin-bottom:14px">
${stat(`${carrier.onTimePct}%`, 'On time', 'carrier-ontime')}
${stat(`${carrier.damageRatePct}%`, 'Damage rate', 'carrier-damage')}
${stat(String(carrier.claimsOpen), 'Open claims', 'carrier-claims')}
${stat(String(shipments.length), 'Shipments booked', 'carrier-shipments')}
</div>
${tabs('carrier', [
  { key: 'summary', label: 'Summary', body: `<div class="panel">${kv([
    ['Code', `<code>${h(carrier.code)}</code>`],
    ['SCAC', `<code>${h(carrier.scacCode)}</code>`],
    ['Mode', h(carrier.mode)],
    ['Own fleet', carrier.ownFleet ? 'Yes' : 'No'],
    ['Bookings email', h(carrier.contactEmail)],
    ['Bookings telephone', h(carrier.contactPhone)],
    ['Insurance expires', shortDate(carrier.insuranceExpiry)],
    ['Status', statusPill(carrier.status)]
  ])}</div>` },
  { key: 'services', label: 'Service levels', body: `<div class="panel">${table({
    caption: 'Service levels this carrier offers', testId: 'carrier-services',
    empty: 'No service levels configured.',
    columns: [
      { header: 'Service', cell: row => h(row.name) },
      { header: 'Code', cell: row => `<code>${h(row.code)}</code>` },
      { header: 'Transit days', cell: row => String(row.transitDays) },
      { header: 'Surcharge', cell: row => `${row.surchargePct}%` }
    ],
    rows: state.SERVICE_LEVELS.filter(s => carrier.serviceLevels.includes(s.code))
  })}</div>` },
  { key: 'shipments', label: `Shipments (${shipments.length})`, body: `<div class="panel">${table({
    caption: 'Shipments booked with this carrier', testId: 'carrier-shipments-table',
    empty: 'No shipments booked with this carrier.',
    columns: [
      { header: 'Reference', cell: row => `<a href="/shipments/${h(row.id)}">${h(row.reference)}</a>` },
      { header: 'Service', cell: row => `<code>${h(row.serviceLevel)}</code>` },
      { header: 'Weight', cell: row => `${row.weightKg} kg` },
      { header: 'Due', cell: row => shortDate(row.estimatedDeliveryOn) },
      { header: 'Status', cell: row => statusPill(row.status) }
    ],
    rows: shipments.slice(0, 15)
  })}</div>` }
])}`
      };
    }
  });

  definePage({
    path: '/carriers/:id/rates', domain: 'carriers', title: 'Rate card', kind: 'detail',
    view: (ctx) => {
      const carrier = find(ctx.params.id);
      if (!carrier) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">No such carrier.</div></div>' };
      const card = rateCard(carrier.id);
      if (!card) return { status: 404, title: 'No rate card', body: '<div class="panel"><div class="empty">This carrier has no rate card.</div></div>' };

      const overflows = faults.on('FP_D25_RATE_TABLE_OVERFLOWS');

      // FP_D25 — a fixed minimum width with no scroll container, so the page itself
      // scrolls sideways below about 1000px rather than the table.
      const bandsTable = `<table style="${overflows ? 'min-width:980px;' : ''}" data-testid="rate-bands">
<caption class="sr-only" style="position:absolute;left:-9999px">Weight bands and rates</caption>
<thead><tr><th scope="col">From (kg)</th><th scope="col">To (kg)</th><th scope="col">Rate per kg</th>
<th scope="col">50 kg costs</th><th scope="col">250 kg costs</th><th scope="col">1000 kg costs</th>
<th scope="col">Minimum charge</th><th scope="col">Effective from</th><th scope="col">Effective to</th></tr></thead>
<tbody>${card.bands.map(band => `<tr>
<td>${band.fromKg}</td><td>${band.toKg === 99999 ? 'and above' : band.toKg}</td>
<td>${money(band.ratePerKgGbp)}</td>
<td>${money(Math.max(card.minimumChargeGbp, 50 * band.ratePerKgGbp))}</td>
<td>${money(Math.max(card.minimumChargeGbp, 250 * band.ratePerKgGbp))}</td>
<td>${money(Math.max(card.minimumChargeGbp, 1000 * band.ratePerKgGbp))}</td>
<td>${money(card.minimumChargeGbp)}</td>
<td>${shortDate(card.effectiveFrom)}</td><td>${shortDate(card.effectiveTo)}</td>
</tr>`).join('')}</tbody></table>`;

      return {
        title: `Rate card — ${carrier.name}`,
        breadcrumbs: [{ label: 'Carriers', href: '/carriers' }, { label: carrier.name, href: `/carriers/${carrier.id}` }, { label: 'Rates' }],
        actions: `<a class="btn" href="/carriers/${h(carrier.id)}/quote" data-testid="quote-from-rates">Quote a rate</a>`,
        body: `<div class="panel">
<p class="hint">A weight exactly on a band boundary belongs to the <strong>upper</strong> band.</p>
${overflows ? bandsTable : `<div class="table-wrap">${bandsTable}</div>`}
</div>
<div class="panel"><h3 style="margin-top:0">Surcharges</h3>
${table({
  caption: 'Surcharges on this card', testId: 'rate-surcharges',
  columns: [
    { header: 'Code', cell: row => `<code>${h(row.code)}</code>` },
    { header: 'Surcharge', cell: row => h(row.name) },
    { header: 'Basis', cell: row => row.percent !== undefined ? `${row.percent}% of net freight` : 'Flat' },
    { header: 'Amount', cell: row => row.percent !== undefined ? `${row.percent}%` : money(row.flatGbp) }
  ],
  rows: card.surcharges
})}</div>`
      };
    }
  });

  definePage({
    path: '/carriers/:id/quote', domain: 'carriers', title: 'Quote a rate', kind: 'form',
    view: (ctx) => {
      const carrier = find(ctx.params.id);
      if (!carrier) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">No such carrier.</div></div>' };
      const card = rateCard(carrier.id);
      const weight = Number(ctx.query.weight ?? 0);
      let quoted = null;
      if (weight > 0 && card) {
        const band = bandFor(card, weight);
        const freight = Math.max(card.minimumChargeGbp, Math.round(weight * band.ratePerKgGbp * 100) / 100);
        const fuel = Math.round(freight * 0.115 * 100) / 100;
        quoted = { band, freight, fuel, total: Math.round((freight + fuel) * 100) / 100 };
      }
      return {
        title: `Quote — ${carrier.name}`,
        breadcrumbs: [{ label: 'Carriers', href: '/carriers' }, { label: carrier.name, href: `/carriers/${carrier.id}` }, { label: 'Quote' }],
        body: `<div class="panel" style="max-width:520px">
<form method="get" action="/carriers/${h(carrier.id)}/quote" data-testid="quote-form">
${field({ name: 'weight', label: 'Chargeable weight (kg)', type: 'number', value: ctx.query.weight ?? '', required: true,
  testId: 'quote-weight', attrs: { min: '0.1', max: '30000', step: '0.01' },
  hint: 'Try 50 and 50.01 — they should fall in different bands.' })}
<button class="btn" type="submit" data-testid="quote-submit">Quote</button>
</form>
${quoted ? `<div style="margin-top:16px" data-testid="quote-result">${kv([
  ['Band', `${quoted.band.fromKg}–${quoted.band.toKg === 99999 ? 'above' : quoted.band.toKg} kg`],
  ['Rate per kg', money(quoted.band.ratePerKgGbp)],
  ['Freight', money(quoted.freight)],
  ['Fuel surcharge 11.5%', money(quoted.fuel)],
  ['Total', `<strong>${money(quoted.total)}</strong>`]
])}</div>` : ''}
</div>`
      };
    }
  });

  definePage({
    path: '/carriers/:id/contracts', domain: 'carriers', title: 'Carrier contracts', kind: 'list',
    view: (ctx) => {
      const carrier = find(ctx.params.id);
      if (!carrier) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">No such carrier.</div></div>' };
      return {
        title: `Contracts — ${carrier.name}`,
        breadcrumbs: [{ label: 'Carriers', href: '/carriers' }, { label: carrier.name, href: `/carriers/${carrier.id}` }, { label: 'Contracts' }],
        body: `<div class="panel">${table({
          caption: 'Contracts with this carrier', testId: 'contracts-table', empty: 'No contracts recorded.',
          columns: [
            { header: 'Reference', cell: row => `<code>${h(row.reference)}</code>` },
            { header: 'Starts', cell: row => shortDate(row.startsOn) },
            { header: 'Ends', cell: row => shortDate(row.endsOn) },
            { header: 'Minimum volume', cell: row => `${row.minimumVolumePerMonth} per month` },
            { header: 'Late penalty', cell: row => money(row.penaltyPerLateDeliveryGbp) },
            { header: 'Status', cell: row => statusPill(row.status) }
          ],
          rows: carrier.contracts
        })}</div>`
      };
    }
  });

  definePage({
    path: '/carriers/:id/services', domain: 'carriers', title: 'Service levels', kind: 'list',
    view: (ctx) => {
      const carrier = find(ctx.params.id);
      if (!carrier) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">No such carrier.</div></div>' };
      return {
        title: `Service levels — ${carrier.name}`,
        breadcrumbs: [{ label: 'Carriers', href: '/carriers' }, { label: carrier.name, href: `/carriers/${carrier.id}` }, { label: 'Services' }],
        body: `<div class="panel">${table({
          caption: 'Service levels offered', testId: 'services-table',
          columns: [
            { header: 'Service', cell: row => h(row.name) },
            { header: 'Code', cell: row => `<code>${h(row.code)}</code>` },
            { header: 'Transit days', cell: row => String(row.transitDays) },
            { header: 'Surcharge', cell: row => `${row.surchargePct}%` },
            { header: 'Offered', cell: row => carrier.serviceLevels.includes(row.code)
              ? '<span class="pill pill-ok">Yes</span>' : '<span class="pill pill-muted">No</span>' }
          ],
          rows: state.SERVICE_LEVELS
        })}</div>`
      };
    }
  });

  definePage({
    path: '/carriers/:id/documents', domain: 'carriers', title: 'Carrier documents', kind: 'list',
    view: (ctx) => {
      const carrier = find(ctx.params.id);
      if (!carrier) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">No such carrier.</div></div>' };
      return {
        title: `Documents — ${carrier.name}`,
        breadcrumbs: [{ label: 'Carriers', href: '/carriers' }, { label: carrier.name, href: `/carriers/${carrier.id}` }, { label: 'Documents' }],
        body: `<div class="panel">
${table({
  caption: 'Documents held for this carrier', testId: 'carrier-documents',
  columns: [
    { header: 'Document', cell: row => h(row.name) },
    { header: 'Expires', cell: row => shortDate(row.expires) },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: [
    { name: 'Goods in transit insurance', expires: carrier.insuranceExpiry, status: new Date(carrier.insuranceExpiry) < new Date('2026-04-01') ? 'expired' : 'active' },
    { name: 'Operator licence', expires: '2027-03-31', status: 'active' },
    { name: 'Signed terms of carriage', expires: '2027-12-31', status: 'active' }
  ]
})}
<h3>Upload a document</h3>
<form method="post" action="/carriers/${h(carrier.id)}/documents" enctype="multipart/form-data" data-testid="carrier-upload-form">
${csrfField(ctx)}
${field({ name: 'documentType', label: 'Document type', required: true, testId: 'carrier-doc-type',
  options: ['Insurance certificate', 'Operator licence', 'Terms of carriage', 'Other'] })}
${field({ name: 'expiresOn', label: 'Expires on', type: 'date', required: true, testId: 'carrier-doc-expiry' })}
${field({ name: 'file', label: 'File', type: 'file', required: true, testId: 'carrier-doc-file', attrs: { accept: '.pdf' }, hint: 'PDF, up to 5 MB.' })}
<button class="btn" type="submit" data-testid="carrier-doc-upload">Upload</button>
</form></div>`
      };
    }
  });

  app.post('/carriers/:id/documents', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    await ctx.body();
    setFlash(ctx, 'success', 'Document uploaded.');
    return ctx.redirect(`/carriers/${ctx.params.id}/documents`);
  });

  definePage({
    path: '/carriers/performance', domain: 'carriers', title: 'Carrier performance', kind: 'report',
    view: () => ({
      title: 'Carrier performance',
      breadcrumbs: [{ label: 'Carriers', href: '/carriers' }, { label: 'Performance' }],
      body: `<div class="panel">${table({
        caption: 'Carrier scorecard', testId: 'performance-table',
        columns: [
          { header: 'Carrier', cell: row => `<a href="/carriers/${h(row.id)}">${h(row.name)}</a>` },
          { header: 'Mode', cell: row => h(row.mode) },
          { header: 'Shipments', cell: row => String(state.shipments.filter(s => s.carrierId === row.id).length) },
          { header: 'On time', cell: row => `<span class="pill pill-${row.onTimePct >= 95 ? 'ok' : row.onTimePct >= 90 ? 'warn' : 'danger'}">${row.onTimePct}%</span>` },
          { header: 'Damage rate', cell: row => `<span class="pill pill-${row.damageRatePct < 0.5 ? 'ok' : row.damageRatePct < 1.2 ? 'warn' : 'danger'}">${row.damageRatePct}%</span>` },
          { header: 'Open claims', cell: row => String(row.claimsOpen) },
          { header: 'Contract', cell: row => statusPill(row.contracts[0]?.status ?? 'expired') }
        ],
        rows: state.carriers
      })}</div>`
    })
  });

  definePage({
    path: '/carriers/onboarding', domain: 'carriers', title: 'Carrier onboarding', kind: 'form',
    view: (ctx) => ({
      title: 'Carrier onboarding',
      breadcrumbs: [{ label: 'Carriers', href: '/carriers' }, { label: 'Onboarding' }],
      body: `<div class="panel" style="max-width:620px">
<p class="hint">Everything a carrier needs before its first booking. Each item must be recorded before the carrier becomes bookable.</p>
<form method="post" action="/carriers/onboarding" data-testid="onboarding-form">
${csrfField(ctx)}
${field({ name: 'carrierId', label: 'Carrier', required: true, testId: 'onboarding-carrier',
  options: [{ value: '', label: 'Choose a carrier' }, ...state.carriers.map(c => ({ value: c.id, label: c.name }))] })}
${field({ name: 'insuranceChecked', label: 'Goods in transit insurance verified', type: 'checkbox', testId: 'onboarding-insurance' })}
${field({ name: 'licenceChecked', label: 'Operator licence verified', type: 'checkbox', testId: 'onboarding-licence' })}
${field({ name: 'termsSigned', label: 'Terms of carriage signed', type: 'checkbox', testId: 'onboarding-terms' })}
${field({ name: 'rateCardAgreed', label: 'Rate card agreed', type: 'checkbox', testId: 'onboarding-rates' })}
${field({ name: 'ediTested', label: 'EDI connection tested', type: 'checkbox', testId: 'onboarding-edi' })}
${field({ name: 'notes', label: 'Notes', type: 'textarea', testId: 'onboarding-notes', attrs: { maxlength: '500' } })}
<button class="btn" type="submit" data-testid="onboarding-submit">Complete onboarding</button>
</form></div>`
    })
  });

  app.post('/carriers/onboarding', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    const required = ['insuranceChecked', 'licenceChecked', 'termsSigned', 'rateCardAgreed'];
    const missing = required.filter(key => body[key] !== 'on');
    // Correct: onboarding cannot complete with an unchecked mandatory item.
    if (missing.length) {
      setFlash(ctx, 'error', `${missing.length} mandatory check(s) are not complete.`);
      return ctx.redirect('/carriers/onboarding');
    }
    const carrier = find(String(body.carrierId ?? ''));
    if (carrier) carrier.status = 'active';
    setFlash(ctx, 'success', 'Onboarding complete. The carrier is now bookable.');
    return ctx.redirect('/carriers');
  });
}
