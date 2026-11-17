/**
 * Billing: invoices, credit notes, disputes, payments and the rating engine.
 *
 *   FP_D04  two invoices can carry the same reference
 *   FP_D06  the fuel surcharge is applied to the VAT-inclusive total
 *   FP_D09  a credit note can exceed the invoice it credits
 *   FP_D20  an invoice whose shipment no longer resolves crashes its detail page
 */
import { h, table, field, statusPill, shortDate, dateTime, money, kv, tabs, pagination, stat, modal } from '../ui/chrome.js';

export const SCREENS = [
  { path: '/billing', title: 'Billing', kind: 'dashboard' },
  { path: '/billing/invoices', title: 'Invoices', kind: 'list' },
  { path: '/billing/invoices/new', title: 'Raise an invoice', kind: 'form' },
  { path: '/billing/invoices/:id', title: 'Invoice', kind: 'detail' },
  { path: '/billing/credit-notes', title: 'Credit notes', kind: 'list' },
  { path: '/billing/credit-notes/new', title: 'Raise a credit note', kind: 'form' },
  { path: '/billing/disputes', title: 'Disputed invoices', kind: 'list' },
  { path: '/billing/payments', title: 'Payments', kind: 'form' },
  { path: '/billing/aging', title: 'Aged debt', kind: 'report' },
  { path: '/billing/surcharges', title: 'Surcharges', kind: 'form' },
  { path: '/billing/reconciliation', title: 'Reconciliation', kind: 'report' }
];

const payments = [];

export default function registerBilling({ app, core, state, faults }) {
  const { definePage, csrfField, csrfValid, setFlash, listParams, paginate, can } = core;

  const customer = id => state.customers.find(c => c.id === id);
  const shipment = id => state.shipments.find(s => s.id === id);
  const find = id => state.invoices.find(i => i.id === id || i.reference === id);

  for (const screen of SCREENS) {
    if (screen.path.includes(':id')) screen.sample = screen.path.replace(':id', state.invoices[1].id);
  }

  /**
   * The surcharge basis. FP_D06 computes it from the VAT-inclusive total, which overstates
   * every invoice by 20% of the surcharge.
   */
  const surchargeFor = (net, vat, pct) => faults.on('FP_D06_SURCHARGE_ON_GROSS')
    ? Math.round((net + vat) * (pct / 100) * 100) / 100
    : Math.round(net * (pct / 100) * 100) / 100;

  definePage({
    path: '/billing', domain: 'billing', title: 'Billing', kind: 'dashboard',
    view: () => {
      const overdue = state.invoices.filter(i => i.status === 'overdue');
      const disputed = state.invoices.filter(i => i.status === 'disputed');
      const outstanding = state.invoices.filter(i => ['issued', 'overdue', 'disputed'].includes(i.status));
      return {
        title: 'Billing',
        actions: `<a class="btn" href="/billing/invoices/new" data-testid="new-invoice">Raise an invoice</a>
<a class="btn btn-secondary" href="/billing/aging" data-testid="go-aging">Aged debt</a>`,
        body: `<div class="grid grid-4" style="margin-bottom:16px">
${stat(money(outstanding.reduce((s, i) => s + i.totalGbp, 0)), 'Outstanding', 'stat-outstanding')}
${stat(String(overdue.length), 'Overdue invoices', 'stat-overdue-count')}
${stat(money(overdue.reduce((s, i) => s + i.totalGbp, 0)), 'Overdue value', 'stat-overdue-value')}
${stat(String(disputed.length), 'In dispute', 'stat-disputed')}
</div>
<div class="panel"><h2 style="margin-top:0">Recent invoices</h2>
${table({
  caption: 'The twelve most recent invoices', testId: 'recent-invoices',
  columns: [
    { header: 'Reference', cell: row => `<a href="/billing/invoices/${h(row.id)}">${h(row.reference)}</a>` },
    { header: 'Customer', cell: row => h(customer(row.customerId)?.name ?? '—') },
    { header: 'Issued', cell: row => shortDate(row.issuedOn) },
    { header: 'Due', cell: row => shortDate(row.dueOn) },
    { header: 'Total', cell: row => money(row.totalGbp) },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: state.invoices.slice(0, 12)
})}</div>`
      };
    }
  });

  definePage({
    path: '/billing/invoices', domain: 'billing', title: 'Invoices', kind: 'list',
    view: (ctx) => {
      const { page, size, q } = listParams(ctx);
      const status = String(ctx.query.status ?? '');
      let rows = state.invoices;
      if (status) rows = rows.filter(i => i.status === status);
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter(i => i.reference.toLowerCase().includes(needle) ||
          (customer(i.customerId)?.name ?? '').toLowerCase().includes(needle));
      }
      const { slice, pageCount } = paginate(rows, page, size);
      return {
        title: 'Invoices',
        breadcrumbs: [{ label: 'Billing', href: '/billing' }, { label: 'Invoices' }],
        actions: `<a class="btn" href="/billing/invoices/new" data-testid="new-invoice">Raise an invoice</a>`,
        body: `<form method="get" action="/billing/invoices" class="filters" data-testid="invoice-filters">
${field({ name: 'q', label: 'Search', type: 'search', value: q, testId: 'invoice-search' })}
${field({ name: 'status', label: 'Status', value: status, testId: 'invoice-status',
  options: [{ value: '', label: 'Any status' }, 'draft', 'issued', 'paid', 'overdue', 'disputed', 'creditNoted'] })}
<button class="btn" type="submit" data-testid="invoice-apply">Apply</button></form>
${table({
  caption: 'Invoices', testId: 'invoices-table', empty: 'No invoices match.',
  columns: [
    { header: 'Reference', cell: row => `<a href="/billing/invoices/${h(row.id)}" data-testid="invoice-${h(row.reference)}">${h(row.reference)}</a>` },
    { header: 'Customer', cell: row => h(customer(row.customerId)?.name ?? '—') },
    { header: 'Issued', cell: row => shortDate(row.issuedOn) },
    { header: 'Due', cell: row => shortDate(row.dueOn) },
    { header: 'Net', cell: row => money(row.netGbp) },
    { header: 'VAT', cell: row => money(row.vatGbp) },
    { header: 'Total', cell: row => money(row.totalGbp) },
    { header: 'Overdue', cell: row => row.daysOverdue ? `<span class="pill pill-${row.daysOverdue > 30 ? 'danger' : 'warn'}">${row.daysOverdue} days</span>` : '' },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: slice
})}
${pagination('/billing/invoices', page, pageCount, { q, status })}`
      };
    }
  });

  definePage({
    path: '/billing/invoices/new', domain: 'billing', title: 'Raise an invoice', kind: 'form',
    view: (ctx) => ({
      title: 'Raise an invoice',
      breadcrumbs: [{ label: 'Billing', href: '/billing' }, { label: 'Invoices', href: '/billing/invoices' }, { label: 'New' }],
      body: `<div class="panel" style="max-width:600px">
<form method="post" action="/billing/invoices/new" data-testid="new-invoice-form">
${csrfField(ctx)}
${field({ name: 'customerId', label: 'Customer', required: true, testId: 'invoice-customer',
  options: [{ value: '', label: 'Choose a customer' }, ...state.customers.map(c => ({ value: c.id, label: c.name }))] })}
${field({ name: 'shipmentId', label: 'Shipment', required: true, testId: 'invoice-shipment',
  options: [{ value: '', label: 'Choose a shipment' }, ...state.shipments.filter(s => s.status === 'delivered').slice(0, 20).map(s => ({ value: s.id, label: `${s.reference} — ${s.destination.city}` }))] })}
${field({ name: 'netGbp', label: 'Net amount (GBP)', type: 'number', required: true, testId: 'invoice-net',
  attrs: { min: '0.01', max: '1000000', step: '0.01' } })}
${field({ name: 'issuedOn', label: 'Issue date', type: 'date', required: true, testId: 'invoice-issued' })}
${field({ name: 'reference', label: 'Reference', testId: 'invoice-reference',
  attrs: { maxlength: '24' }, hint: 'Leave blank to generate one.' })}
<button class="btn" type="submit" data-testid="invoice-submit">Raise invoice</button>
</form></div>`
    })
  });

  app.post('/billing/invoices/new', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const body = await ctx.body();
    if (!await csrfValid(ctx)) { setFlash(ctx, 'error', 'That form expired.'); return ctx.redirect('/billing/invoices/new'); }

    const net = Number(body.netGbp);
    const chosen = customer(String(body.customerId ?? ''));
    if (!chosen || !Number.isFinite(net) || net <= 0) {
      setFlash(ctx, 'error', 'A customer and a net amount above zero are required.');
      return ctx.redirect('/billing/invoices/new');
    }

    const index = state.invoices.length;
    const requested = String(body.reference ?? '').trim();
    const generated = `${state.settings.billing.invoiceNumberPrefix}${5000 + index}`;
    const reference = requested || generated;

    // FP_D04 — with the defect off, the reference must be unique. With it on, nothing
    // checks, and two invoices can be issued carrying the same number.
    if (!faults.on('FP_D04_DUPLICATE_INVOICE_REFERENCE') && state.invoices.some(i => i.reference === reference)) {
      setFlash(ctx, 'error', `Invoice ${reference} already exists.`);
      return ctx.redirect('/billing/invoices/new');
    }

    const vat = Math.round(net * (state.settings.billing.vatRatePct / 100) * 100) / 100;
    const issuedOn = String(body.issuedOn ?? new Date().toISOString().slice(0, 10));
    const due = new Date(Date.parse(issuedOn) + chosen.paymentTermsDays * 86_400_000).toISOString().slice(0, 10);
    const created = {
      id: `inv-${String(index + 1).padStart(4, '0')}`,
      reference, customerId: chosen.id, shipmentId: String(body.shipmentId ?? ''),
      status: 'issued', issuedOn, dueOn: due, paidOn: null, currency: 'GBP',
      netGbp: net, vatGbp: vat, totalGbp: Math.round((net + vat) * 100) / 100, daysOverdue: 0,
      lines: [{ id: `invl-${index}-1`, description: 'Freight', quantity: 1, unitPriceGbp: net, totalGbp: net }]
    };
    state.invoices.push(created);
    setFlash(ctx, 'success', `Invoice ${created.reference} raised.`);
    return ctx.redirect(`/billing/invoices/${created.id}`);
  });

  definePage({
    path: '/billing/invoices/:id', domain: 'billing', title: 'Invoice', kind: 'detail',
    view: (ctx) => {
      const invoice = find(ctx.params.id);
      if (!invoice) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty" data-testid="not-found">No such invoice.</div></div>' };

      const linked = shipment(invoice.shipmentId);

      // FP_D20 — the reference is dereferenced without a guard. An invoice whose shipment
      // has been removed takes the page down rather than showing the invoice without it.
      const shipmentLabel = faults.on('FP_D20_MISSING_REFERENCE_CRASHES')
        ? linked.reference
        : (linked?.reference ?? '—');

      const fuel = surchargeFor(invoice.netGbp, invoice.vatGbp, state.settings.billing.fuelSurchargePct);
      const cust = customer(invoice.customerId);

      return {
        title: `Invoice ${invoice.reference}`,
        breadcrumbs: [{ label: 'Billing', href: '/billing' }, { label: 'Invoices', href: '/billing/invoices' }, { label: invoice.reference }],
        actions: `<a class="btn btn-secondary" href="/billing/credit-notes/new?invoice=${h(invoice.id)}" data-testid="raise-credit-note">Raise a credit note</a>
${invoice.status === 'issued' || invoice.status === 'overdue'
  ? `<button class="btn" type="button" data-opens-modal="pay-modal" data-testid="open-pay">Record a payment</button>` : ''}`,
        body: `<div class="grid grid-4" style="margin-bottom:14px">
${stat(money(invoice.netGbp), 'Net', 'invoice-net')}
${stat(money(invoice.vatGbp), 'VAT', 'invoice-vat')}
${stat(money(invoice.totalGbp), 'Total', 'invoice-total')}
${stat(statusPill(invoice.status), 'Status', 'invoice-status')}
</div>
<div class="grid grid-2">
<div class="panel"><h3 style="margin-top:0">Invoice</h3>${kv([
  ['Reference', `<code>${h(invoice.reference)}</code>`],
  ['Customer', cust ? `<a href="/customers/${h(cust.id)}">${h(cust.name)}</a>` : '—'],
  ['Shipment', linked ? `<a href="/shipments/${h(linked.id)}">${h(shipmentLabel)}</a>` : h(shipmentLabel)],
  ['Issued', shortDate(invoice.issuedOn)],
  ['Due', shortDate(invoice.dueOn)],
  ['Paid', shortDate(invoice.paidOn)],
  ['Days overdue', invoice.daysOverdue ? String(invoice.daysOverdue) : '—']
])}</div>
<div class="panel"><h3 style="margin-top:0">Calculation</h3>${kv([
  ['Net freight', money(invoice.netGbp)],
  [`Fuel surcharge ${state.settings.billing.fuelSurchargePct}%`, `<span data-testid="fuel-surcharge">${money(fuel)}</span>`],
  ['VAT basis', money(invoice.netGbp)],
  [`VAT ${state.settings.billing.vatRatePct}%`, money(invoice.vatGbp)],
  ['Total', `<strong>${money(invoice.totalGbp)}</strong>`]
])}
<p class="hint" style="margin-top:10px">The fuel surcharge is a percentage of net freight.</p>
</div>
</div>
<div class="panel"><h3 style="margin-top:0">Lines</h3>
${table({
  caption: 'Invoice lines', testId: 'invoice-lines',
  columns: [
    { header: 'Description', cell: row => h(row.description) },
    { header: 'Quantity', cell: row => String(row.quantity) },
    { header: 'Unit price', cell: row => money(row.unitPriceGbp) },
    { header: 'Total', cell: row => money(row.totalGbp) }
  ],
  rows: invoice.lines
})}</div>
${modal('pay-modal', 'Record a payment', `
<form method="post" action="/billing/invoices/${h(invoice.id)}/pay" data-testid="pay-form">
${csrfField(ctx)}
${field({ name: 'amount', label: 'Amount received (GBP)', type: 'number', required: true, value: invoice.totalGbp,
  testId: 'pay-amount', attrs: { min: '0.01', max: '1000000', step: '0.01' } })}
${field({ name: 'method', label: 'Method', required: true, testId: 'pay-method', options: ['Bank transfer', 'Direct debit', 'Card', 'Cheque'] })}
${field({ name: 'receivedOn', label: 'Date received', type: 'date', required: true, testId: 'pay-date' })}
<button class="btn" type="submit" data-testid="pay-submit">Record payment</button>
</form>`)}`
      };
    }
  });

  app.post('/billing/invoices/:id/pay', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const invoice = find(ctx.params.id);
    if (!invoice) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();
    if (!can(user, 'invoice:write')) {
      setFlash(ctx, 'error', 'You do not have permission to record payments.');
      return ctx.redirect(`/billing/invoices/${invoice.id}`);
    }
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setFlash(ctx, 'error', 'Enter an amount above zero.');
      return ctx.redirect(`/billing/invoices/${invoice.id}`);
    }
    payments.push({ invoiceId: invoice.id, amount, method: String(body.method), receivedOn: String(body.receivedOn), by: user.displayName });
    if (amount >= invoice.totalGbp) {
      invoice.status = 'paid';
      invoice.paidOn = String(body.receivedOn);
      invoice.daysOverdue = 0;
    }
    setFlash(ctx, 'success', `Payment of ${money(amount)} recorded.`);
    return ctx.redirect(`/billing/invoices/${invoice.id}`);
  });

  // ---- credit notes -------------------------------------------------------

  definePage({
    path: '/billing/credit-notes', domain: 'billing', title: 'Credit notes', kind: 'list',
    view: () => ({
      title: 'Credit notes',
      breadcrumbs: [{ label: 'Billing', href: '/billing' }, { label: 'Credit notes' }],
      actions: `<a class="btn" href="/billing/credit-notes/new" data-testid="new-credit-note">Raise a credit note</a>`,
      body: `${table({
        caption: 'Credit notes raised', testId: 'credit-notes-table', empty: 'No credit notes.',
        columns: [
          { header: 'Reference', cell: row => `<code>${h(row.reference)}</code>` },
          { header: 'Invoice', cell: row => {
              const invoice = state.invoices.find(i => i.id === row.invoiceId);
              return invoice ? `<a href="/billing/invoices/${h(invoice.id)}">${h(invoice.reference)}</a>` : '—';
            } },
          { header: 'Customer', cell: row => h(customer(row.customerId)?.name ?? '—') },
          { header: 'Reason', cell: row => h(row.reason) },
          { header: 'Amount', cell: row => money(row.amountGbp) },
          { header: 'Raised', cell: row => shortDate(row.raisedAt) },
          { header: 'Status', cell: row => statusPill(row.status) }
        ],
        rows: state.creditNotes
      })}`
    })
  });

  definePage({
    path: '/billing/credit-notes/new', domain: 'billing', title: 'Raise a credit note', kind: 'form',
    view: (ctx) => {
      const preselected = String(ctx.query.invoice ?? '');
      const chosen = find(preselected);
      return {
        title: 'Raise a credit note',
        breadcrumbs: [{ label: 'Billing', href: '/billing' }, { label: 'Credit notes', href: '/billing/credit-notes' }, { label: 'New' }],
        body: `<div class="panel" style="max-width:560px">
${chosen ? `<p class="hint" data-testid="invoice-total-hint">Invoice ${h(chosen.reference)} totals ${money(chosen.totalGbp)}. A credit note cannot exceed it.</p>` : ''}
<form method="post" action="/billing/credit-notes/new" data-testid="credit-note-form">
${csrfField(ctx)}
${field({ name: 'invoiceId', label: 'Invoice to credit', required: true, value: preselected, testId: 'cn-invoice',
  options: [{ value: '', label: 'Choose an invoice' }, ...state.invoices.filter(i => i.status !== 'draft').slice(0, 30).map(i => ({ value: i.id, label: `${i.reference} — ${money(i.totalGbp)}` }))] })}
${field({ name: 'amountGbp', label: 'Credit amount (GBP)', type: 'number', required: true, testId: 'cn-amount',
  attrs: { min: '0.01', max: '1000000', step: '0.01' },
  hint: 'Cannot exceed the invoice total.' })}
${field({ name: 'reason', label: 'Reason', required: true, testId: 'cn-reason',
  options: [{ value: '', label: 'Choose a reason' }, 'Service failure', 'Rating error', 'Goodwill', 'Duplicate invoice', 'Claim settlement'] })}
${field({ name: 'note', label: 'Note', type: 'textarea', testId: 'cn-note', attrs: { maxlength: '400' } })}
<button class="btn" type="submit" data-testid="cn-submit">Raise credit note</button>
</form></div>`
      };
    }
  });

  app.post('/billing/credit-notes/new', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const body = await ctx.body();
    if (!can(user, 'invoice:credit')) {
      setFlash(ctx, 'error', 'You do not have permission to raise credit notes.');
      return ctx.redirect('/billing/credit-notes/new');
    }
    const invoice = find(String(body.invoiceId ?? ''));
    const amount = Number(body.amountGbp);
    if (!invoice || !Number.isFinite(amount) || amount <= 0) {
      setFlash(ctx, 'error', 'Choose an invoice and an amount above zero.');
      return ctx.redirect('/billing/credit-notes/new');
    }
    if (!String(body.reason ?? '').trim()) {
      setFlash(ctx, 'error', 'Choose a reason.');
      return ctx.redirect('/billing/credit-notes/new');
    }

    // FP_D09 — with the defect off, a credit note above the invoice total is refused.
    // With it on, nothing compares the two and the customer balance can go negative.
    if (!faults.on('FP_D09_CREDIT_NOTE_EXCEEDS_INVOICE') && amount > invoice.totalGbp) {
      setFlash(ctx, 'error', `A credit note cannot exceed the invoice total of ${money(invoice.totalGbp)}.`);
      return ctx.redirect(`/billing/credit-notes/new?invoice=${invoice.id}`);
    }

    const index = state.creditNotes.length;
    state.creditNotes.push({
      id: `crn-${String(index + 1).padStart(4, '0')}`,
      reference: `CN-2026-${String(300 + index)}`,
      invoiceId: invoice.id, customerId: invoice.customerId,
      reason: String(body.reason), amountGbp: amount, status: 'draft',
      raisedAt: new Date().toISOString(), raisedByUserId: user.id
    });
    invoice.status = 'creditNoted';
    setFlash(ctx, 'success', `Credit note for ${money(amount)} raised against ${invoice.reference}.`);
    return ctx.redirect('/billing/credit-notes');
  });

  // ---- disputes, payments, aging, surcharges, reconciliation --------------

  definePage({
    path: '/billing/disputes', domain: 'billing', title: 'Disputed invoices', kind: 'list',
    view: () => {
      const rows = state.invoices.filter(i => i.status === 'disputed');
      return {
        title: 'Disputed invoices',
        breadcrumbs: [{ label: 'Billing', href: '/billing' }, { label: 'Disputes' }],
        body: `<div class="panel">${table({
          caption: 'Invoices the customer has disputed', testId: 'disputes-table', empty: 'Nothing is in dispute.',
          columns: [
            { header: 'Invoice', cell: row => `<a href="/billing/invoices/${h(row.id)}">${h(row.reference)}</a>` },
            { header: 'Customer', cell: row => h(customer(row.customerId)?.name ?? '—') },
            { header: 'Issued', cell: row => shortDate(row.issuedOn) },
            { header: 'Total', cell: row => money(row.totalGbp) },
            { header: '', cell: row => `<a class="btn btn-secondary" href="/billing/credit-notes/new?invoice=${h(row.id)}">Credit</a>` }
          ],
          rows
        })}</div>`
      };
    }
  });

  definePage({
    path: '/billing/payments', domain: 'billing', title: 'Payments', kind: 'form',
    view: (ctx) => ({
      title: 'Payments',
      breadcrumbs: [{ label: 'Billing', href: '/billing' }, { label: 'Payments' }],
      body: `<div class="panel">
${table({
  caption: 'Payments recorded in this session', testId: 'payments-table', empty: 'No payments recorded in this session.',
  columns: [
    { header: 'Invoice', cell: row => {
        const invoice = state.invoices.find(i => i.id === row.invoiceId);
        return invoice ? `<a href="/billing/invoices/${h(invoice.id)}">${h(invoice.reference)}</a>` : '—';
      } },
    { header: 'Amount', cell: row => money(row.amount) },
    { header: 'Method', cell: row => h(row.method) },
    { header: 'Received', cell: row => shortDate(row.receivedOn) },
    { header: 'By', cell: row => h(row.by) }
  ],
  rows: payments
})}
<h3>Record a payment against an invoice</h3>
<form method="post" action="/billing/payments" data-testid="payment-form">
${csrfField(ctx)}
${field({ name: 'invoiceId', label: 'Invoice', required: true, testId: 'payment-invoice',
  options: [{ value: '', label: 'Choose an invoice' }, ...state.invoices.filter(i => ['issued', 'overdue'].includes(i.status)).slice(0, 25).map(i => ({ value: i.id, label: `${i.reference} — ${money(i.totalGbp)}` }))] })}
${field({ name: 'amount', label: 'Amount (GBP)', type: 'number', required: true, testId: 'payment-amount', attrs: { min: '0.01', max: '1000000', step: '0.01' } })}
${field({ name: 'method', label: 'Method', required: true, testId: 'payment-method', options: ['Bank transfer', 'Direct debit', 'Card', 'Cheque'] })}
${field({ name: 'receivedOn', label: 'Date received', type: 'date', required: true, testId: 'payment-date' })}
<button class="btn" type="submit" data-testid="payment-submit">Record payment</button>
</form></div>`
    })
  });

  app.post('/billing/payments', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const body = await ctx.body();
    const invoice = find(String(body.invoiceId ?? ''));
    const amount = Number(body.amount);
    if (!invoice || !Number.isFinite(amount) || amount <= 0) {
      setFlash(ctx, 'error', 'Choose an invoice and an amount above zero.');
      return ctx.redirect('/billing/payments');
    }
    payments.push({ invoiceId: invoice.id, amount, method: String(body.method), receivedOn: String(body.receivedOn), by: user.displayName });
    if (amount >= invoice.totalGbp) { invoice.status = 'paid'; invoice.paidOn = String(body.receivedOn); invoice.daysOverdue = 0; }
    setFlash(ctx, 'success', `Payment of ${money(amount)} recorded.`);
    return ctx.redirect('/billing/payments');
  });

  definePage({
    path: '/billing/aging', domain: 'billing', title: 'Aged debt', kind: 'report',
    view: () => {
      const buckets = [
        { label: 'Current', test: i => i.daysOverdue === 0 },
        { label: '1 to 30 days', test: i => i.daysOverdue >= 1 && i.daysOverdue <= 30 },
        { label: '31 to 60 days', test: i => i.daysOverdue >= 31 && i.daysOverdue <= 60 },
        { label: 'Over 60 days', test: i => i.daysOverdue > 60 }
      ];
      const outstanding = state.invoices.filter(i => ['issued', 'overdue', 'disputed'].includes(i.status));
      return {
        title: 'Aged debt',
        breadcrumbs: [{ label: 'Billing', href: '/billing' }, { label: 'Aged debt' }],
        body: `<div class="grid grid-4" style="margin-bottom:16px">
${buckets.map(bucket => {
  const rows = outstanding.filter(bucket.test);
  return stat(money(rows.reduce((s, i) => s + i.totalGbp, 0)), `${bucket.label} (${rows.length})`, `aging-${bucket.label.replace(/\s+/g, '-').toLowerCase()}`);
}).join('')}
</div>
<div class="panel"><h2 style="margin-top:0">By customer</h2>
${table({
  caption: 'Outstanding debt by customer', testId: 'aging-table',
  columns: [
    { header: 'Customer', cell: row => `<a href="/customers/${h(row.id)}">${h(row.name)}</a>` },
    { header: 'Invoices', cell: row => String(row.invoices.length) },
    { header: 'Outstanding', cell: row => money(row.total) },
    { header: 'Oldest overdue', cell: row => row.oldest ? `${row.oldest} days` : '—' },
    { header: 'Credit limit', cell: row => money(row.creditLimit) }
  ],
  rows: state.customers.map(c => {
    const invoices = outstanding.filter(i => i.customerId === c.id);
    return {
      id: c.id, name: c.name, creditLimit: c.creditLimit, invoices,
      total: Math.round(invoices.reduce((s, i) => s + i.totalGbp, 0) * 100) / 100,
      oldest: invoices.reduce((max, i) => Math.max(max, i.daysOverdue), 0) || null
    };
  }).filter(row => row.invoices.length > 0)
})}</div>`
      };
    }
  });

  definePage({
    path: '/billing/surcharges', domain: 'billing', title: 'Surcharges', kind: 'form',
    view: (ctx) => ({
      title: 'Surcharges',
      breadcrumbs: [{ label: 'Billing', href: '/billing' }, { label: 'Surcharges' }],
      body: `<div class="panel" style="max-width:520px">
<p class="hint">The fuel surcharge is a percentage of net freight, reviewed monthly.</p>
<form method="post" action="/billing/surcharges" data-testid="surcharge-form">
${csrfField(ctx)}
${field({ name: 'fuelSurchargePct', label: 'Fuel surcharge (%)', type: 'number', value: state.settings.billing.fuelSurchargePct,
  required: true, testId: 'fuel-pct', attrs: { min: '0', max: '60', step: '0.1' } })}
${field({ name: 'vatRatePct', label: 'VAT rate (%)', type: 'number', value: state.settings.billing.vatRatePct,
  required: true, testId: 'vat-pct', attrs: { min: '0', max: '30', step: '0.5' } })}
${field({ name: 'effectiveFrom', label: 'Effective from', type: 'date', required: true, testId: 'surcharge-effective' })}
<button class="btn" type="submit" data-testid="surcharge-save">Save surcharges</button>
</form></div>`
    })
  });

  app.post('/billing/surcharges', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const body = await ctx.body();
    if (!can(user, 'invoice:write')) {
      setFlash(ctx, 'error', 'You do not have permission to change surcharges.');
      return ctx.redirect('/billing/surcharges');
    }
    const fuel = Number(body.fuelSurchargePct);
    if (!Number.isFinite(fuel) || fuel < 0 || fuel > 60) {
      setFlash(ctx, 'error', 'The fuel surcharge must be between 0 and 60 percent.');
      return ctx.redirect('/billing/surcharges');
    }
    state.settings.billing.fuelSurchargePct = fuel;
    state.settings.billing.vatRatePct = Number(body.vatRatePct ?? state.settings.billing.vatRatePct);
    setFlash(ctx, 'success', 'Surcharges saved.');
    return ctx.redirect('/billing/surcharges');
  });

  definePage({
    path: '/billing/reconciliation', domain: 'billing', title: 'Reconciliation', kind: 'report',
    view: () => {
      const delivered = state.shipments.filter(s => s.status === 'delivered');
      const uninvoiced = delivered.filter(s => !state.invoices.some(i => i.shipmentId === s.id));
      return {
        title: 'Reconciliation',
        breadcrumbs: [{ label: 'Billing', href: '/billing' }, { label: 'Reconciliation' }],
        body: `<div class="grid grid-3" style="margin-bottom:16px">
${stat(String(delivered.length), 'Delivered shipments', 'recon-delivered')}
${stat(String(delivered.length - uninvoiced.length), 'Invoiced', 'recon-invoiced')}
${stat(String(uninvoiced.length), 'Delivered but not invoiced', 'recon-uninvoiced')}
</div>
<div class="panel"><h2 style="margin-top:0">Delivered and not yet invoiced</h2>
<p class="hint">Revenue earned and not billed. ${state.settings.billing.autoIssueOnDelivery ? 'Auto-issue on delivery is on.' : 'Auto-issue on delivery is off, so these need raising by hand.'}</p>
${table({
  caption: 'Delivered shipments with no invoice', testId: 'reconciliation-table', empty: 'Everything delivered has been invoiced.',
  columns: [
    { header: 'Shipment', cell: row => `<a href="/shipments/${h(row.id)}">${h(row.reference)}</a>` },
    { header: 'Customer', cell: row => h(customer(row.customerId)?.name ?? '—') },
    { header: 'Delivered', cell: row => shortDate(row.deliveredAt) },
    { header: 'Freight', cell: row => money(row.freightChargeGbp) },
    { header: '', cell: row => `<a class="btn btn-secondary" href="/billing/invoices/new?shipment=${h(row.id)}" data-testid="invoice-${h(row.reference)}">Invoice</a>` }
  ],
  rows: uninvoiced
})}</div>`
      };
    }
  });
}
