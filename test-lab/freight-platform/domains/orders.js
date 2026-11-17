/**
 * Sales orders, purchase orders, approvals and backorders.
 *
 *   FP_D05  the credit limit is enforced in the browser and not in the handler
 *   FP_D24  the approval dialog is not announced and does not take focus
 */
import { h, table, field, statusPill, shortDate, dateTime, money, kv, tabs, modal, pagination, stat } from '../ui/chrome.js';

export const SCREENS = [
  { path: '/orders', title: 'Orders', kind: 'dashboard' },
  { path: '/orders/sales', title: 'Sales orders', kind: 'list' },
  { path: '/orders/sales/new', title: 'New sales order', kind: 'form' },
  { path: '/orders/sales/:id', title: 'Sales order', kind: 'detail' },
  { path: '/orders/sales/:id/edit', title: 'Edit sales order', kind: 'form' },
  { path: '/orders/sales/:id/lines', title: 'Order lines', kind: 'list' },
  { path: '/orders/purchase', title: 'Purchase orders', kind: 'list' },
  { path: '/orders/purchase/new', title: 'New purchase order', kind: 'form' },
  { path: '/orders/purchase/:id', title: 'Purchase order', kind: 'detail' },
  { path: '/orders/approvals', title: 'Orders awaiting approval', kind: 'list' },
  { path: '/orders/backorders', title: 'Backorders', kind: 'list' }
];

export default function registerOrders({ app, core, state, faults }) {
  const { definePage, csrfField, csrfValid, setFlash, listParams, paginate, can } = core;

  const customer = id => state.customers.find(c => c.id === id);
  const findSales = id => state.salesOrders.find(o => o.id === id || o.reference === id);
  const findPurchase = id => state.purchaseOrders.find(o => o.id === id || o.reference === id);

  for (const screen of SCREENS) {
    if (screen.path.startsWith('/orders/sales/:id')) screen.sample = screen.path.replace(':id', state.salesOrders[2].id);
    if (screen.path.startsWith('/orders/purchase/:id')) screen.sample = screen.path.replace(':id', state.purchaseOrders[0].id);
  }

  definePage({
    path: '/orders', domain: 'orders', title: 'Orders', kind: 'dashboard',
    view: () => {
      const awaiting = state.salesOrders.filter(o => o.status === 'awaitingApproval');
      const open = state.salesOrders.filter(o => !['invoiced', 'cancelled'].includes(o.status));
      const poOpen = state.purchaseOrders.filter(o => !['closed', 'received'].includes(o.status));
      return {
        title: 'Orders',
        actions: `<a class="btn" href="/orders/sales/new" data-testid="new-sales-order">New sales order</a>
                  <a class="btn btn-secondary" href="/orders/purchase/new" data-testid="new-purchase-order">New purchase order</a>`,
        body: `<div class="grid grid-4" style="margin-bottom:16px">
${stat(open.length, 'Open sales orders', 'stat-open-so')}
${stat(awaiting.length, 'Awaiting approval', 'stat-awaiting')}
${stat(poOpen.length, 'Open purchase orders', 'stat-open-po')}
${stat(money(open.reduce((sum, o) => sum + o.totalGbp, 0)), 'Open order value', 'stat-order-value')}
</div>
<div class="grid grid-2">
<div class="panel"><h2 style="margin-top:0">Recent sales orders</h2>
${table({
  caption: 'The ten most recent sales orders', testId: 'recent-sales',
  columns: [
    { header: 'Reference', cell: row => `<a href="/orders/sales/${h(row.id)}">${h(row.reference)}</a>` },
    { header: 'Customer', cell: row => h(customer(row.customerId)?.name ?? '—') },
    { header: 'Total', cell: row => money(row.totalGbp) },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: state.salesOrders.slice(0, 10)
})}</div>
<div class="panel"><h2 style="margin-top:0">Recent purchase orders</h2>
${table({
  caption: 'The ten most recent purchase orders', testId: 'recent-purchase',
  columns: [
    { header: 'Reference', cell: row => `<a href="/orders/purchase/${h(row.id)}">${h(row.reference)}</a>` },
    { header: 'Supplier', cell: row => h(row.supplierName) },
    { header: 'Expected', cell: row => shortDate(row.expectedOn) },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: state.purchaseOrders.slice(0, 10)
})}</div>
</div>`
      };
    }
  });

  definePage({
    path: '/orders/sales', domain: 'orders', title: 'Sales orders', kind: 'list',
    view: (ctx) => {
      const { page, size, q } = listParams(ctx);
      const status = String(ctx.query.status ?? '');
      let rows = state.salesOrders;
      if (status) rows = rows.filter(o => o.status === status);
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter(o => o.reference.toLowerCase().includes(needle) ||
          (customer(o.customerId)?.name ?? '').toLowerCase().includes(needle));
      }
      const { slice, pageCount } = paginate(rows, page, size);
      return {
        title: 'Sales orders',
        breadcrumbs: [{ label: 'Orders', href: '/orders' }, { label: 'Sales orders' }],
        actions: `<a class="btn" href="/orders/sales/new" data-testid="new-sales-order">New sales order</a>`,
        body: `<form method="get" action="/orders/sales" class="filters" data-testid="sales-filters">
${field({ name: 'q', label: 'Search', type: 'search', value: q, testId: 'sales-search' })}
${field({ name: 'status', label: 'Status', value: status, testId: 'sales-status',
  options: [{ value: '', label: 'Any status' }, 'draft', 'awaitingApproval', 'approved', 'allocated', 'dispatched', 'invoiced', 'cancelled'] })}
<button class="btn" type="submit" data-testid="sales-apply">Apply</button></form>
${table({
  caption: 'Sales orders', testId: 'sales-orders-table', empty: 'No sales orders match.',
  columns: [
    { header: 'Reference', cell: row => `<a href="/orders/sales/${h(row.id)}" data-testid="so-${h(row.reference)}">${h(row.reference)}</a>` },
    { header: 'Customer', cell: row => h(customer(row.customerId)?.name ?? '—') },
    { header: 'Placed', cell: row => shortDate(row.placedAt) },
    { header: 'Requested', cell: row => shortDate(row.requestedDeliveryOn) },
    { header: 'Lines', cell: row => String(row.lines.length) },
    { header: 'Total', cell: row => money(row.totalGbp) },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: slice
})}
${pagination('/orders/sales', page, pageCount, { q, status })}`
      };
    }
  });

  definePage({
    path: '/orders/sales/new', domain: 'orders', title: 'New sales order', kind: 'form',
    view: (ctx) => ({
      title: 'New sales order',
      breadcrumbs: [{ label: 'Orders', href: '/orders' }, { label: 'Sales orders', href: '/orders/sales' }, { label: 'New' }],
      body: `<div class="panel" style="max-width:640px">
<form method="post" action="/orders/sales/new" data-testid="new-sales-order-form">
${csrfField(ctx)}
${field({ name: 'customerId', label: 'Customer', required: true, testId: 'so-customer',
  options: [{ value: '', label: 'Choose a customer' }, ...state.customers.map(c => ({
    value: c.id,
    label: `${c.name}${c.status === 'onHold' ? ' — ON CREDIT HOLD' : ''}`
  }))],
  hint: 'A customer on credit hold cannot have a new order approved.' })}
${field({ name: 'requestedDeliveryOn', label: 'Requested delivery date', type: 'date', required: true, testId: 'so-delivery-date' })}
${field({ name: 'serviceLevel', label: 'Service level', testId: 'so-service', options: state.SERVICE_LEVELS.map(s => ({ value: s.code, label: s.name })) })}
${field({ name: 'incoterm', label: 'Incoterm', testId: 'so-incoterm', options: state.INCOTERMS, value: 'DAP' })}
${field({ name: 'skuId', label: 'Product', required: true, testId: 'so-sku',
  options: [{ value: '', label: 'Choose a product' }, ...state.skus.map(s => ({ value: s.id, label: `${s.code} — ${s.description}` }))] })}
${field({ name: 'quantity', label: 'Quantity', type: 'number', required: true, testId: 'so-quantity', attrs: { min: '1', max: '10000', step: '1' } })}
${field({ name: 'notes', label: 'Notes', type: 'textarea', testId: 'so-notes', attrs: { maxlength: '500' } })}
<button class="btn" type="submit" data-testid="so-submit">Create order</button>
</form></div>
<script type="module">
// The browser-side credit check. It disables submit for a customer on hold, which is why
// the missing server-side check is invisible from the screen.
const select = document.querySelector('[data-testid="so-customer"]');
const submit = document.querySelector('[data-testid="so-submit"]');
select?.addEventListener('change', () => {
  const onHold = select.selectedOptions[0]?.textContent?.includes('ON CREDIT HOLD');
  submit.disabled = Boolean(onHold);
  submit.title = onHold ? 'This customer is on credit hold.' : '';
});
</script>`
    })
  });

  app.post('/orders/sales/new', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    if (!await csrfValid(ctx)) { setFlash(ctx, 'error', 'That form expired.'); return ctx.redirect('/orders/sales/new'); }

    const chosen = customer(String(body.customerId ?? ''));
    if (!chosen) {
      setFlash(ctx, 'error', 'Choose a customer.');
      return ctx.redirect('/orders/sales/new');
    }

    // FP_D05 — with the defect off the handler refuses an order for a customer on hold,
    // which is what the disabled button in the browser is pretending to guarantee.
    if (!faults.on('FP_D05_CREDIT_LIMIT_BYPASSED') && chosen.status === 'onHold') {
      setFlash(ctx, 'error', `${chosen.name} is on credit hold. The order was not created.`);
      return ctx.redirect('/orders/sales/new');
    }

    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      setFlash(ctx, 'error', 'Enter a whole quantity of at least 1.');
      return ctx.redirect('/orders/sales/new');
    }

    const sku = state.skus.find(s => s.id === body.skuId) ?? state.skus[0];
    const lineTotal = Math.round(quantity * sku.unitValueGbp * 100) / 100;
    const index = state.salesOrders.length;
    const order = {
      id: `so-${String(index + 1).padStart(4, '0')}`,
      reference: `SO-2026-${String(1200 + index)}`,
      customerId: chosen.id,
      status: lineTotal > 50_000 ? 'awaitingApproval' : 'approved',
      placedAt: new Date().toISOString(),
      requestedDeliveryOn: String(body.requestedDeliveryOn ?? ''),
      incoterm: String(body.incoterm ?? 'DAP'),
      serviceLevel: String(body.serviceLevel ?? 'STD'),
      deliveryAddressId: chosen.addresses[0].id,
      currency: 'GBP',
      lines: [{ id: `sol-${index}-1`, skuId: sku.id, skuCode: sku.code, description: sku.description, quantity, unitPriceGbp: sku.unitValueGbp, lineTotalGbp: lineTotal }],
      subtotalGbp: lineTotal,
      vatGbp: Math.round(lineTotal * 0.2 * 100) / 100,
      totalGbp: Math.round(lineTotal * 1.2 * 100) / 100,
      requiresApproval: lineTotal > 50_000,
      approvedByUserId: null,
      notes: String(body.notes ?? '')
    };
    state.salesOrders.push(order);
    setFlash(ctx, 'success', `Order ${order.reference} created.`);
    return ctx.redirect(`/orders/sales/${order.id}`);
  });

  definePage({
    path: '/orders/sales/:id', domain: 'orders', title: 'Sales order', kind: 'detail',
    view: (ctx, user) => {
      const order = findSales(ctx.params.id);
      if (!order) return { status: 404, title: 'Order not found', body: '<div class="panel"><div class="empty" data-testid="not-found">No order has that reference.</div></div>' };
      const cust = customer(order.customerId);
      const canApprove = can(user, 'order:approve');

      // FP_D24 — the dialog is built without aria-modal and the opener does not move
      // focus into it, so a screen-reader user is never told it opened.
      const approvalDialog = faults.on('FP_D24_MODAL_NOT_ANNOUNCED')
        ? `<div class="modal" id="approve-modal" data-testid="approve-modal" hidden>
<div class="modal-card"><div class="modal-head"><h2>Approve this order</h2>
<button type="button" class="icon-button" style="background:#eef2f9;color:var(--ink)" data-closes-modal="approve-modal">✕</button></div>
<form method="post" action="/orders/sales/${h(order.id)}/approve" data-testid="approve-form">
${csrfField(ctx)}
${field({ name: 'note', label: 'Approval note', type: 'textarea', testId: 'approve-note', attrs: { maxlength: '300' } })}
<button class="btn" type="submit" data-testid="approve-submit">Approve order</button>
</form></div></div>`
        : modal('approve-modal', 'Approve this order', `
<form method="post" action="/orders/sales/${h(order.id)}/approve" data-testid="approve-form">
${csrfField(ctx)}
${field({ name: 'note', label: 'Approval note', type: 'textarea', testId: 'approve-note', attrs: { maxlength: '300' } })}
<button class="btn" type="submit" data-testid="approve-submit">Approve order</button>
</form>`);

      return {
        title: `Order ${order.reference}`,
        breadcrumbs: [{ label: 'Orders', href: '/orders' }, { label: 'Sales orders', href: '/orders/sales' }, { label: order.reference }],
        actions: `<a class="btn btn-secondary" href="/orders/sales/${h(order.id)}/edit" data-testid="edit-order">Edit</a>
<a class="btn btn-secondary" href="/orders/sales/${h(order.id)}/lines" data-testid="view-lines">Lines</a>
${order.status === 'awaitingApproval' && canApprove
  ? `<button class="btn" type="button" data-opens-modal="approve-modal" data-testid="open-approve">Approve</button>` : ''}`,
        body: `
<div class="grid grid-2">
<div class="panel"><h3 style="margin-top:0">Order</h3>${kv([
  ['Reference', h(order.reference)],
  ['Customer', cust ? `<a href="/customers/${h(cust.id)}">${h(cust.name)}</a>` : '—'],
  ['Status', statusPill(order.status)],
  ['Placed', dateTime(order.placedAt)],
  ['Requested delivery', shortDate(order.requestedDeliveryOn)],
  ['Service level', `<code>${h(order.serviceLevel)}</code>`],
  ['Incoterm', `<code>${h(order.incoterm)}</code>`],
  ['Needs approval', order.requiresApproval ? 'Yes' : 'No']
])}</div>
<div class="panel"><h3 style="margin-top:0">Value</h3>${kv([
  ['Subtotal', money(order.subtotalGbp)],
  ['VAT', money(order.vatGbp)],
  ['Total', `<strong>${money(order.totalGbp)}</strong>`],
  ['Customer credit limit', cust ? money(cust.creditLimit) : '—'],
  ['Credit used', cust ? money(cust.creditUsed) : '—']
])}</div>
</div>
<div class="panel"><h3 style="margin-top:0">Lines</h3>
${table({
  caption: 'Order lines', testId: 'order-lines',
  columns: [
    { header: 'SKU', cell: row => `<code>${h(row.skuCode)}</code>` },
    { header: 'Description', cell: row => h(row.description) },
    { header: 'Quantity', cell: row => String(row.quantity) },
    { header: 'Unit price', cell: row => money(row.unitPriceGbp) },
    { header: 'Line total', cell: row => money(row.lineTotalGbp) }
  ],
  rows: order.lines
})}</div>
${order.notes ? `<div class="panel"><h3 style="margin-top:0">Notes</h3><p>${h(order.notes)}</p></div>` : ''}
${approvalDialog}`
      };
    }
  });

  app.post('/orders/sales/:id/approve', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const order = findSales(ctx.params.id);
    if (!order) return ctx.json(404, { error: 'not_found' });
    await ctx.body();
    // Correct: approval is permission-checked in the handler, not only in the page.
    if (!can(user, 'order:approve')) {
      setFlash(ctx, 'error', 'You do not have permission to approve orders.');
      return ctx.redirect(`/orders/sales/${order.id}`);
    }
    order.status = 'approved';
    order.approvedByUserId = user.id;
    setFlash(ctx, 'success', `${order.reference} approved.`);
    return ctx.redirect(`/orders/sales/${order.id}`);
  });

  definePage({
    path: '/orders/sales/:id/edit', domain: 'orders', title: 'Edit sales order', kind: 'form',
    view: (ctx) => {
      const order = findSales(ctx.params.id);
      if (!order) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Edit ${order.reference}`,
        breadcrumbs: [{ label: 'Orders', href: '/orders' }, { label: order.reference, href: `/orders/sales/${order.id}` }, { label: 'Edit' }],
        body: `<div class="panel" style="max-width:560px">
<form method="post" action="/orders/sales/${h(order.id)}/edit" data-testid="edit-order-form">
${csrfField(ctx)}
${field({ name: 'requestedDeliveryOn', label: 'Requested delivery date', type: 'date', value: order.requestedDeliveryOn, required: true, testId: 'edit-delivery-date' })}
${field({ name: 'serviceLevel', label: 'Service level', value: order.serviceLevel, testId: 'edit-service', options: state.SERVICE_LEVELS.map(s => ({ value: s.code, label: s.name })) })}
${field({ name: 'incoterm', label: 'Incoterm', value: order.incoterm, testId: 'edit-incoterm', options: state.INCOTERMS })}
${field({ name: 'notes', label: 'Notes', type: 'textarea', value: order.notes, testId: 'edit-notes', attrs: { maxlength: '500' } })}
<button class="btn" type="submit" data-testid="edit-order-save">Save changes</button>
</form></div>`
      };
    }
  });

  app.post('/orders/sales/:id/edit', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const order = findSales(ctx.params.id);
    if (!order) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();
    order.requestedDeliveryOn = String(body.requestedDeliveryOn ?? order.requestedDeliveryOn);
    order.serviceLevel = String(body.serviceLevel ?? order.serviceLevel);
    order.incoterm = String(body.incoterm ?? order.incoterm);
    order.notes = String(body.notes ?? '');
    setFlash(ctx, 'success', 'Order updated.');
    return ctx.redirect(`/orders/sales/${order.id}`);
  });

  definePage({
    path: '/orders/sales/:id/lines', domain: 'orders', title: 'Order lines', kind: 'list',
    view: (ctx) => {
      const order = findSales(ctx.params.id);
      if (!order) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Lines — ${order.reference}`,
        breadcrumbs: [{ label: 'Orders', href: '/orders' }, { label: order.reference, href: `/orders/sales/${order.id}` }, { label: 'Lines' }],
        body: `<div class="panel">
${table({
  caption: 'Lines on this order', testId: 'order-lines-full',
  columns: [
    { header: 'SKU', cell: row => `<code>${h(row.skuCode)}</code>` },
    { header: 'Description', cell: row => h(row.description) },
    { header: 'Quantity', cell: row => String(row.quantity) },
    { header: 'Unit price', cell: row => money(row.unitPriceGbp) },
    { header: 'Total', cell: row => money(row.lineTotalGbp) }
  ],
  rows: order.lines
})}
<h3>Add a line</h3>
<form method="post" action="/orders/sales/${h(order.id)}/lines" data-testid="add-line-form">
${csrfField(ctx)}
${field({ name: 'skuId', label: 'Product', required: true, testId: 'line-sku',
  options: [{ value: '', label: 'Choose a product' }, ...state.skus.map(s => ({ value: s.id, label: `${s.code} — ${s.description}` }))] })}
${field({ name: 'quantity', label: 'Quantity', type: 'number', required: true, testId: 'line-quantity', attrs: { min: '1', max: '10000' } })}
<button class="btn" type="submit" data-testid="add-line">Add line</button>
</form></div>`
      };
    }
  });

  app.post('/orders/sales/:id/lines', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const order = findSales(ctx.params.id);
    if (!order) return ctx.json(404, { error: 'not_found' });
    const body = await ctx.body();
    const quantity = Number(body.quantity);
    const sku = state.skus.find(s => s.id === body.skuId);
    if (!sku || !Number.isInteger(quantity) || quantity < 1) {
      setFlash(ctx, 'error', 'Choose a product and a whole quantity of at least 1.');
      return ctx.redirect(`/orders/sales/${order.id}/lines`);
    }
    const lineTotal = Math.round(quantity * sku.unitValueGbp * 100) / 100;
    order.lines.push({ id: `sol-${order.id}-${order.lines.length + 1}`, skuId: sku.id, skuCode: sku.code, description: sku.description, quantity, unitPriceGbp: sku.unitValueGbp, lineTotalGbp: lineTotal });
    order.subtotalGbp = Math.round(order.lines.reduce((sum, l) => sum + l.lineTotalGbp, 0) * 100) / 100;
    order.vatGbp = Math.round(order.subtotalGbp * 0.2 * 100) / 100;
    order.totalGbp = Math.round((order.subtotalGbp + order.vatGbp) * 100) / 100;
    setFlash(ctx, 'success', 'Line added.');
    return ctx.redirect(`/orders/sales/${order.id}/lines`);
  });

  // ---- purchase orders ----------------------------------------------------

  definePage({
    path: '/orders/purchase', domain: 'orders', title: 'Purchase orders', kind: 'list',
    view: (ctx) => {
      const { page, size } = listParams(ctx);
      const { slice, pageCount } = paginate(state.purchaseOrders, page, size);
      return {
        title: 'Purchase orders',
        breadcrumbs: [{ label: 'Orders', href: '/orders' }, { label: 'Purchase orders' }],
        actions: `<a class="btn" href="/orders/purchase/new" data-testid="new-po">New purchase order</a>`,
        body: `${table({
          caption: 'Purchase orders', testId: 'purchase-orders-table',
          columns: [
            { header: 'Reference', cell: row => `<a href="/orders/purchase/${h(row.id)}">${h(row.reference)}</a>` },
            { header: 'Supplier', cell: row => h(row.supplierName) },
            { header: 'Warehouse', cell: row => h(state.warehouses.find(w => w.id === row.warehouseId)?.name ?? '—') },
            { header: 'Raised', cell: row => shortDate(row.raisedAt) },
            { header: 'Expected', cell: row => shortDate(row.expectedOn) },
            { header: 'Total', cell: row => money(row.totalGbp) },
            { header: 'Status', cell: row => statusPill(row.status) }
          ],
          rows: slice
        })}
${pagination('/orders/purchase', page, pageCount)}`
      };
    }
  });

  definePage({
    path: '/orders/purchase/new', domain: 'orders', title: 'New purchase order', kind: 'form',
    view: (ctx) => ({
      title: 'New purchase order',
      breadcrumbs: [{ label: 'Orders', href: '/orders' }, { label: 'Purchase orders', href: '/orders/purchase' }, { label: 'New' }],
      body: `<div class="panel" style="max-width:560px">
<form method="post" action="/orders/purchase/new" data-testid="new-po-form">
${csrfField(ctx)}
${field({ name: 'supplierName', label: 'Supplier', required: true, testId: 'po-supplier', attrs: { maxlength: '120' } })}
${field({ name: 'warehouseId', label: 'Deliver to warehouse', required: true, testId: 'po-warehouse',
  options: [{ value: '', label: 'Choose a warehouse' }, ...state.warehouses.map(w => ({ value: w.id, label: w.name }))] })}
${field({ name: 'expectedOn', label: 'Expected date', type: 'date', required: true, testId: 'po-expected' })}
${field({ name: 'skuId', label: 'Product', required: true, testId: 'po-sku',
  options: [{ value: '', label: 'Choose a product' }, ...state.skus.map(s => ({ value: s.id, label: `${s.code} — ${s.description}` }))] })}
${field({ name: 'quantity', label: 'Quantity', type: 'number', required: true, testId: 'po-quantity', attrs: { min: '1', max: '100000' } })}
<button class="btn" type="submit" data-testid="po-submit">Raise purchase order</button>
</form></div>`
    })
  });

  app.post('/orders/purchase/new', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    const quantity = Number(body.quantity);
    const sku = state.skus.find(s => s.id === body.skuId);
    if (!String(body.supplierName ?? '').trim() || !sku || !Number.isInteger(quantity) || quantity < 1) {
      setFlash(ctx, 'error', 'A supplier, a product and a whole quantity are required.');
      return ctx.redirect('/orders/purchase/new');
    }
    const index = state.purchaseOrders.length;
    const unitCost = Math.round(sku.unitValueGbp * 0.6 * 100) / 100;
    const order = {
      id: `po-${String(index + 1).padStart(4, '0')}`,
      reference: `PO-2026-${String(800 + index)}`,
      supplierName: String(body.supplierName).trim(),
      warehouseId: String(body.warehouseId),
      status: 'sent',
      raisedAt: new Date().toISOString(),
      expectedOn: String(body.expectedOn),
      lines: [{ id: `pol-${index}-1`, skuId: sku.id, skuCode: sku.code, description: sku.description, quantityOrdered: quantity, quantityReceived: 0, unitCostGbp: unitCost }],
      totalGbp: Math.round(quantity * unitCost * 100) / 100
    };
    state.purchaseOrders.push(order);
    setFlash(ctx, 'success', `${order.reference} raised.`);
    return ctx.redirect(`/orders/purchase/${order.id}`);
  });

  definePage({
    path: '/orders/purchase/:id', domain: 'orders', title: 'Purchase order', kind: 'detail',
    view: (ctx) => {
      const order = findPurchase(ctx.params.id);
      if (!order) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty" data-testid="not-found">Not found.</div></div>' };
      return {
        title: `Purchase order ${order.reference}`,
        breadcrumbs: [{ label: 'Orders', href: '/orders' }, { label: 'Purchase orders', href: '/orders/purchase' }, { label: order.reference }],
        actions: `<a class="btn" href="/warehouse/receiving?po=${h(order.id)}" data-testid="receive-po">Receive</a>`,
        body: `<div class="panel">${kv([
  ['Supplier', h(order.supplierName)],
  ['Warehouse', h(state.warehouses.find(w => w.id === order.warehouseId)?.name ?? '—')],
  ['Status', statusPill(order.status)],
  ['Raised', shortDate(order.raisedAt)],
  ['Expected', shortDate(order.expectedOn)],
  ['Total', money(order.totalGbp)]
])}</div>
<div class="panel"><h3 style="margin-top:0">Lines</h3>
${table({
  caption: 'Lines on this purchase order', testId: 'po-lines',
  columns: [
    { header: 'SKU', cell: row => `<code>${h(row.skuCode)}</code>` },
    { header: 'Description', cell: row => h(row.description) },
    { header: 'Ordered', cell: row => String(row.quantityOrdered) },
    { header: 'Received', cell: row => String(row.quantityReceived) },
    { header: 'Outstanding', cell: row => String(row.quantityOrdered - row.quantityReceived) },
    { header: 'Unit cost', cell: row => money(row.unitCostGbp) }
  ],
  rows: order.lines
})}</div>`
      };
    }
  });

  definePage({
    path: '/orders/approvals', domain: 'orders', title: 'Orders awaiting approval', kind: 'list',
    view: () => {
      const rows = state.salesOrders.filter(o => o.status === 'awaitingApproval');
      return {
        title: 'Orders awaiting approval',
        breadcrumbs: [{ label: 'Orders', href: '/orders' }, { label: 'Approvals' }],
        body: `<div class="panel">
<p class="hint">Orders above ${money(50_000)} need a second pair of eyes.</p>
${table({
  caption: 'Orders awaiting approval', testId: 'approvals-table', empty: 'Nothing is waiting for approval.',
  columns: [
    { header: 'Reference', cell: row => `<a href="/orders/sales/${h(row.id)}">${h(row.reference)}</a>` },
    { header: 'Customer', cell: row => h(customer(row.customerId)?.name ?? '—') },
    { header: 'Placed', cell: row => shortDate(row.placedAt) },
    { header: 'Total', cell: row => money(row.totalGbp) },
    { header: 'Customer status', cell: row => statusPill(customer(row.customerId)?.status ?? 'active') }
  ],
  rows
})}</div>`
      };
    }
  });

  definePage({
    path: '/orders/backorders', domain: 'orders', title: 'Backorders', kind: 'list',
    view: () => {
      const rows = state.salesOrders.filter(order => order.lines.some(line => {
        const available = state.stock.filter(s => s.skuId === line.skuId).reduce((sum, s) => sum + s.available, 0);
        return available < line.quantity;
      }));
      return {
        title: 'Backorders',
        breadcrumbs: [{ label: 'Orders', href: '/orders' }, { label: 'Backorders' }],
        body: `<div class="panel">
<p class="hint">Orders with at least one line that cannot be filled from available stock.</p>
${table({
  caption: 'Orders that cannot be filled completely', testId: 'backorders-table', empty: 'Every open order can be filled.',
  columns: [
    { header: 'Reference', cell: row => `<a href="/orders/sales/${h(row.id)}">${h(row.reference)}</a>` },
    { header: 'Customer', cell: row => h(customer(row.customerId)?.name ?? '—') },
    { header: 'Requested', cell: row => shortDate(row.requestedDeliveryOn) },
    { header: 'Short lines', cell: row => String(row.lines.filter(line => {
        const available = state.stock.filter(s => s.skuId === line.skuId).reduce((sum, s) => sum + s.available, 0);
        return available < line.quantity;
      }).length) },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows
})}</div>`
      };
    }
  });
}
