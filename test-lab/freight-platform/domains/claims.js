/**
 * Claims: damage, loss, delay and shortage, through to settlement.
 *
 * **Routed domain.** No anchor leads here.
 *
 *   FP_D11  settlement is hidden from a viewer but not refused by the handler
 *   FP_D19  an oversize evidence upload crashes instead of being refused
 *   FP_D22  claim form errors are not associated with their fields
 */
import { h, table, field, statusPill, shortDate, dateTime, money, kv, tabs, stat } from '../ui/chrome.js';

export const SCREENS = [
  { path: '/claims', title: 'Claims', kind: 'list' },
  { path: '/claims/new', title: 'Raise a claim', kind: 'form' },
  { path: '/claims/open', title: 'Open claims', kind: 'list' },
  { path: '/claims/analysis', title: 'Claims analysis', kind: 'report' },
  { path: '/claims/:id', title: 'Claim', kind: 'detail' },
  { path: '/claims/:id/investigate', title: 'Investigate a claim', kind: 'form' },
  { path: '/claims/:id/evidence', title: 'Claim evidence', kind: 'form' },
  { path: '/claims/:id/settle', title: 'Settle a claim', kind: 'form' }
];

export default function registerClaims({ app, core, state, faults }) {
  const { definePage, csrfField, csrfValid, setFlash, can } = core;

  const customer = id => state.customers.find(c => c.id === id);
  const carrier = id => state.carriers.find(c => c.id === id);
  const shipment = id => state.shipments.find(s => s.id === id);
  const user = id => state.users.find(u => u.id === id);
  const find = id => state.claims.find(c => c.id === id || c.reference === id);

  for (const screen of SCREENS) {
    if (screen.path.includes(':id')) screen.sample = screen.path.replace(':id', state.claims[0].id);
  }

  definePage({
    path: '/claims', domain: 'claims', title: 'Claims', kind: 'list',
    view: (ctx) => {
      const status = String(ctx.query.status ?? '');
      const rows = status ? state.claims.filter(c => c.status === status) : state.claims;
      const open = state.claims.filter(c => !['settled', 'rejected'].includes(c.status));
      return {
        title: 'Claims',
        actions: `<button class="btn" type="button" data-route="/claims/new" data-testid="new-claim">Raise a claim</button>
<button class="btn btn-secondary" type="button" data-route="/claims/analysis" data-testid="claims-analysis">Analysis</button>`,
        body: `<div class="grid grid-4" style="margin-bottom:16px">
${stat(String(state.claims.length), 'Claims on record', 'stat-claims')}
${stat(String(open.length), 'Open', 'stat-claims-open')}
${stat(money(open.reduce((s, c) => s + c.claimedAmountGbp, 0)), 'Claimed and unresolved', 'stat-claims-value')}
${stat(money(state.claims.reduce((s, c) => s + (c.settledAmountGbp ?? 0), 0)), 'Settled to date', 'stat-claims-settled')}
</div>
${table({
  caption: 'Claims raised against shipments', testId: 'claims-table', empty: 'No claims match.',
  columns: [
    { header: 'Reference', cell: row => `<button type="button" class="btn btn-secondary" style="padding:2px 8px"
        data-route="/claims/${h(row.id)}" data-testid="open-claim-${h(row.id)}">${h(row.reference)}</button>` },
    { header: 'Type', cell: row => h(row.type) },
    { header: 'Shipment', cell: row => {
        const linked = shipment(row.shipmentId);
        return linked ? `<a href="/shipments/${h(linked.id)}">${h(linked.reference)}</a>` : '—';
      } },
    { header: 'Customer', cell: row => h(customer(row.customerId)?.name ?? '—') },
    { header: 'Carrier', cell: row => h(carrier(row.carrierId)?.name ?? '—') },
    { header: 'Claimed', cell: row => money(row.claimedAmountGbp) },
    { header: 'Settled', cell: row => row.settledAmountGbp === null ? '—' : money(row.settledAmountGbp) },
    { header: 'Raised', cell: row => shortDate(row.raisedAt) },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows
})}`
      };
    }
  });

  definePage({
    path: '/claims/open', domain: 'claims', title: 'Open claims', kind: 'list',
    view: () => {
      const rows = state.claims.filter(c => !['settled', 'rejected'].includes(c.status));
      return {
        title: 'Open claims',
        breadcrumbs: [{ label: 'Claims', href: '/claims' }, { label: 'Open' }],
        body: `<div class="panel">${table({
          caption: 'Claims that have not been settled or rejected', testId: 'open-claims-table', empty: 'No open claims.',
          columns: [
            { header: 'Reference', cell: row => `<button type="button" class="btn btn-secondary" style="padding:2px 8px"
                data-route="/claims/${h(row.id)}" data-testid="open-list-${h(row.id)}">${h(row.reference)}</button>` },
            { header: 'Type', cell: row => h(row.type) },
            { header: 'Claimed', cell: row => money(row.claimedAmountGbp) },
            { header: 'Assigned to', cell: row => h(user(row.assignedToUserId)?.displayName ?? '—') },
            { header: 'Carrier liable', cell: row => row.carrierLiable
              ? '<span class="pill pill-warn">Yes</span>' : '<span class="pill pill-muted">Not determined</span>' },
            { header: 'Evidence', cell: row => String(row.evidence.length) },
            { header: 'Raised', cell: row => shortDate(row.raisedAt) },
            { header: 'Status', cell: row => statusPill(row.status) }
          ],
          rows
        })}</div>`
      };
    }
  });

  // ---- raise --------------------------------------------------------------

  /** Validation errors held between a failed post and the re-render. */
  const claimErrors = new Map();

  definePage({
    path: '/claims/new', domain: 'claims', title: 'Raise a claim', kind: 'form',
    view: (ctx) => {
      const key = ctx.cookies.lab_session ?? 'anonymous';
      const errors = claimErrors.get(key) ?? {};
      claimErrors.delete(key);
      const preselected = String(ctx.query.shipment ?? '');
      const unassociated = faults.on('FP_D22_ERROR_NOT_ASSOCIATED');

      // FP_D22 — the messages are rendered as a plain block above the form, with no
      // aria-describedby on the inputs and no role="alert", so they are neither announced
      // nor reachable from the field they describe.
      const errorBlock = (unassociated && Object.keys(errors).length)
        ? `<div style="color:var(--danger);font-size:13px;margin-bottom:12px" data-testid="claim-errors">
${Object.values(errors).map(message => `<div>${h(message)}</div>`).join('')}</div>`
        : '';

      const fieldFor = (spec) => unassociated
        ? field({ ...spec, error: '' })
        : field({ ...spec, error: errors[spec.name] ?? '' });

      return {
        title: 'Raise a claim',
        breadcrumbs: [{ label: 'Claims', href: '/claims' }, { label: 'New' }],
        body: `<div class="panel" style="max-width:620px">
${errorBlock}
<form method="post" action="/claims/new" data-testid="new-claim-form">
${csrfField(ctx)}
${fieldFor({ name: 'shipmentId', label: 'Shipment', required: true, value: preselected, testId: 'claim-shipment',
  options: [{ value: '', label: 'Choose a shipment' }, ...state.shipments.slice(0, 40).map(s => ({ value: s.id, label: `${s.reference} — ${s.destination.city}` }))] })}
${fieldFor({ name: 'type', label: 'Claim type', required: true, testId: 'claim-type',
  options: [{ value: '', label: 'Choose a type' }, 'damage', 'loss', 'delay', 'shortage'] })}
${fieldFor({ name: 'claimedAmountGbp', label: 'Amount claimed (GBP)', type: 'number', required: true, testId: 'claim-amount',
  attrs: { min: '0.01', max: '1000000', step: '0.01' },
  hint: 'Cannot exceed the declared value of the consignment.' })}
${fieldFor({ name: 'description', label: 'What happened', type: 'textarea', required: true, testId: 'claim-description',
  attrs: { maxlength: '1000', minlength: '20' }, rows: 4, hint: 'At least 20 characters. The carrier reads this.' })}
${fieldFor({ name: 'incidentDate', label: 'Date of the incident', type: 'date', required: true, testId: 'claim-incident-date' })}
<button class="btn" type="submit" data-testid="claim-submit">Raise claim</button>
</form></div>`
      };
    }
  });

  app.post('/claims/new', async (ctx) => {
    const signedIn = core.requireAuth(ctx);
    if (!signedIn) return;
    const body = await ctx.body();
    const key = ctx.cookies.lab_session ?? 'anonymous';

    if (!await csrfValid(ctx)) { setFlash(ctx, 'error', 'That form expired.'); return ctx.redirect('/claims/new'); }

    const errors = {};
    const linked = shipment(String(body.shipmentId ?? ''));
    const amount = Number(body.claimedAmountGbp);
    const description = String(body.description ?? '').trim();

    if (!linked) errors.shipmentId = 'Choose the shipment this claim is about.';
    if (!body.type) errors.type = 'Choose a claim type.';
    if (!Number.isFinite(amount) || amount <= 0) errors.claimedAmountGbp = 'Enter an amount above zero.';
    else if (linked && amount > linked.declaredValueGbp) {
      errors.claimedAmountGbp = `The claim cannot exceed the declared value of ${money(linked.declaredValueGbp)}.`;
    }
    if (description.length < 20) errors.description = 'Describe what happened in at least 20 characters.';
    if (!body.incidentDate) errors.incidentDate = 'Enter the date of the incident.';

    if (Object.keys(errors).length) {
      claimErrors.set(key, errors);
      return ctx.redirect(`/claims/new${body.shipmentId ? `?shipment=${body.shipmentId}` : ''}`);
    }

    const index = state.claims.length;
    const created = {
      id: `clm-${String(index + 1).padStart(4, '0')}`,
      reference: `CL-2026-${String(400 + index)}`,
      shipmentId: linked.id, customerId: linked.customerId, carrierId: linked.carrierId,
      type: String(body.type), status: 'submitted', claimedAmountGbp: amount, settledAmountGbp: null,
      raisedAt: new Date().toISOString(), raisedByUserId: signedIn.id,
      assignedToUserId: signedIn.id, carrierLiable: false,
      description, evidence: []
    };
    state.claims.push(created);
    setFlash(ctx, 'success', `Claim ${created.reference} raised.`);
    return ctx.redirect(`/claims/${created.id}`);
  });

  // ---- detail -------------------------------------------------------------

  definePage({
    path: '/claims/:id', domain: 'claims', title: 'Claim', kind: 'detail',
    view: (ctx, signedIn) => {
      const claim = find(ctx.params.id);
      if (!claim) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty" data-testid="not-found">No such claim.</div></div>' };
      const linked = shipment(claim.shipmentId);
      const settleable = !['settled', 'rejected'].includes(claim.status);
      const maySettle = can(signedIn, 'claim:settle');
      return {
        title: `Claim ${claim.reference}`,
        breadcrumbs: [{ label: 'Claims', href: '/claims' }, { label: claim.reference }],
        actions: `<button class="btn btn-secondary" type="button" data-route="/claims/${h(claim.id)}/evidence" data-testid="view-evidence">Evidence</button>
<button class="btn btn-secondary" type="button" data-route="/claims/${h(claim.id)}/investigate" data-testid="investigate-claim">Investigate</button>
${settleable && maySettle
  ? `<button class="btn" type="button" data-route="/claims/${h(claim.id)}/settle" data-testid="settle-claim">Settle</button>` : ''}`,
        body: `<div class="grid grid-4" style="margin-bottom:14px">
${stat(statusPill(claim.status), 'Status', 'claim-status')}
${stat(money(claim.claimedAmountGbp), 'Claimed', 'claim-claimed')}
${stat(claim.settledAmountGbp === null ? '—' : money(claim.settledAmountGbp), 'Settled', 'claim-settled')}
${stat(String(claim.evidence.length), 'Evidence items', 'claim-evidence-count')}
</div>
${tabs('claim', [
  { key: 'summary', label: 'Summary', body: `<div class="grid grid-2">
<div class="panel"><h3 style="margin-top:0">Claim</h3>${kv([
  ['Reference', `<code>${h(claim.reference)}</code>`],
  ['Type', h(claim.type)],
  ['Shipment', linked ? `<a href="/shipments/${h(linked.id)}">${h(linked.reference)}</a>` : '—'],
  ['Declared value', linked ? money(linked.declaredValueGbp) : '—'],
  ['Customer', h(customer(claim.customerId)?.name ?? '—')],
  ['Carrier', h(carrier(claim.carrierId)?.name ?? '—')],
  ['Carrier liable', claim.carrierLiable ? 'Yes' : 'Not determined'],
  ['Raised by', h(user(claim.raisedByUserId)?.displayName ?? '—')],
  ['Assigned to', h(user(claim.assignedToUserId)?.displayName ?? '—')],
  ['Raised', dateTime(claim.raisedAt)]
])}</div>
<div class="panel"><h3 style="margin-top:0">What happened</h3><p>${h(claim.description)}</p>
${!maySettle ? '<p class="hint" data-testid="settle-hidden">Settling a claim needs the claim:settle permission, which your role does not hold.</p>' : ''}
</div></div>` },
  { key: 'evidence', label: `Evidence (${claim.evidence.length})`, body: `<div class="panel">${table({
    caption: 'Evidence attached to this claim', testId: 'claim-evidence-table', empty: 'No evidence attached.',
    columns: [
      { header: 'Type', cell: row => h(row.type) },
      { header: 'Filename', cell: row => h(row.filename) },
      { header: 'Size', cell: row => `${row.sizeKb} KB` },
      { header: 'Uploaded', cell: row => dateTime(row.uploadedAt) }
    ],
    rows: claim.evidence
  })}</div>` }
])}`
      };
    }
  });

  definePage({
    path: '/claims/:id/investigate', domain: 'claims', title: 'Investigate a claim', kind: 'form',
    view: (ctx) => {
      const claim = find(ctx.params.id);
      if (!claim) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Investigate ${claim.reference}`,
        breadcrumbs: [{ label: 'Claims', href: '/claims' }, { label: claim.reference }, { label: 'Investigate' }],
        body: `<div class="panel" style="max-width:580px">
<form method="post" action="/claims/${h(claim.id)}/investigate" data-testid="investigate-form">
${csrfField(ctx)}
${field({ name: 'status', label: 'Move to', required: true, value: claim.status, testId: 'investigate-status',
  options: ['investigating', 'awaitingEvidence', 'approved', 'rejected'] })}
${field({ name: 'assignedToUserId', label: 'Assign to', required: true, value: claim.assignedToUserId, testId: 'investigate-assignee',
  options: state.users.filter(u => u.status === 'active').map(u => ({ value: u.id, label: u.displayName })) })}
${field({ name: 'carrierLiable', label: 'The carrier is liable', type: 'checkbox', value: claim.carrierLiable, testId: 'investigate-liable' })}
${field({ name: 'findings', label: 'Findings', type: 'textarea', required: true, testId: 'investigate-findings',
  attrs: { maxlength: '1000', minlength: '10' }, rows: 4 })}
<button class="btn" type="submit" data-testid="investigate-submit">Record findings</button>
</form></div>`
      };
    }
  });

  app.post('/claims/:id/investigate', async (ctx) => {
    const signedIn = core.requireAuth(ctx);
    if (!signedIn) return;
    const claim = find(ctx.params.id);
    if (!claim) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();
    if (!can(signedIn, 'claim:write')) {
      setFlash(ctx, 'error', 'You do not have permission to investigate claims.');
      return ctx.redirect(`/claims/${claim.id}`);
    }
    if (String(body.findings ?? '').trim().length < 10) {
      setFlash(ctx, 'error', 'Record findings of at least 10 characters.');
      return ctx.redirect(`/claims/${claim.id}/investigate`);
    }
    claim.status = String(body.status);
    claim.assignedToUserId = String(body.assignedToUserId);
    claim.carrierLiable = body.carrierLiable === 'on';
    setFlash(ctx, 'success', 'Findings recorded.');
    return ctx.redirect(`/claims/${claim.id}`);
  });

  // ---- evidence -----------------------------------------------------------

  definePage({
    path: '/claims/:id/evidence', domain: 'claims', title: 'Claim evidence', kind: 'form',
    view: (ctx) => {
      const claim = find(ctx.params.id);
      if (!claim) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Evidence — ${claim.reference}`,
        breadcrumbs: [{ label: 'Claims', href: '/claims' }, { label: claim.reference }, { label: 'Evidence' }],
        body: `<div class="panel">
${table({
  caption: 'Evidence attached to this claim', testId: 'evidence-table', empty: 'No evidence attached yet.',
  columns: [
    { header: 'Type', cell: row => h(row.type) },
    { header: 'Filename', cell: row => h(row.filename) },
    { header: 'Size', cell: row => `${row.sizeKb} KB` },
    { header: 'Uploaded', cell: row => dateTime(row.uploadedAt) }
  ],
  rows: claim.evidence
})}
<h3>Attach evidence</h3>
<form method="post" action="/claims/${h(claim.id)}/evidence" enctype="multipart/form-data" data-testid="evidence-form">
${csrfField(ctx)}
${field({ name: 'evidenceType', label: 'Evidence type', required: true, testId: 'evidence-type',
  options: ['photograph', 'pod', 'packingList', 'temperatureLog', 'repairQuote', 'correspondence'] })}
${field({ name: 'file', label: 'File', type: 'file', required: true, testId: 'evidence-file',
  attrs: { accept: '.pdf,.jpg,.jpeg,.png,.csv' }, hint: 'PDF, JPG, PNG or CSV, up to 5 MB.' })}
${field({ name: 'note', label: 'Note', type: 'textarea', testId: 'evidence-note', attrs: { maxlength: '300' } })}
<button class="btn" type="submit" data-testid="evidence-upload">Attach evidence</button>
</form></div>`
      };
    }
  });

  app.post('/claims/:id/evidence', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const claim = find(ctx.params.id);
    if (!claim) return ctx.json(404, { error: 'not_found' });

    const body = await ctx.body();
    const declaredSizeKb = Number(body.sizeKb ?? 240);

    // FP_D19 — the stated limit is 5 MB. With the defect off, anything larger is refused
    // with a field error. With it on the handler throws, and the operator gets a 500
    // instead of being told the file is too big.
    if (declaredSizeKb > 5120) {
      if (faults.on('FP_D19_OVERSIZE_UPLOAD_CRASHES')) {
        throw new Error(`Evidence buffer of ${declaredSizeKb}KB exceeded the allocation at /home/user/AIRA/test-lab/freight-platform/domains/claims.js`);
      }
      setFlash(ctx, 'error', 'That file is larger than 5 MB. Compress it or attach it in parts.');
      return ctx.redirect(`/claims/${claim.id}/evidence`);
    }

    claim.evidence.push({
      id: `ev-${claim.id}-${claim.evidence.length + 1}`,
      type: String(body.evidenceType ?? 'photograph'),
      filename: `${String(body.evidenceType ?? 'evidence')}-${claim.evidence.length + 1}.pdf`,
      uploadedAt: new Date().toISOString(), sizeKb: declaredSizeKb
    });
    if (claim.status === 'awaitingEvidence') claim.status = 'investigating';
    setFlash(ctx, 'success', 'Evidence attached.');
    return ctx.redirect(`/claims/${claim.id}/evidence`);
  });

  // ---- settle -------------------------------------------------------------

  definePage({
    path: '/claims/:id/settle', domain: 'claims', title: 'Settle a claim', kind: 'form',
    permission: 'claim:settle',
    view: (ctx, signedIn) => {
      const claim = find(ctx.params.id);
      if (!claim) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      // The screen is honest about the permission; the handler is where FP_D11 lives.
      if (!can(signedIn, 'claim:settle')) {
        return {
          status: 403, title: 'Not available',
          body: `<div class="panel"><div class="empty" data-testid="settle-forbidden">
Settling a claim needs the claim:settle permission. Your role (${h(signedIn.role)}) does not hold it.</div></div>`
        };
      }
      return {
        title: `Settle ${claim.reference}`,
        breadcrumbs: [{ label: 'Claims', href: '/claims' }, { label: claim.reference }, { label: 'Settle' }],
        body: `<div class="panel" style="max-width:560px">
<p class="hint">Claimed ${money(claim.claimedAmountGbp)}. A settlement raises a credit note against the customer's account.</p>
<form method="post" action="/claims/${h(claim.id)}/settle" data-testid="settle-form">
${csrfField(ctx)}
${field({ name: 'settledAmountGbp', label: 'Settlement amount (GBP)', type: 'number', required: true,
  value: claim.claimedAmountGbp, testId: 'settle-amount',
  attrs: { min: '0', max: String(claim.claimedAmountGbp), step: '0.01' },
  hint: 'Cannot exceed the amount claimed.' })}
${field({ name: 'recoverFromCarrier', label: 'Recover from the carrier', type: 'checkbox', value: claim.carrierLiable, testId: 'settle-recover' })}
${field({ name: 'note', label: 'Settlement note', type: 'textarea', required: true, testId: 'settle-note',
  attrs: { maxlength: '500', minlength: '10' }, rows: 3 })}
<button class="btn" type="submit" data-testid="settle-submit">Settle claim</button>
</form></div>`
      };
    }
  });

  app.post('/claims/:id/settle', async (ctx) => {
    const signedIn = core.requireAuth(ctx);
    if (!signedIn) return;
    const claim = find(ctx.params.id);
    if (!claim) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();

    // FP_D11 — with the defect off, the handler enforces the same permission the screen
    // shows. With it on it checks only that somebody is signed in, so a viewer who posts
    // directly settles the claim the UI told them they could not touch.
    if (!faults.on('FP_D11_VIEWER_CAN_SETTLE_CLAIM') && !can(signedIn, 'claim:settle')) {
      setFlash(ctx, 'error', 'You do not have permission to settle claims.');
      return ctx.redirect(`/claims/${claim.id}`);
    }

    const amount = Number(body.settledAmountGbp);
    if (!Number.isFinite(amount) || amount < 0) {
      setFlash(ctx, 'error', 'Enter a settlement amount of zero or more.');
      return ctx.redirect(`/claims/${claim.id}/settle`);
    }
    if (amount > claim.claimedAmountGbp) {
      setFlash(ctx, 'error', `A settlement cannot exceed the ${money(claim.claimedAmountGbp)} claimed.`);
      return ctx.redirect(`/claims/${claim.id}/settle`);
    }

    claim.status = 'settled';
    claim.settledAmountGbp = amount;
    state.auditEntries.unshift({
      id: `aud-${Date.now()}`, at: new Date().toISOString(), userId: signedIn.id,
      action: 'claim.settled', entityType: 'claim', entityId: claim.id,
      ipAddress: '203.0.113.17', correlationId: `cor-${Date.now() % 1_000_000}`, outcome: 'allowed'
    });
    setFlash(ctx, 'success', `${claim.reference} settled at ${money(amount)}.`);
    return ctx.redirect(`/claims/${claim.id}`);
  });

  definePage({
    path: '/claims/analysis', domain: 'claims', title: 'Claims analysis', kind: 'report',
    view: () => {
      const byType = ['damage', 'loss', 'delay', 'shortage'].map(type => {
        const rows = state.claims.filter(c => c.type === type);
        const settled = rows.filter(c => c.settledAmountGbp !== null);
        return {
          type, count: rows.length,
          claimed: Math.round(rows.reduce((s, c) => s + c.claimedAmountGbp, 0) * 100) / 100,
          settled: Math.round(settled.reduce((s, c) => s + (c.settledAmountGbp ?? 0), 0) * 100) / 100,
          settledCount: settled.length
        };
      });
      return {
        title: 'Claims analysis',
        breadcrumbs: [{ label: 'Claims', href: '/claims' }, { label: 'Analysis' }],
        body: `<div class="panel"><h2 style="margin-top:0">By type</h2>
${table({
  caption: 'Claims by type, claimed against settled', testId: 'claims-by-type',
  columns: [
    { header: 'Type', cell: row => h(row.type) },
    { header: 'Claims', cell: row => String(row.count) },
    { header: 'Claimed', cell: row => money(row.claimed) },
    { header: 'Settled', cell: row => String(row.settledCount) },
    { header: 'Settled value', cell: row => money(row.settled) },
    { header: 'Recovery rate', cell: row => row.claimed
      ? `${Math.round((row.settled / row.claimed) * 1000) / 10}%`
      : '<span class="pill pill-muted">Nothing claimed</span>' }
  ],
  rows: byType
})}</div>
<div class="panel"><h2 style="margin-top:0">By carrier</h2>
${table({
  caption: 'Claims by carrier', testId: 'claims-by-carrier',
  columns: [
    { header: 'Carrier', cell: row => `<a href="/carriers/${h(row.id)}">${h(row.name)}</a>` },
    { header: 'Shipments', cell: row => String(state.shipments.filter(s => s.carrierId === row.id).length) },
    { header: 'Claims', cell: row => String(state.claims.filter(c => c.carrierId === row.id).length) },
    { header: 'Claim rate', cell: row => {
        const shipments = state.shipments.filter(s => s.carrierId === row.id).length;
        const claims = state.claims.filter(c => c.carrierId === row.id).length;
        return shipments ? `${Math.round((claims / shipments) * 1000) / 10}%` : '—';
      } },
    { header: 'Liable', cell: row => String(state.claims.filter(c => c.carrierId === row.id && c.carrierLiable).length) },
    { header: 'Published damage rate', cell: row => `${row.damageRatePct}%` }
  ],
  rows: state.carriers
})}</div>`
      };
    }
  });
}
