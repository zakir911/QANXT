/**
 * Customs: declarations, classification, duties, holds and release.
 *
 *   FP_D08  duty on a CIF consignment is calculated without the freight cost
 *   FP_D17  a declaration customs has rejected can be released anyway
 */
import { h, table, field, statusPill, shortDate, dateTime, money, kv, tabs, stat } from '../ui/chrome.js';

export const SCREENS = [
  { path: '/customs', title: 'Customs', kind: 'dashboard' },
  { path: '/customs/declarations', title: 'Declarations', kind: 'list' },
  { path: '/customs/declarations/new', title: 'New declaration', kind: 'form' },
  { path: '/customs/declarations/:id', title: 'Declaration', kind: 'detail' },
  { path: '/customs/declarations/:id/documents', title: 'Declaration documents', kind: 'list' },
  { path: '/customs/declarations/:id/release', title: 'Release a declaration', kind: 'form' },
  { path: '/customs/holds', title: 'Customs holds', kind: 'list' },
  { path: '/customs/hs-codes', title: 'Commodity codes', kind: 'list' },
  { path: '/customs/duties', title: 'Duty and VAT rates', kind: 'report' },
  { path: '/customs/compliance', title: 'Compliance checks', kind: 'report' }
];

export default function registerCustoms({ app, core, state, faults }) {
  const { definePage, csrfField, csrfValid, setFlash, listParams, paginate, can } = core;

  const shipment = id => state.shipments.find(s => s.id === id);
  const find = id => state.declarations.find(d => d.id === id || d.reference === id);

  for (const screen of SCREENS) {
    if (screen.path.includes(':id')) screen.sample = screen.path.replace(':id', state.declarations[0].id);
  }

  /**
   * Customs value. For CIF, the value for duty includes cost, insurance and freight.
   * FP_D08 uses the goods value alone, understating duty on every CIF consignment.
   */
  const dutyFor = (declaration) => {
    const linked = shipment(declaration.shipmentId);
    const freight = linked?.freightChargeGbp ?? 0;
    const cifTerms = ['CIF', 'CIP', 'CFR', 'DAP', 'DDP', 'DPU'];
    const includesFreight = linked && cifTerms.includes(linked.incoterm);
    const basis = (includesFreight && !faults.on('FP_D08_DUTY_EXCLUDES_FREIGHT'))
      ? declaration.declaredValueGbp + freight
      : declaration.declaredValueGbp;
    return {
      basis: Math.round(basis * 100) / 100,
      freight,
      includesFreight,
      duty: Math.round(basis * (declaration.dutyRatePct / 100) * 100) / 100
    };
  };

  definePage({
    path: '/customs', domain: 'customs', title: 'Customs', kind: 'dashboard',
    view: () => {
      const held = state.declarations.filter(d => d.status === 'held');
      const rejected = state.declarations.filter(d => d.status === 'rejected');
      const controlled = state.declarations.filter(d => d.controlled);
      return {
        title: 'Customs',
        actions: `<a class="btn" href="/customs/declarations/new" data-testid="new-declaration">New declaration</a>
<a class="btn btn-secondary" href="/customs/holds" data-testid="go-holds">Holds</a>`,
        body: `<div class="grid grid-4" style="margin-bottom:16px">
${stat(String(state.declarations.length), 'Declarations', 'stat-declarations')}
${stat(String(held.length), 'On hold', 'stat-held-declarations')}
${stat(String(rejected.length), 'Rejected', 'stat-rejected')}
${stat(String(controlled.length), 'Controlled goods', 'stat-controlled')}
</div>
<div class="panel"><h2 style="margin-top:0">Needs attention</h2>
${table({
  caption: 'Declarations held or rejected', testId: 'customs-attention', empty: 'Nothing held or rejected.',
  columns: [
    { header: 'Declaration', cell: row => `<a href="/customs/declarations/${h(row.id)}">${h(row.reference)}</a>` },
    { header: 'Shipment', cell: row => {
        const linked = shipment(row.shipmentId);
        return linked ? `<a href="/shipments/${h(linked.id)}">${h(linked.reference)}</a>` : '—';
      } },
    { header: 'Direction', cell: row => h(row.direction) },
    { header: 'Reason', cell: row => h(row.holdReason ?? '—') },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: [...held, ...rejected]
})}</div>`
      };
    }
  });

  definePage({
    path: '/customs/declarations', domain: 'customs', title: 'Declarations', kind: 'list',
    view: (ctx) => {
      const { page, size, q } = listParams(ctx);
      const status = String(ctx.query.status ?? '');
      let rows = state.declarations;
      if (status) rows = rows.filter(d => d.status === status);
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter(d => d.reference.toLowerCase().includes(needle) || d.hsCode.includes(needle));
      }
      const { slice, pageCount } = paginate(rows, page, size);
      return {
        title: 'Declarations',
        breadcrumbs: [{ label: 'Customs', href: '/customs' }, { label: 'Declarations' }],
        actions: `<a class="btn" href="/customs/declarations/new" data-testid="new-declaration">New declaration</a>`,
        body: `<form method="get" action="/customs/declarations" class="filters" data-testid="declaration-filters">
${field({ name: 'q', label: 'Search', type: 'search', value: q, testId: 'declaration-search', hint: 'Reference or commodity code.' })}
${field({ name: 'status', label: 'Status', value: status, testId: 'declaration-status',
  options: [{ value: '', label: 'Any status' }, 'draft', 'submitted', 'accepted', 'held', 'released', 'rejected'] })}
<button class="btn" type="submit" data-testid="declaration-apply">Apply</button></form>
${table({
  caption: 'Customs declarations', testId: 'declarations-table', empty: 'No declarations match.',
  columns: [
    { header: 'Reference', cell: row => `<a href="/customs/declarations/${h(row.id)}" data-testid="declaration-${h(row.reference)}">${h(row.reference)}</a>` },
    { header: 'Direction', cell: row => h(row.direction) },
    { header: 'Procedure', cell: row => `<code>${h(row.procedureCode)}</code>` },
    { header: 'Commodity', cell: row => `<code>${h(row.hsCode)}</code>` },
    { header: 'Origin', cell: row => h(row.countryOfOrigin) },
    { header: 'Value', cell: row => money(row.declaredValueGbp) },
    { header: 'Duty', cell: row => money(dutyFor(row).duty) },
    { header: 'Flags', cell: row => [
        row.controlled ? '<span class="pill pill-danger">Controlled</span>' : '',
        row.excise ? '<span class="pill pill-warn">Excise</span>' : ''
      ].filter(Boolean).join(' ') },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: slice
})}
${state.pagination === undefined ? '' : ''}`
      };
    }
  });

  definePage({
    path: '/customs/declarations/new', domain: 'customs', title: 'New declaration', kind: 'form',
    view: (ctx) => ({
      title: 'New declaration',
      breadcrumbs: [{ label: 'Customs', href: '/customs' }, { label: 'Declarations', href: '/customs/declarations' }, { label: 'New' }],
      body: `<div class="panel" style="max-width:620px">
<form method="post" action="/customs/declarations/new" data-testid="new-declaration-form">
${csrfField(ctx)}
${field({ name: 'shipmentId', label: 'Shipment', required: true, testId: 'dec-shipment',
  options: [{ value: '', label: 'Choose a shipment' }, ...state.shipments.slice(0, 30).map(s => ({ value: s.id, label: `${s.reference} — ${s.destination.city}` }))] })}
${field({ name: 'direction', label: 'Direction', required: true, testId: 'dec-direction', options: ['import', 'export'] })}
${field({ name: 'procedureCode', label: 'Procedure code', required: true, testId: 'dec-procedure',
  attrs: { maxlength: '4', pattern: '[0-9]{4}' }, hint: 'Four digits, for example 4000.' })}
${field({ name: 'hsCode', label: 'Commodity code', required: true, testId: 'dec-hs-code',
  options: [{ value: '', label: 'Choose a commodity code' }, ...state.HS_CODES.map(c => ({ value: c.code, label: `${c.code} — ${c.description}` }))] })}
${field({ name: 'countryOfOrigin', label: 'Country of origin', required: true, testId: 'dec-origin',
  options: state.COUNTRIES.map(c => ({ value: c.code, label: c.name })) })}
${field({ name: 'declaredValueGbp', label: 'Declared value (GBP)', type: 'number', required: true, testId: 'dec-value',
  attrs: { min: '0.01', max: '10000000', step: '0.01' } })}
${field({ name: 'goodsDescription', label: 'Description of goods', type: 'textarea', required: true, testId: 'dec-description',
  attrs: { maxlength: '500' }, hint: 'Plain description. A commodity code alone is not enough.' })}
<button class="btn" type="submit" data-testid="dec-submit">Create declaration</button>
</form></div>`
    })
  });

  app.post('/customs/declarations/new', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const body = await ctx.body();
    if (!await csrfValid(ctx)) { setFlash(ctx, 'error', 'That form expired.'); return ctx.redirect('/customs/declarations/new'); }
    if (!can(user, 'customs:write')) {
      setFlash(ctx, 'error', 'You do not have permission to create declarations.');
      return ctx.redirect('/customs/declarations');
    }
    const value = Number(body.declaredValueGbp);
    const code = state.HS_CODES.find(c => c.code === body.hsCode);
    if (!code || !Number.isFinite(value) || value <= 0) {
      setFlash(ctx, 'error', 'A commodity code and a declared value above zero are required.');
      return ctx.redirect('/customs/declarations/new');
    }
    if (!/^[0-9]{4}$/.test(String(body.procedureCode ?? ''))) {
      setFlash(ctx, 'error', 'The procedure code must be four digits.');
      return ctx.redirect('/customs/declarations/new');
    }
    const index = state.declarations.length;
    const created = {
      id: `dec-${String(index + 1).padStart(4, '0')}`,
      reference: `DEC-2026-${String(9000 + index)}`,
      shipmentId: String(body.shipmentId), direction: String(body.direction),
      status: 'draft', procedureCode: String(body.procedureCode), hsCode: code.code,
      goodsDescription: String(body.goodsDescription), countryOfOrigin: String(body.countryOfOrigin),
      declaredValueGbp: value, dutyRatePct: code.dutyPct,
      dutyGbp: Math.round(value * (code.dutyPct / 100) * 100) / 100,
      vatGbp: Math.round(value * 0.2 * 100) / 100,
      controlled: Boolean(code.controlled), excise: Boolean(code.excise),
      submittedAt: null, holdReason: null, documents: []
    };
    state.declarations.push(created);
    setFlash(ctx, 'success', `Declaration ${created.reference} created as a draft.`);
    return ctx.redirect(`/customs/declarations/${created.id}`);
  });

  definePage({
    path: '/customs/declarations/:id', domain: 'customs', title: 'Declaration', kind: 'detail',
    view: (ctx, user) => {
      const declaration = find(ctx.params.id);
      if (!declaration) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty" data-testid="not-found">No such declaration.</div></div>' };
      const linked = shipment(declaration.shipmentId);
      const duty = dutyFor(declaration);
      const releasable = ['held', 'accepted', 'submitted'].includes(declaration.status);
      return {
        title: `Declaration ${declaration.reference}`,
        breadcrumbs: [{ label: 'Customs', href: '/customs' }, { label: 'Declarations', href: '/customs/declarations' }, { label: declaration.reference }],
        actions: `<a class="btn btn-secondary" href="/customs/declarations/${h(declaration.id)}/documents" data-testid="view-documents">Documents</a>
${can(user, 'customs:release') && releasable
  ? `<a class="btn" href="/customs/declarations/${h(declaration.id)}/release" data-testid="release-declaration">Release</a>` : ''}`,
        body: `<div class="grid grid-4" style="margin-bottom:14px">
${stat(statusPill(declaration.status), 'Status', 'dec-status')}
${stat(money(declaration.declaredValueGbp), 'Declared value', 'dec-declared-value')}
${stat(money(duty.duty), `Duty at ${declaration.dutyRatePct}%`, 'dec-duty')}
${stat(money(declaration.vatGbp), 'VAT', 'dec-vat')}
</div>
${declaration.holdReason ? `<div class="flash flash-warn" role="status" data-testid="hold-reason">Held: ${h(declaration.holdReason)}</div>` : ''}
${tabs('declaration', [
  { key: 'summary', label: 'Summary', body: `<div class="grid grid-2">
<div class="panel"><h3 style="margin-top:0">Declaration</h3>${kv([
  ['Reference', `<code>${h(declaration.reference)}</code>`],
  ['Direction', h(declaration.direction)],
  ['Procedure code', `<code>${h(declaration.procedureCode)}</code>`],
  ['Commodity code', `<code>${h(declaration.hsCode)}</code>`],
  ['Goods', h(declaration.goodsDescription)],
  ['Country of origin', h(declaration.countryOfOrigin)],
  ['Shipment', linked ? `<a href="/shipments/${h(linked.id)}">${h(linked.reference)}</a>` : '—'],
  ['Incoterm', linked ? `<code>${h(linked.incoterm)}</code>` : '—'],
  ['Submitted', dateTime(declaration.submittedAt)]
])}</div>
<div class="panel"><h3 style="margin-top:0">Value for duty</h3>${kv([
  ['Goods value', money(declaration.declaredValueGbp)],
  ['Freight cost', money(duty.freight)],
  ['Incoterm includes freight', duty.includesFreight ? 'Yes' : 'No'],
  ['Value for duty', `<span data-testid="duty-basis">${money(duty.basis)}</span>`],
  ['Duty rate', `${declaration.dutyRatePct}%`],
  ['Duty', `<strong>${money(duty.duty)}</strong>`],
  ['VAT', money(declaration.vatGbp)]
])}
<p class="hint" style="margin-top:10px">On delivered terms the value for duty includes cost, insurance and freight.</p>
</div></div>` },
  { key: 'flags', label: 'Flags', body: `<div class="panel">${kv([
    ['Controlled goods', declaration.controlled ? '<span class="pill pill-danger">Yes — licence required</span>' : 'No'],
    ['Excise goods', declaration.excise ? '<span class="pill pill-warn">Yes — excise duty applies</span>' : 'No'],
    ['Hold reason', h(declaration.holdReason ?? '—')]
  ])}</div>` },
  { key: 'documents', label: `Documents (${declaration.documents.length})`, body: `<div class="panel">${table({
    caption: 'Documents attached to this declaration', testId: 'dec-documents', empty: 'No documents attached.',
    columns: [
      { header: 'Type', cell: row => h(row.type) },
      { header: 'Filename', cell: row => h(row.filename) },
      { header: 'Size', cell: row => `${row.sizeKb} KB` },
      { header: 'Uploaded', cell: row => dateTime(row.uploadedAt) }
    ],
    rows: declaration.documents
  })}</div>` }
])}`
      };
    }
  });

  definePage({
    path: '/customs/declarations/:id/documents', domain: 'customs', title: 'Declaration documents', kind: 'list',
    view: (ctx) => {
      const declaration = find(ctx.params.id);
      if (!declaration) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Documents — ${declaration.reference}`,
        breadcrumbs: [{ label: 'Customs', href: '/customs' }, { label: declaration.reference, href: `/customs/declarations/${declaration.id}` }, { label: 'Documents' }],
        body: `<div class="panel">
${table({
  caption: 'Documents on this declaration', testId: 'declaration-documents-table', empty: 'No documents attached.',
  columns: [
    { header: 'Type', cell: row => h(row.type) },
    { header: 'Filename', cell: row => h(row.filename) },
    { header: 'Size', cell: row => `${row.sizeKb} KB` },
    { header: 'Uploaded', cell: row => dateTime(row.uploadedAt) }
  ],
  rows: declaration.documents
})}
<h3>Attach a document</h3>
<form method="post" action="/customs/declarations/${h(declaration.id)}/documents" enctype="multipart/form-data" data-testid="declaration-upload-form">
${csrfField(ctx)}
${field({ name: 'documentType', label: 'Document type', required: true, testId: 'dec-doc-type',
  options: ['commercialInvoice', 'packingList', 'certificateOfOrigin', 'importLicence', 'airWaybill', 'billOfLading'] })}
${field({ name: 'file', label: 'File', type: 'file', required: true, testId: 'dec-doc-file',
  attrs: { accept: '.pdf,.jpg,.png' }, hint: 'PDF, JPG or PNG, up to 5 MB.' })}
<button class="btn" type="submit" data-testid="dec-doc-upload">Attach</button>
</form></div>`
      };
    }
  });

  app.post('/customs/declarations/:id/documents', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const declaration = find(ctx.params.id);
    if (!declaration) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();
    declaration.documents.push({
      id: `doc-${declaration.id}-${declaration.documents.length + 1}`,
      type: String(body.documentType ?? 'other'),
      filename: `${String(body.documentType ?? 'document')}-${declaration.documents.length + 1}.pdf`,
      uploadedAt: new Date().toISOString(), sizeKb: 240
    });
    setFlash(ctx, 'success', 'Document attached.');
    return ctx.redirect(`/customs/declarations/${declaration.id}/documents`);
  });

  // ---- release ------------------------------------------------------------

  definePage({
    path: '/customs/declarations/:id/release', domain: 'customs', title: 'Release a declaration', kind: 'form',
    permission: 'customs:release',
    view: (ctx) => {
      const declaration = find(ctx.params.id);
      if (!declaration) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Release ${declaration.reference}`,
        breadcrumbs: [{ label: 'Customs', href: '/customs' }, { label: declaration.reference, href: `/customs/declarations/${declaration.id}` }, { label: 'Release' }],
        body: `<div class="panel" style="max-width:560px">
${declaration.status === 'rejected'
  ? '<div class="flash flash-error" role="alert" data-testid="rejected-warning">This declaration was rejected by customs. It cannot be released until it is corrected and resubmitted.</div>'
  : ''}
${declaration.controlled ? '<div class="flash flash-warn" role="status">These are controlled goods. A valid import licence must be on file.</div>' : ''}
<p class="hint">Releasing lets the consignment travel. Current status: ${statusPill(declaration.status)}</p>
<form method="post" action="/customs/declarations/${h(declaration.id)}/release" data-testid="release-form">
${csrfField(ctx)}
${field({ name: 'reference', label: 'Customs clearance reference', required: true, testId: 'release-reference',
  attrs: { maxlength: '30' }, hint: 'The reference the customs authority returned.' })}
${field({ name: 'note', label: 'Note', type: 'textarea', testId: 'release-note', attrs: { maxlength: '400' } })}
<button class="btn" type="submit" data-testid="release-submit">Release consignment</button>
<a class="btn btn-secondary" href="/customs/declarations/${h(declaration.id)}">Cancel</a>
</form></div>`
      };
    }
  });

  app.post('/customs/declarations/:id/release', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const declaration = find(ctx.params.id);
    if (!declaration) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();

    if (!can(user, 'customs:release')) {
      setFlash(ctx, 'error', 'You do not have permission to release declarations.');
      return ctx.redirect(`/customs/declarations/${declaration.id}`);
    }
    if (!String(body.reference ?? '').trim()) {
      setFlash(ctx, 'error', 'A customs clearance reference is required.');
      return ctx.redirect(`/customs/declarations/${declaration.id}/release`);
    }

    // FP_D17 — with the defect off, a rejected declaration cannot be released. With it on
    // the handler never looks at the current status, so goods customs refused can travel.
    if (!faults.on('FP_D17_RELEASE_REJECTED_DECLARATION') && declaration.status === 'rejected') {
      setFlash(ctx, 'error', 'A rejected declaration cannot be released. Correct it and resubmit.');
      return ctx.redirect(`/customs/declarations/${declaration.id}`);
    }

    declaration.status = 'released';
    declaration.holdReason = null;
    const linked = shipment(declaration.shipmentId);
    if (linked && linked.status === 'customsHold') {
      linked.status = 'inTransit';
      linked.events.push({ at: new Date().toISOString(), code: 'CUSTOMS_RELEASED', description: 'Released by customs', location: 'Border' });
    }
    setFlash(ctx, 'success', `${declaration.reference} released.`);
    return ctx.redirect(`/customs/declarations/${declaration.id}`);
  });

  // ---- holds, codes, duties, compliance -----------------------------------

  definePage({
    path: '/customs/holds', domain: 'customs', title: 'Customs holds', kind: 'list',
    view: () => {
      const rows = state.declarations.filter(d => d.status === 'held');
      return {
        title: 'Customs holds',
        breadcrumbs: [{ label: 'Customs', href: '/customs' }, { label: 'Holds' }],
        body: `<div class="panel">${table({
          caption: 'Declarations currently held', testId: 'holds-table', empty: 'Nothing is held.',
          columns: [
            { header: 'Declaration', cell: row => `<a href="/customs/declarations/${h(row.id)}">${h(row.reference)}</a>` },
            { header: 'Shipment', cell: row => {
                const linked = shipment(row.shipmentId);
                return linked ? `<a href="/shipments/${h(linked.id)}">${h(linked.reference)}</a>` : '—';
              } },
            { header: 'Reason', cell: row => h(row.holdReason ?? '—') },
            { header: 'Value', cell: row => money(row.declaredValueGbp) },
            { header: 'Submitted', cell: row => dateTime(row.submittedAt) },
            { header: '', cell: row => `<a class="btn btn-secondary" href="/customs/declarations/${h(row.id)}/documents">Documents</a>` }
          ],
          rows
        })}</div>`
      };
    }
  });

  definePage({
    path: '/customs/hs-codes', domain: 'customs', title: 'Commodity codes', kind: 'list',
    view: (ctx) => {
      const q = String(ctx.query.q ?? '');
      const rows = q
        ? state.HS_CODES.filter(c => c.code.includes(q) || c.description.toLowerCase().includes(q.toLowerCase()))
        : state.HS_CODES;
      return {
        title: 'Commodity codes',
        breadcrumbs: [{ label: 'Customs', href: '/customs' }, { label: 'Commodity codes' }],
        body: `<form method="get" action="/customs/hs-codes" class="filters" data-testid="hs-search-form">
${field({ name: 'q', label: 'Search', type: 'search', value: q, testId: 'hs-search', hint: 'Code or description.' })}
<button class="btn" type="submit" data-testid="hs-apply">Search</button></form>
${table({
  caption: 'Commodity codes in use', testId: 'hs-codes-table', empty: 'No commodity code matches.',
  columns: [
    { header: 'Code', cell: row => `<code>${h(row.code)}</code>` },
    { header: 'Description', cell: row => h(row.description) },
    { header: 'Duty rate', cell: row => `${row.dutyPct}%` },
    { header: 'Flags', cell: row => [
        row.controlled ? '<span class="pill pill-danger">Controlled</span>' : '',
        row.excise ? '<span class="pill pill-warn">Excise</span>' : '',
        row.perishable ? '<span class="pill pill-info">Perishable</span>' : '',
        row.highValue ? '<span class="pill pill-warn">High value</span>' : ''
      ].filter(Boolean).join(' ') || '—' },
    { header: 'Used on', cell: row => String(state.declarations.filter(d => d.hsCode === row.code).length) }
  ],
  rows
})}`
      };
    }
  });

  definePage({
    path: '/customs/duties', domain: 'customs', title: 'Duty and VAT rates', kind: 'report',
    view: () => ({
      title: 'Duty and VAT rates',
      breadcrumbs: [{ label: 'Customs', href: '/customs' }, { label: 'Duty and VAT' }],
      body: `<div class="panel">
<p class="hint">Duty is charged on the value for duty, which on delivered terms includes freight.</p>
${table({
  caption: 'Duty payable by declaration', testId: 'duties-table',
  columns: [
    { header: 'Declaration', cell: row => `<a href="/customs/declarations/${h(row.id)}">${h(row.reference)}</a>` },
    { header: 'Commodity', cell: row => `<code>${h(row.hsCode)}</code>` },
    { header: 'Goods value', cell: row => money(row.declaredValueGbp) },
    { header: 'Freight', cell: row => money(dutyFor(row).freight) },
    { header: 'Value for duty', cell: row => money(dutyFor(row).basis) },
    { header: 'Rate', cell: row => `${row.dutyRatePct}%` },
    { header: 'Duty', cell: row => money(dutyFor(row).duty) },
    { header: 'VAT', cell: row => money(row.vatGbp) }
  ],
  rows: state.declarations.slice(0, 20)
})}</div>`
    })
  });

  definePage({
    path: '/customs/compliance', domain: 'customs', title: 'Compliance checks', kind: 'report',
    view: () => {
      const controlled = state.declarations.filter(d => d.controlled);
      const missingDocs = state.declarations.filter(d => d.documents.length < 2);
      const released = state.declarations.filter(d => d.status === 'released');
      return {
        title: 'Compliance checks',
        breadcrumbs: [{ label: 'Customs', href: '/customs' }, { label: 'Compliance' }],
        body: `<div class="grid grid-3" style="margin-bottom:16px">
${stat(String(controlled.length), 'Controlled goods declarations', 'compliance-controlled')}
${stat(String(missingDocs.length), 'With fewer than two documents', 'compliance-missing-docs')}
${stat(String(released.length), 'Released', 'compliance-released')}
</div>
<div class="panel"><h2 style="margin-top:0">Controlled goods</h2>
<p class="hint">Each of these needs a valid import licence on file before release.</p>
${table({
  caption: 'Declarations covering controlled goods', testId: 'compliance-table', empty: 'No controlled goods declared.',
  columns: [
    { header: 'Declaration', cell: row => `<a href="/customs/declarations/${h(row.id)}">${h(row.reference)}</a>` },
    { header: 'Commodity', cell: row => `<code>${h(row.hsCode)}</code>` },
    { header: 'Goods', cell: row => h(row.goodsDescription) },
    { header: 'Documents', cell: row => String(row.documents.length) },
    { header: 'Licence on file', cell: row => row.documents.some(d => d.type === 'importLicence')
      ? '<span class="pill pill-ok">Yes</span>' : '<span class="pill pill-danger">No</span>' },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: controlled
})}</div>`
      };
    }
  });
}
