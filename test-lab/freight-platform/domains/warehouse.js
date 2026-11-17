/**
 * Warehouse: locations, stock, movements and the four floor operations.
 *
 *   FP_D01  an adjustment can drive on-hand below zero
 *   FP_D21  the adjustment quantity input has no label
 *   FP_D29  the adjustment form carries no anti-forgery token
 *
 * All three live on the same screen on purpose. The screen that changes inventory is the
 * one worth getting wrong, and in real systems the quick internal tool is exactly where
 * the label, the token and the bound all go missing together.
 */
import { h, table, field, statusPill, shortDate, dateTime, money, kv, tabs, pagination, stat } from '../ui/chrome.js';

export const SCREENS = [
  { path: '/warehouse', title: 'Warehouse', kind: 'dashboard' },
  { path: '/warehouse/locations', title: 'Locations', kind: 'list' },
  { path: '/warehouse/locations/:id', title: 'Location', kind: 'detail' },
  { path: '/warehouse/zones', title: 'Zones and bins', kind: 'list' },
  { path: '/warehouse/stock', title: 'Stock', kind: 'list' },
  { path: '/warehouse/stock/:id', title: 'Stock record', kind: 'detail' },
  { path: '/warehouse/stock/:id/adjust', title: 'Adjust stock', kind: 'form' },
  { path: '/warehouse/transfers', title: 'Stock transfers', kind: 'list' },
  { path: '/warehouse/transfers/new', title: 'New transfer', kind: 'form' },
  { path: '/warehouse/cycle-count', title: 'Cycle count', kind: 'form' },
  { path: '/warehouse/receiving', title: 'Receiving', kind: 'form' },
  { path: '/warehouse/putaway', title: 'Putaway', kind: 'list' },
  { path: '/warehouse/picking', title: 'Picking', kind: 'list' },
  { path: '/warehouse/packing', title: 'Packing', kind: 'form' }
];

/** Movements recorded during a run, so an adjustment is observable afterwards. */
const movements = [];
const transfers = [];

export default function registerWarehouse({ app, core, state, faults }) {
  const { definePage, csrfField, csrfValid, setFlash, listParams, paginate } = core;

  const sku = id => state.skus.find(s => s.id === id);
  const warehouse = id => state.warehouses.find(w => w.id === id);
  const zone = id => state.zones.find(z => z.id === id);
  const findStock = id => state.stock.find(s => s.id === id);

  for (const screen of SCREENS) {
    if (screen.path.startsWith('/warehouse/stock/:id')) screen.sample = screen.path.replace(':id', state.stock[0].id);
    if (screen.path.startsWith('/warehouse/locations/:id')) screen.sample = screen.path.replace(':id', state.warehouses[0].id);
  }

  definePage({
    path: '/warehouse', domain: 'warehouse', title: 'Warehouse', kind: 'dashboard',
    view: () => {
      const belowReorder = state.stock.filter(s => s.available < s.reorderPoint);
      const expiring = state.stock.filter(s => s.expiresOn);
      const negative = state.stock.filter(s => s.onHand < 0);
      return {
        title: 'Warehouse',
        actions: `<a class="btn" href="/warehouse/receiving" data-testid="go-receiving">Receiving</a>
                  <a class="btn btn-secondary" href="/warehouse/cycle-count" data-testid="go-cycle-count">Cycle count</a>`,
        body: `<div class="grid grid-4" style="margin-bottom:16px">
${stat(state.stock.length, 'Stock records', 'stat-stock-records')}
${stat(belowReorder.length, 'Below reorder point', 'stat-below-reorder')}
${stat(expiring.length, 'With an expiry date', 'stat-expiring')}
${stat(negative.length, 'Negative on hand', 'stat-negative')}
</div>
<div class="panel"><h2 style="margin-top:0">Sites</h2>
${table({
  caption: 'Warehouse sites and their capacity', testId: 'warehouse-sites',
  columns: [
    { header: 'Site', cell: row => `<a href="/warehouse/locations/${h(row.id)}">${h(row.name)}</a>` },
    { header: 'Code', cell: row => `<code>${h(row.code)}</code>` },
    { header: 'Country', cell: row => h(row.countryCode) },
    { header: 'Capacity', cell: row => `${row.capacityPallets.toLocaleString('en-GB')} pallets` },
    { header: 'Used', cell: row => `${row.usedPallets.toLocaleString('en-GB')} (${Math.round((row.usedPallets / row.capacityPallets) * 100)}%)` },
    { header: 'Bonded', cell: row => row.bondedStore ? 'Yes' : 'No' },
    { header: 'Chilled', cell: row => row.temperatureControlled ? 'Yes' : 'No' }
  ],
  rows: state.warehouses
})}</div>
<div class="panel"><h2 style="margin-top:0">Below reorder point</h2>
${table({
  caption: 'Stock below its reorder point', testId: 'below-reorder-table', empty: 'Everything is above its reorder point.',
  columns: [
    { header: 'SKU', cell: row => `<a href="/warehouse/stock/${h(row.id)}"><code>${h(sku(row.skuId)?.code ?? '')}</code></a>` },
    { header: 'Description', cell: row => h(sku(row.skuId)?.description ?? '') },
    { header: 'Site', cell: row => h(warehouse(row.warehouseId)?.code ?? '') },
    { header: 'Available', cell: row => String(row.available) },
    { header: 'Reorder at', cell: row => String(row.reorderPoint) }
  ],
  rows: belowReorder.slice(0, 12)
})}</div>`
      };
    }
  });

  definePage({
    path: '/warehouse/locations', domain: 'warehouse', title: 'Locations', kind: 'list',
    view: () => ({
      title: 'Locations',
      breadcrumbs: [{ label: 'Warehouse', href: '/warehouse' }, { label: 'Locations' }],
      body: `<div class="panel">${table({
        caption: 'Warehouse locations', testId: 'locations-table',
        columns: [
          { header: 'Name', cell: row => `<a href="/warehouse/locations/${h(row.id)}">${h(row.name)}</a>` },
          { header: 'Code', cell: row => `<code>${h(row.code)}</code>` },
          { header: 'Country', cell: row => h(row.countryCode) },
          { header: 'Zones', cell: row => String(state.zones.filter(z => z.warehouseId === row.id).length) },
          { header: 'Utilisation', cell: row => `${Math.round((row.usedPallets / row.capacityPallets) * 100)}%` }
        ],
        rows: state.warehouses
      })}</div>`
    })
  });

  definePage({
    path: '/warehouse/locations/:id', domain: 'warehouse', title: 'Location', kind: 'detail',
    view: (ctx) => {
      const site = warehouse(ctx.params.id);
      if (!site) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty" data-testid="not-found">No such location.</div></div>' };
      const siteZones = state.zones.filter(z => z.warehouseId === site.id);
      const siteStock = state.stock.filter(s => s.warehouseId === site.id);
      return {
        title: site.name,
        breadcrumbs: [{ label: 'Warehouse', href: '/warehouse' }, { label: 'Locations', href: '/warehouse/locations' }, { label: site.name }],
        body: tabs('location', [
          { key: 'summary', label: 'Summary', body: `<div class="panel">${kv([
            ['Code', `<code>${h(site.code)}</code>`],
            ['Country', h(site.countryCode)],
            ['Capacity', `${site.capacityPallets.toLocaleString('en-GB')} pallets`],
            ['In use', `${site.usedPallets.toLocaleString('en-GB')} pallets`],
            ['Bonded store', site.bondedStore ? 'Yes' : 'No'],
            ['Temperature controlled', site.temperatureControlled ? 'Yes' : 'No'],
            ['Zones', String(siteZones.length)],
            ['Stock records', String(siteStock.length)]
          ])}</div>` },
          { key: 'zones', label: `Zones (${siteZones.length})`, body: `<div class="panel">${table({
            caption: 'Zones at this site', testId: 'location-zones',
            columns: [
              { header: 'Zone', cell: row => h(row.name) },
              { header: 'Code', cell: row => `<code>${h(row.code)}</code>` },
              { header: 'Bins', cell: row => String(row.binCount) },
              { header: 'Temperature', cell: row => row.temperatureMinC === null ? 'Ambient' : `${row.temperatureMinC}°C to ${row.temperatureMaxC}°C` }
            ],
            rows: siteZones
          })}</div>` },
          { key: 'stock', label: `Stock (${siteStock.length})`, body: `<div class="panel">${table({
            caption: 'Stock held at this site', testId: 'location-stock', empty: 'No stock held here.',
            columns: [
              { header: 'SKU', cell: row => `<a href="/warehouse/stock/${h(row.id)}"><code>${h(sku(row.skuId)?.code ?? '')}</code></a>` },
              { header: 'Bin', cell: row => `<code>${h(row.bin)}</code>` },
              { header: 'On hand', cell: row => String(row.onHand) },
              { header: 'Allocated', cell: row => String(row.allocated) },
              { header: 'Available', cell: row => String(row.available) }
            ],
            rows: siteStock
          })}</div>` }
        ])
      };
    }
  });

  definePage({
    path: '/warehouse/zones', domain: 'warehouse', title: 'Zones and bins', kind: 'list',
    view: () => ({
      title: 'Zones and bins',
      breadcrumbs: [{ label: 'Warehouse', href: '/warehouse' }, { label: 'Zones' }],
      body: `<div class="panel">${table({
        caption: 'Every zone across all sites', testId: 'zones-table',
        columns: [
          { header: 'Site', cell: row => h(warehouse(row.warehouseId)?.name ?? '') },
          { header: 'Zone', cell: row => h(row.name) },
          { header: 'Code', cell: row => `<code>${h(row.code)}</code>` },
          { header: 'Bins', cell: row => String(row.binCount) },
          { header: 'Temperature', cell: row => row.temperatureMinC === null ? 'Ambient' : `${row.temperatureMinC}–${row.temperatureMaxC}°C` }
        ],
        rows: state.zones
      })}</div>`
    })
  });

  definePage({
    path: '/warehouse/stock', domain: 'warehouse', title: 'Stock', kind: 'list',
    view: (ctx) => {
      const { page, size, q } = listParams(ctx);
      const site = String(ctx.query.site ?? '');
      let rows = state.stock;
      if (site) rows = rows.filter(s => s.warehouseId === site);
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter(s => (sku(s.skuId)?.code ?? '').toLowerCase().includes(needle) ||
          (sku(s.skuId)?.description ?? '').toLowerCase().includes(needle) ||
          s.bin.toLowerCase().includes(needle));
      }
      const { slice, pageCount } = paginate(rows, page, size);
      return {
        title: 'Stock',
        breadcrumbs: [{ label: 'Warehouse', href: '/warehouse' }, { label: 'Stock' }],
        body: `<form method="get" action="/warehouse/stock" class="filters" data-testid="stock-filters">
${field({ name: 'q', label: 'Search', type: 'search', value: q, testId: 'stock-search', hint: 'SKU code, description or bin.' })}
${field({ name: 'site', label: 'Site', value: site, testId: 'stock-site',
  options: [{ value: '', label: 'All sites' }, ...state.warehouses.map(w => ({ value: w.id, label: w.name }))] })}
<button class="btn" type="submit" data-testid="stock-apply">Apply</button></form>
${table({
  caption: 'Stock records', testId: 'stock-table', empty: 'No stock matches.',
  columns: [
    { header: 'SKU', cell: row => `<a href="/warehouse/stock/${h(row.id)}" data-testid="stock-${h(row.id)}"><code>${h(sku(row.skuId)?.code ?? '')}</code></a>` },
    { header: 'Description', cell: row => h(sku(row.skuId)?.description ?? '') },
    { header: 'Site', cell: row => h(warehouse(row.warehouseId)?.code ?? '') },
    { header: 'Bin', cell: row => `<code>${h(row.bin)}</code>` },
    { header: 'On hand', cell: row => row.onHand < 0
      ? `<strong style="color:var(--danger)">${row.onHand}</strong>` : String(row.onHand) },
    { header: 'Allocated', cell: row => String(row.allocated) },
    { header: 'Available', cell: row => String(row.available) },
    { header: 'Batch', cell: row => `<code>${h(row.batchNumber)}</code>` },
    { header: 'Expires', cell: row => shortDate(row.expiresOn) }
  ],
  rows: slice
})}
${pagination('/warehouse/stock', page, pageCount, { q, site })}`
      };
    }
  });

  definePage({
    path: '/warehouse/stock/:id', domain: 'warehouse', title: 'Stock record', kind: 'detail',
    view: (ctx) => {
      const record = findStock(ctx.params.id);
      if (!record) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty" data-testid="not-found">No such stock record.</div></div>' };
      const product = sku(record.skuId);
      const recordMovements = movements.filter(m => m.stockId === record.id);
      return {
        title: `${product?.code ?? 'Stock'} at ${warehouse(record.warehouseId)?.code ?? ''}`,
        breadcrumbs: [{ label: 'Warehouse', href: '/warehouse' }, { label: 'Stock', href: '/warehouse/stock' }, { label: product?.code ?? record.id }],
        actions: `<a class="btn" href="/warehouse/stock/${h(record.id)}/adjust" data-testid="adjust-stock">Adjust</a>`,
        body: `<div class="grid grid-4" style="margin-bottom:14px">
${stat(String(record.onHand), 'On hand', 'detail-on-hand')}
${stat(String(record.allocated), 'Allocated', 'detail-allocated')}
${stat(String(record.available), 'Available', 'detail-available')}
${stat(String(record.reorderPoint), 'Reorder point', 'detail-reorder')}
</div>
<div class="grid grid-2">
<div class="panel"><h3 style="margin-top:0">Product</h3>${kv([
  ['Code', `<code>${h(product?.code ?? '')}</code>`],
  ['Description', h(product?.description ?? '')],
  ['HS code', `<code>${h(product?.hsCode ?? '')}</code>`],
  ['Unit of measure', h(product?.unitOfMeasure ?? '')],
  ['Weight', `${product?.weightKg ?? 0} kg`],
  ['Volume', `${product?.volumeM3 ?? 0} m³`],
  ['Hazardous', product?.hazardous ? 'Yes' : 'No'],
  ['Perishable', product?.perishable ? 'Yes' : 'No']
])}</div>
<div class="panel"><h3 style="margin-top:0">Location</h3>${kv([
  ['Site', h(warehouse(record.warehouseId)?.name ?? '')],
  ['Zone', h(zone(record.zoneId)?.name ?? '')],
  ['Bin', `<code>${h(record.bin)}</code>`],
  ['Batch', `<code>${h(record.batchNumber)}</code>`],
  ['Expires', shortDate(record.expiresOn)],
  ['Last counted', dateTime(record.lastCountedAt)]
])}</div>
</div>
<div class="panel"><h3 style="margin-top:0">Movements in this session</h3>
${table({
  caption: 'Adjustments made to this record', testId: 'stock-movements', empty: 'No movements recorded in this session.',
  columns: [
    { header: 'When', cell: row => dateTime(row.at) },
    { header: 'Delta', cell: row => row.delta > 0 ? `+${row.delta}` : String(row.delta) },
    { header: 'Reason', cell: row => h(row.reason) },
    { header: 'Resulting on hand', cell: row => String(row.resulting) },
    { header: 'By', cell: row => h(row.by) }
  ],
  rows: recordMovements
})}</div>`
      };
    }
  });

  // ---- the adjustment screen, carrying three defects ----------------------

  definePage({
    path: '/warehouse/stock/:id/adjust', domain: 'warehouse', title: 'Adjust stock', kind: 'form',
    view: (ctx) => {
      const record = findStock(ctx.params.id);
      if (!record) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">No such stock record.</div></div>' };
      const product = sku(record.skuId);

      const noLabel = faults.on('FP_D21_UNLABELLED_ADJUSTMENT_FIELD');
      const noCsrf = faults.on('FP_D29_NO_CSRF_ON_ADJUSTMENT');

      // FP_D21 — the quantity control carries a placeholder and nothing else. Rendered
      // by hand rather than through field() so the omission is real rather than a flag.
      const quantityControl = noLabel
        ? `<div class="field">
<input type="number" id="f-delta" name="delta" data-testid="delta" required
  placeholder="Quantity to add or remove" step="1" min="-100000" max="100000" />
<div class="hint">Use a negative number to remove stock.</div>
</div>`
        : field({
            name: 'delta', label: 'Quantity to add or remove', type: 'number', required: true, testId: 'delta',
            attrs: { step: '1', min: '-100000', max: '100000' },
            hint: 'Use a negative number to remove stock.'
          });

      return {
        title: `Adjust ${product?.code ?? 'stock'}`,
        breadcrumbs: [
          { label: 'Warehouse', href: '/warehouse' },
          { label: 'Stock', href: '/warehouse/stock' },
          { label: product?.code ?? record.id, href: `/warehouse/stock/${record.id}` },
          { label: 'Adjust' }
        ],
        body: `<div class="panel" style="max-width:520px">
<p class="hint">On hand is currently <strong data-testid="current-on-hand">${record.onHand}</strong>,
of which ${record.allocated} is allocated.</p>
<form method="post" action="/warehouse/stock/${h(record.id)}/adjust" data-testid="adjust-form">
${noCsrf ? '' : csrfField(ctx)}
${quantityControl}
${field({ name: 'reason', label: 'Reason', required: true, testId: 'reason',
  options: ['', 'Cycle count correction', 'Damage', 'Found', 'Theft or loss', 'Supplier shortage', 'System correction']
    .map(value => ({ value, label: value || 'Choose a reason' })) })}
${field({ name: 'note', label: 'Note', type: 'textarea', testId: 'note', attrs: { maxlength: '300' } })}
<button class="btn" type="submit" data-testid="adjust-submit">Apply adjustment</button>
<a class="btn btn-secondary" href="/warehouse/stock/${h(record.id)}">Cancel</a>
</form></div>`
      };
    }
  });

  app.post('/warehouse/stock/:id/adjust', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const record = findStock(ctx.params.id);
    if (!record) return ctx.json(404, { error: 'not_found' });

    const body = await ctx.body();

    // FP_D29 — with the defect off the token is required, which is what every other write
    // form in the application does.
    if (!faults.on('FP_D29_NO_CSRF_ON_ADJUSTMENT') && !await csrfValid(ctx)) {
      setFlash(ctx, 'error', 'That form expired. Open the adjustment again.');
      return ctx.redirect(`/warehouse/stock/${record.id}/adjust`);
    }

    const delta = Number(body.delta);
    if (!Number.isInteger(delta) || delta === 0) {
      setFlash(ctx, 'error', 'Enter a whole number other than zero.');
      return ctx.redirect(`/warehouse/stock/${record.id}/adjust`);
    }
    if (!String(body.reason ?? '').trim()) {
      setFlash(ctx, 'error', 'Choose a reason for the adjustment.');
      return ctx.redirect(`/warehouse/stock/${record.id}/adjust`);
    }

    // FP_D01 — with the defect off, an adjustment that would take on-hand below zero is
    // refused. With it on, the delta is applied whatever it does to the balance.
    if (!faults.on('FP_D01_NEGATIVE_STOCK_ADJUSTMENT') && record.onHand + delta < 0) {
      setFlash(ctx, 'error', `That would leave ${record.onHand + delta} on hand. Stock cannot go below zero.`);
      return ctx.redirect(`/warehouse/stock/${record.id}/adjust`);
    }

    record.onHand += delta;
    record.available = record.onHand - record.allocated;
    movements.push({
      stockId: record.id, at: new Date().toISOString(), delta,
      reason: String(body.reason), resulting: record.onHand, by: user.displayName
    });

    setFlash(ctx, 'success', `Stock adjusted by ${delta > 0 ? '+' : ''}${delta}. On hand is now ${record.onHand}.`);
    return ctx.redirect(`/warehouse/stock/${record.id}`);
  });

  // ---- transfers ----------------------------------------------------------

  definePage({
    path: '/warehouse/transfers', domain: 'warehouse', title: 'Stock transfers', kind: 'list',
    view: () => ({
      title: 'Stock transfers',
      breadcrumbs: [{ label: 'Warehouse', href: '/warehouse' }, { label: 'Transfers' }],
      actions: `<a class="btn" href="/warehouse/transfers/new" data-testid="new-transfer">New transfer</a>`,
      body: `<div class="panel">${table({
        caption: 'Stock transfers between sites', testId: 'transfers-table',
        empty: 'No transfers have been raised in this session.',
        columns: [
          { header: 'Raised', cell: row => dateTime(row.at) },
          { header: 'SKU', cell: row => `<code>${h(row.skuCode)}</code>` },
          { header: 'From', cell: row => h(row.from) },
          { header: 'To', cell: row => h(row.to) },
          { header: 'Quantity', cell: row => String(row.quantity) },
          { header: 'Status', cell: row => statusPill(row.status) }
        ],
        rows: transfers
      })}</div>`
    })
  });

  definePage({
    path: '/warehouse/transfers/new', domain: 'warehouse', title: 'New transfer', kind: 'form',
    view: (ctx) => ({
      title: 'New transfer',
      breadcrumbs: [{ label: 'Warehouse', href: '/warehouse' }, { label: 'Transfers', href: '/warehouse/transfers' }, { label: 'New' }],
      body: `<div class="panel" style="max-width:560px">
<form method="post" action="/warehouse/transfers/new" data-testid="transfer-form">
${csrfField(ctx)}
${field({ name: 'skuId', label: 'Product', required: true, testId: 'transfer-sku',
  options: [{ value: '', label: 'Choose a product' }, ...state.skus.map(s => ({ value: s.id, label: `${s.code} — ${s.description}` }))] })}
${field({ name: 'fromWarehouseId', label: 'From site', required: true, testId: 'transfer-from',
  options: [{ value: '', label: 'Choose a site' }, ...state.warehouses.map(w => ({ value: w.id, label: w.name }))] })}
${field({ name: 'toWarehouseId', label: 'To site', required: true, testId: 'transfer-to',
  options: [{ value: '', label: 'Choose a site' }, ...state.warehouses.map(w => ({ value: w.id, label: w.name }))] })}
${field({ name: 'quantity', label: 'Quantity', type: 'number', required: true, testId: 'transfer-quantity', attrs: { min: '1', max: '100000' } })}
${field({ name: 'reason', label: 'Reason', type: 'textarea', testId: 'transfer-reason', attrs: { maxlength: '300' } })}
<button class="btn" type="submit" data-testid="transfer-submit">Raise transfer</button>
</form></div>`
    })
  });

  app.post('/warehouse/transfers/new', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    const quantity = Number(body.quantity);
    const product = sku(String(body.skuId ?? ''));
    // Correct: a transfer to the same site is refused, and the quantity is bounded.
    if (!product || !Number.isInteger(quantity) || quantity < 1) {
      setFlash(ctx, 'error', 'Choose a product and a whole quantity of at least 1.');
      return ctx.redirect('/warehouse/transfers/new');
    }
    if (body.fromWarehouseId === body.toWarehouseId) {
      setFlash(ctx, 'error', 'A transfer must move stock between two different sites.');
      return ctx.redirect('/warehouse/transfers/new');
    }
    transfers.push({
      at: new Date().toISOString(), skuCode: product.code, quantity, status: 'planned',
      from: warehouse(String(body.fromWarehouseId))?.name ?? '—',
      to: warehouse(String(body.toWarehouseId))?.name ?? '—'
    });
    setFlash(ctx, 'success', 'Transfer raised.');
    return ctx.redirect('/warehouse/transfers');
  });

  // ---- floor operations ---------------------------------------------------

  definePage({
    path: '/warehouse/cycle-count', domain: 'warehouse', title: 'Cycle count', kind: 'form',
    view: (ctx) => {
      const due = state.stock.slice(0, 10);
      return {
        title: 'Cycle count',
        breadcrumbs: [{ label: 'Warehouse', href: '/warehouse' }, { label: 'Cycle count' }],
        body: `<div class="panel">
<p class="hint">Enter the counted quantity against each bin. A difference raises an adjustment for approval.</p>
<form method="post" action="/warehouse/cycle-count" data-testid="cycle-count-form">
${csrfField(ctx)}
${table({
  caption: 'Bins due a count', testId: 'cycle-count-table',
  columns: [
    { header: 'SKU', cell: row => `<code>${h(sku(row.skuId)?.code ?? '')}</code>` },
    { header: 'Bin', cell: row => `<code>${h(row.bin)}</code>` },
    { header: 'System says', cell: row => String(row.onHand) },
    { header: 'Last counted', cell: row => shortDate(row.lastCountedAt) },
    { header: 'Counted', cell: row => `<input type="number" name="count_${h(row.id)}" min="0" max="100000" step="1"
        data-testid="count-${h(row.id)}" aria-label="Counted quantity for ${h(sku(row.skuId)?.code ?? '')} in bin ${h(row.bin)}" style="width:110px" />` }
  ],
  rows: due
})}
<button class="btn" type="submit" style="margin-top:12px" data-testid="cycle-count-submit">Submit count</button>
</form></div>`
      };
    }
  });

  app.post('/warehouse/cycle-count', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    const counted = Object.entries(body).filter(([key, value]) => key.startsWith('count_') && String(value).trim() !== '');
    if (!counted.length) {
      setFlash(ctx, 'error', 'Enter at least one counted quantity.');
      return ctx.redirect('/warehouse/cycle-count');
    }
    setFlash(ctx, 'success', `${counted.length} bin(s) counted. Differences raised for approval.`);
    return ctx.redirect('/warehouse/cycle-count');
  });

  definePage({
    path: '/warehouse/receiving', domain: 'warehouse', title: 'Receiving', kind: 'form',
    view: (ctx) => {
      const expected = state.purchaseOrders.filter(o => ['sent', 'partiallyReceived'].includes(o.status));
      const preselected = String(ctx.query.po ?? '');
      return {
        title: 'Receiving',
        breadcrumbs: [{ label: 'Warehouse', href: '/warehouse' }, { label: 'Receiving' }],
        body: `<div class="panel">
<p class="hint">${expected.length} purchase order(s) are expected.</p>
<form method="post" action="/warehouse/receiving" data-testid="receiving-form">
${csrfField(ctx)}
${field({ name: 'purchaseOrderId', label: 'Purchase order', required: true, value: preselected, testId: 'receiving-po',
  options: [{ value: '', label: 'Choose a purchase order' }, ...expected.map(o => ({ value: o.id, label: `${o.reference} — ${o.supplierName}` }))] })}
${field({ name: 'quantityReceived', label: 'Quantity received', type: 'number', required: true, testId: 'receiving-quantity', attrs: { min: '1', max: '100000' } })}
${field({ name: 'condition', label: 'Condition on arrival', required: true, testId: 'receiving-condition',
  options: ['Good', 'Damaged packaging', 'Damaged goods', 'Short'] })}
${field({ name: 'bin', label: 'Received into bin', required: true, testId: 'receiving-bin', attrs: { maxlength: '20', pattern: '[A-Z]{3}-Z[0-9]-[0-9]{3}' },
  hint: 'Format: FXT-Z1-004' })}
<button class="btn" type="submit" data-testid="receiving-submit">Record receipt</button>
</form></div>`
      };
    }
  });

  app.post('/warehouse/receiving', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    const order = state.purchaseOrders.find(o => o.id === body.purchaseOrderId);
    const quantity = Number(body.quantityReceived);
    if (!order || !Number.isInteger(quantity) || quantity < 1) {
      setFlash(ctx, 'error', 'Choose a purchase order and a whole quantity of at least 1.');
      return ctx.redirect('/warehouse/receiving');
    }
    const line = order.lines[0];
    const outstanding = line.quantityOrdered - line.quantityReceived;
    // Correct: over-receipt against the order is refused.
    if (quantity > outstanding) {
      setFlash(ctx, 'error', `Only ${outstanding} outstanding on ${order.reference}.`);
      return ctx.redirect('/warehouse/receiving');
    }
    line.quantityReceived += quantity;
    order.status = line.quantityReceived >= line.quantityOrdered ? 'received' : 'partiallyReceived';
    setFlash(ctx, 'success', `${quantity} received against ${order.reference}.`);
    return ctx.redirect('/warehouse/receiving');
  });

  definePage({
    path: '/warehouse/putaway', domain: 'warehouse', title: 'Putaway', kind: 'list',
    view: () => {
      const rows = state.purchaseOrders
        .filter(o => ['partiallyReceived', 'received'].includes(o.status))
        .flatMap(order => order.lines.filter(line => line.quantityReceived > 0)
          .map(line => ({ order, line })));
      return {
        title: 'Putaway',
        breadcrumbs: [{ label: 'Warehouse', href: '/warehouse' }, { label: 'Putaway' }],
        body: `<div class="panel">
<p class="hint">Received goods waiting to be put away into a pick face or bulk location.</p>
${table({
  caption: 'Goods awaiting putaway', testId: 'putaway-table', empty: 'Nothing is waiting for putaway.',
  columns: [
    { header: 'Purchase order', cell: row => `<a href="/orders/purchase/${h(row.order.id)}">${h(row.order.reference)}</a>` },
    { header: 'SKU', cell: row => `<code>${h(row.line.skuCode)}</code>` },
    { header: 'Description', cell: row => h(row.line.description) },
    { header: 'Received', cell: row => String(row.line.quantityReceived) },
    { header: 'Site', cell: row => h(warehouse(row.order.warehouseId)?.code ?? '') },
    { header: 'Suggested bin', cell: row => `<code>${h(warehouse(row.order.warehouseId)?.code ?? 'FXT')}-Z2-${String((row.line.quantityReceived % 60) + 1).padStart(3, '0')}</code>` }
  ],
  rows
})}</div>`
      };
    }
  });

  definePage({
    path: '/warehouse/picking', domain: 'warehouse', title: 'Picking', kind: 'list',
    view: () => {
      const rows = state.salesOrders.filter(o => ['approved', 'allocated'].includes(o.status));
      return {
        title: 'Picking',
        breadcrumbs: [{ label: 'Warehouse', href: '/warehouse' }, { label: 'Picking' }],
        body: `<div class="panel">
<p class="hint">Approved orders ready to be picked, oldest first.</p>
${table({
  caption: 'Orders ready to pick', testId: 'picking-table', empty: 'Nothing is ready to pick.',
  columns: [
    { header: 'Order', cell: row => `<a href="/orders/sales/${h(row.id)}">${h(row.reference)}</a>` },
    { header: 'Customer', cell: row => h(state.customers.find(c => c.id === row.customerId)?.name ?? '') },
    { header: 'Lines', cell: row => String(row.lines.length) },
    { header: 'Units', cell: row => String(row.lines.reduce((sum, l) => sum + l.quantity, 0)) },
    { header: 'Requested', cell: row => shortDate(row.requestedDeliveryOn) },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows
})}</div>`
      };
    }
  });

  definePage({
    path: '/warehouse/packing', domain: 'warehouse', title: 'Packing', kind: 'form',
    view: (ctx) => ({
      title: 'Packing',
      breadcrumbs: [{ label: 'Warehouse', href: '/warehouse' }, { label: 'Packing' }],
      body: `<div class="panel" style="max-width:560px">
<p class="hint">Record how a picked order was packed, so the consignment weight matches what leaves the door.</p>
<form method="post" action="/warehouse/packing" data-testid="packing-form">
${csrfField(ctx)}
${field({ name: 'orderId', label: 'Order', required: true, testId: 'packing-order',
  options: [{ value: '', label: 'Choose an order' }, ...state.salesOrders.filter(o => o.status === 'allocated').map(o => ({ value: o.id, label: o.reference }))] })}
${field({ name: 'cartons', label: 'Cartons', type: 'number', required: true, testId: 'packing-cartons', attrs: { min: '1', max: '500' } })}
${field({ name: 'grossWeightKg', label: 'Gross weight (kg)', type: 'number', required: true, testId: 'packing-weight', attrs: { min: '0.1', max: '30000', step: '0.1' } })}
${field({ name: 'palletised', label: 'Packed onto pallets', type: 'checkbox', testId: 'packing-palletised' })}
<button class="btn" type="submit" data-testid="packing-submit">Record packing</button>
</form></div>`
    })
  });

  app.post('/warehouse/packing', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    const cartons = Number(body.cartons);
    if (!Number.isInteger(cartons) || cartons < 1) {
      setFlash(ctx, 'error', 'Enter a whole number of cartons.');
      return ctx.redirect('/warehouse/packing');
    }
    setFlash(ctx, 'success', 'Packing recorded.');
    return ctx.redirect('/warehouse/packing');
  });
}
