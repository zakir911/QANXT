/**
 * Reports: the read-only end of the platform.
 *
 * Deliberately free of planted defects. Every number is computed from the same state the
 * operational screens render, so a report that disagrees with a list screen is a genuine
 * finding rather than a planted one.
 */
import { h, table, field, statusPill, shortDate, money, kv, stat, tabs } from '../ui/chrome.js';

export const SCREENS = [
  { path: '/reports', title: 'Reports', kind: 'list' },
  { path: '/reports/volume', title: 'Volume by month', kind: 'report' },
  { path: '/reports/revenue', title: 'Revenue by customer', kind: 'report' },
  { path: '/reports/carrier-scorecard', title: 'Carrier scorecard', kind: 'report' },
  { path: '/reports/exceptions', title: 'Exception analysis', kind: 'report' },
  { path: '/reports/builder', title: 'Report builder', kind: 'form' },
  { path: '/reports/saved', title: 'Saved reports', kind: 'list' },
  { path: '/reports/scheduled', title: 'Scheduled reports', kind: 'form' },
  { path: '/reports/export', title: 'Export data', kind: 'form' }
];

const savedReports = [
  { id: 'rep-1', name: 'Weekly exception summary', owner: 'Rowan Vasquez', dataset: 'shipments', createdAt: '2026-02-11T09:00:00Z', lastRunAt: '2026-03-01T07:30:00Z' },
  { id: 'rep-2', name: 'Revenue by tier', owner: 'Marta Oyelaran', dataset: 'invoices', createdAt: '2026-01-19T09:00:00Z', lastRunAt: '2026-03-01T07:31:00Z' },
  { id: 'rep-3', name: 'Carrier damage trend', owner: 'Rowan Vasquez', dataset: 'claims', createdAt: '2025-11-02T09:00:00Z', lastRunAt: '2026-02-28T07:30:00Z' }
];

const schedules = [
  { id: 'sch-1', reportId: 'rep-1', frequency: 'weekly', day: 'Monday', time: '07:30', recipients: 'control.tower@meridian.test', enabled: true },
  { id: 'sch-2', reportId: 'rep-2', frequency: 'monthly', day: '1', time: '08:00', recipients: 'finance@meridian.test', enabled: true },
  { id: 'sch-3', reportId: 'rep-3', frequency: 'weekly', day: 'Friday', time: '16:00', recipients: 'ops.lead@meridian.test', enabled: false }
];

export default function registerReports({ app, core, state }) {
  const { definePage, csrfField, setFlash } = core;

  const customer = id => state.customers.find(c => c.id === id);

  definePage({
    path: '/reports', domain: 'reports', title: 'Reports', kind: 'list',
    view: () => ({
      title: 'Reports',
      actions: `<a class="btn" href="/reports/builder" data-testid="go-builder">Build a report</a>
<a class="btn btn-secondary" href="/reports/export" data-testid="go-export">Export data</a>`,
      body: `<div class="grid grid-2">
${[
  { path: '/reports/volume', title: 'Volume by month', detail: 'Shipments, pieces and weight moved each month, by service level.' },
  { path: '/reports/revenue', title: 'Revenue by customer', detail: 'Invoiced and outstanding value per account, against credit limits.' },
  { path: '/reports/carrier-scorecard', title: 'Carrier scorecard', detail: 'On-time rate, damage rate and open claims for every carrier.' },
  { path: '/reports/exceptions', title: 'Exception analysis', detail: 'Exception codes by carrier and destination, with the open duration.' },
  { path: '/reports/saved', title: 'Saved reports', detail: 'Reports colleagues have built and kept.' },
  { path: '/reports/scheduled', title: 'Scheduled reports', detail: 'Which reports are emailed, to whom and when.' }
].map(item => `<a class="panel" href="${item.path}" style="text-decoration:none;color:inherit;display:block"
  data-testid="report-card-${h(item.path.split('/').pop())}">
<h3 style="margin-top:0">${h(item.title)}</h3>
<p class="hint" style="margin:0">${h(item.detail)}</p></a>`).join('')}
</div>`
    })
  });

  definePage({
    path: '/reports/volume', domain: 'reports', title: 'Volume by month', kind: 'report',
    view: () => {
      const byMonth = new Map();
      for (const shipment of state.shipments) {
        const month = String(shipment.bookedAt).slice(0, 7);
        const entry = byMonth.get(month) ?? { month, shipments: 0, pieces: 0, weightKg: 0 };
        entry.shipments += 1;
        entry.pieces += shipment.pieces;
        entry.weightKg += shipment.weightKg;
        byMonth.set(month, entry);
      }
      const rows = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
      const byService = state.SERVICE_LEVELS.map(level => {
        const forLevel = state.shipments.filter(s => s.serviceLevel === level.code);
        return {
          ...level, count: forLevel.length,
          pieces: forLevel.reduce((sum, s) => sum + s.pieces, 0),
          weightKg: Math.round(forLevel.reduce((sum, s) => sum + s.weightKg, 0) * 10) / 10
        };
      });
      return {
        title: 'Volume by month',
        breadcrumbs: [{ label: 'Reports', href: '/reports' }, { label: 'Volume' }],
        body: `<div class="panel"><h2 style="margin-top:0">By month</h2>
${table({
  caption: 'Shipments, pieces and weight by month', testId: 'volume-by-month',
  columns: [
    { header: 'Month', cell: row => h(row.month) },
    { header: 'Shipments', cell: row => String(row.shipments) },
    { header: 'Pieces', cell: row => String(row.pieces) },
    { header: 'Weight', cell: row => `${Math.round(row.weightKg * 10) / 10} kg` },
    { header: 'Average pieces', cell: row => String(Math.round((row.pieces / row.shipments) * 10) / 10) }
  ],
  rows
})}</div>
<div class="panel"><h2 style="margin-top:0">By service level</h2>
${table({
  caption: 'Volume by service level', testId: 'volume-by-service',
  columns: [
    { header: 'Service', cell: row => h(row.name) },
    { header: 'Code', cell: row => `<code>${h(row.code)}</code>` },
    { header: 'Shipments', cell: row => String(row.count) },
    { header: 'Pieces', cell: row => String(row.pieces) },
    { header: 'Weight', cell: row => `${row.weightKg} kg` },
    { header: 'Share', cell: row => `${Math.round((row.count / state.shipments.length) * 1000) / 10}%` }
  ],
  rows: byService
})}</div>`
      };
    }
  });

  definePage({
    path: '/reports/revenue', domain: 'reports', title: 'Revenue by customer', kind: 'report',
    view: () => {
      const rows = state.customers.map(cust => {
        const invoices = state.invoices.filter(i => i.customerId === cust.id);
        const paid = invoices.filter(i => i.status === 'paid');
        const outstanding = invoices.filter(i => ['issued', 'overdue', 'disputed'].includes(i.status));
        return {
          cust,
          invoiced: Math.round(invoices.reduce((s, i) => s + i.totalGbp, 0) * 100) / 100,
          paid: Math.round(paid.reduce((s, i) => s + i.totalGbp, 0) * 100) / 100,
          outstanding: Math.round(outstanding.reduce((s, i) => s + i.totalGbp, 0) * 100) / 100,
          count: invoices.length
        };
      }).sort((a, b) => b.invoiced - a.invoiced);
      const total = Math.round(rows.reduce((s, r) => s + r.invoiced, 0) * 100) / 100;
      return {
        title: 'Revenue by customer',
        breadcrumbs: [{ label: 'Reports', href: '/reports' }, { label: 'Revenue' }],
        body: `<div class="grid grid-3" style="margin-bottom:16px">
${stat(money(total), 'Total invoiced', 'revenue-total')}
${stat(money(rows.reduce((s, r) => s + r.paid, 0)), 'Paid', 'revenue-paid')}
${stat(money(rows.reduce((s, r) => s + r.outstanding, 0)), 'Outstanding', 'revenue-outstanding')}
</div>
<div class="panel">
${table({
  caption: 'Revenue and outstanding debt by customer', testId: 'revenue-table',
  columns: [
    { header: 'Customer', cell: row => `<a href="/customers/${h(row.cust.id)}">${h(row.cust.name)}</a>` },
    { header: 'Tier', cell: row => h(row.cust.tier) },
    { header: 'Invoices', cell: row => String(row.count) },
    { header: 'Invoiced', cell: row => money(row.invoiced) },
    { header: 'Paid', cell: row => money(row.paid) },
    { header: 'Outstanding', cell: row => money(row.outstanding) },
    { header: 'Share of revenue', cell: row => total ? `${Math.round((row.invoiced / total) * 1000) / 10}%` : '—' }
  ],
  rows
})}</div>`
      };
    }
  });

  definePage({
    path: '/reports/carrier-scorecard', domain: 'reports', title: 'Carrier scorecard', kind: 'report',
    view: () => ({
      title: 'Carrier scorecard',
      breadcrumbs: [{ label: 'Reports', href: '/reports' }, { label: 'Carrier scorecard' }],
      body: `<div class="panel">${table({
        caption: 'Every carrier measured on the same four things', testId: 'scorecard-table',
        columns: [
          { header: 'Carrier', cell: row => `<a href="/carriers/${h(row.id)}">${h(row.name)}</a>` },
          { header: 'Mode', cell: row => h(row.mode) },
          { header: 'Shipments', cell: row => String(state.shipments.filter(s => s.carrierId === row.id).length) },
          { header: 'Delivered', cell: row => String(state.shipments.filter(s => s.carrierId === row.id && s.status === 'delivered').length) },
          { header: 'Exceptions', cell: row => String(state.shipments.filter(s => s.carrierId === row.id && s.status === 'exception').length) },
          { header: 'On time', cell: row => `${row.onTimePct}%` },
          { header: 'Damage rate', cell: row => `${row.damageRatePct}%` },
          { header: 'Open claims', cell: row => String(state.claims.filter(c => c.carrierId === row.id && !['settled', 'rejected'].includes(c.status)).length) }
        ],
        rows: state.carriers
      })}</div>`
    })
  });

  definePage({
    path: '/reports/exceptions', domain: 'reports', title: 'Exception analysis', kind: 'report',
    view: () => {
      const exceptions = state.shipments.filter(s => s.status === 'exception');
      const byCode = new Map();
      for (const shipment of exceptions) {
        const code = shipment.exceptionCode ?? 'UNKNOWN';
        byCode.set(code, (byCode.get(code) ?? 0) + 1);
      }
      return {
        title: 'Exception analysis',
        breadcrumbs: [{ label: 'Reports', href: '/reports' }, { label: 'Exceptions' }],
        body: `<div class="panel"><h2 style="margin-top:0">By code</h2>
${table({
  caption: 'Exception counts by code', testId: 'exceptions-by-code', empty: 'No exceptions recorded.',
  columns: [
    { header: 'Code', cell: row => `<code>${h(row[0])}</code>` },
    { header: 'Count', cell: row => String(row[1]) },
    { header: 'Share', cell: row => exceptions.length ? `${Math.round((row[1] / exceptions.length) * 1000) / 10}%` : '—' }
  ],
  rows: [...byCode.entries()].sort((a, b) => b[1] - a[1])
})}</div>
<div class="panel"><h2 style="margin-top:0">Every open exception</h2>
${table({
  caption: 'Open exceptions with their carrier and destination', testId: 'exceptions-detail', empty: 'No open exceptions.',
  columns: [
    { header: 'Shipment', cell: row => `<a href="/shipments/${h(row.id)}">${h(row.reference)}</a>` },
    { header: 'Code', cell: row => `<code>${h(row.exceptionCode ?? '')}</code>` },
    { header: 'Carrier', cell: row => h(state.carriers.find(c => c.id === row.carrierId)?.name ?? '—') },
    { header: 'Destination', cell: row => h(`${row.destination.city}, ${row.destination.countryCode}`) },
    { header: 'Customer', cell: row => h(customer(row.customerId)?.name ?? '—') },
    { header: 'Claim raised', cell: row => state.claims.some(c => c.shipmentId === row.id)
      ? '<span class="pill pill-info">Yes</span>' : '<span class="pill pill-muted">No</span>' }
  ],
  rows: exceptions
})}</div>`
      };
    }
  });

  definePage({
    path: '/reports/builder', domain: 'reports', title: 'Report builder', kind: 'form',
    view: (ctx) => ({
      title: 'Report builder',
      breadcrumbs: [{ label: 'Reports', href: '/reports' }, { label: 'Builder' }],
      body: `<div class="panel" style="max-width:620px">
<form method="post" action="/reports/builder" data-testid="builder-form">
${csrfField(ctx)}
${field({ name: 'name', label: 'Report name', required: true, testId: 'builder-name', attrs: { maxlength: '80' } })}
${field({ name: 'dataset', label: 'Dataset', required: true, testId: 'builder-dataset',
  options: [{ value: '', label: 'Choose a dataset' }, 'shipments', 'orders', 'invoices', 'claims', 'stock', 'declarations'] })}
${field({ name: 'groupBy', label: 'Group by', testId: 'builder-group',
  options: ['none', 'customer', 'carrier', 'service level', 'month', 'status'] })}
${field({ name: 'dateFrom', label: 'From date', type: 'date', required: true, testId: 'builder-from' })}
${field({ name: 'dateTo', label: 'To date', type: 'date', required: true, testId: 'builder-to',
  hint: 'Must be on or after the from date.' })}
${field({ name: 'includeCancelled', label: 'Include cancelled records', type: 'checkbox', testId: 'builder-cancelled' })}
${field({ name: 'format', label: 'Output format', testId: 'builder-format', options: ['On screen', 'CSV', 'PDF'] })}
<button class="btn" type="submit" data-testid="builder-submit">Build report</button>
</form></div>`
    })
  });

  app.post('/reports/builder', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const body = await ctx.body();
    const name = String(body.name ?? '').trim();
    if (!name || !body.dataset) {
      setFlash(ctx, 'error', 'A name and a dataset are required.');
      return ctx.redirect('/reports/builder');
    }
    // Correct: the date range is compared, unlike the shipment booking wizard.
    if (body.dateFrom && body.dateTo && String(body.dateTo) < String(body.dateFrom)) {
      setFlash(ctx, 'error', 'The to date cannot be before the from date.');
      return ctx.redirect('/reports/builder');
    }
    savedReports.push({
      id: `rep-${savedReports.length + 1}`, name, owner: user.displayName,
      dataset: String(body.dataset), createdAt: new Date().toISOString(), lastRunAt: new Date().toISOString()
    });
    setFlash(ctx, 'success', `${name} built and saved.`);
    return ctx.redirect('/reports/saved');
  });

  definePage({
    path: '/reports/saved', domain: 'reports', title: 'Saved reports', kind: 'list',
    view: () => ({
      title: 'Saved reports',
      breadcrumbs: [{ label: 'Reports', href: '/reports' }, { label: 'Saved' }],
      actions: `<a class="btn" href="/reports/builder" data-testid="build-another">Build a report</a>`,
      body: `<div class="panel">${table({
        caption: 'Reports colleagues have saved', testId: 'saved-reports-table', empty: 'No saved reports.',
        columns: [
          { header: 'Name', cell: row => h(row.name) },
          { header: 'Dataset', cell: row => `<code>${h(row.dataset)}</code>` },
          { header: 'Owner', cell: row => h(row.owner) },
          { header: 'Created', cell: row => shortDate(row.createdAt) },
          { header: 'Last run', cell: row => shortDate(row.lastRunAt) },
          { header: 'Scheduled', cell: row => schedules.some(s => s.reportId === row.id && s.enabled)
            ? '<span class="pill pill-ok">Yes</span>' : '<span class="pill pill-muted">No</span>' }
        ],
        rows: savedReports
      })}</div>`
    })
  });

  definePage({
    path: '/reports/scheduled', domain: 'reports', title: 'Scheduled reports', kind: 'form',
    view: (ctx) => ({
      title: 'Scheduled reports',
      breadcrumbs: [{ label: 'Reports', href: '/reports' }, { label: 'Scheduled' }],
      body: `<div class="panel">
${table({
  caption: 'Reports emailed on a schedule', testId: 'schedules-table', empty: 'Nothing is scheduled.',
  columns: [
    { header: 'Report', cell: row => h(savedReports.find(r => r.id === row.reportId)?.name ?? '—') },
    { header: 'Frequency', cell: row => h(row.frequency) },
    { header: 'When', cell: row => `${h(row.day)} at ${h(row.time)}` },
    { header: 'Recipients', cell: row => h(row.recipients) },
    { header: 'Enabled', cell: row => row.enabled
      ? '<span class="pill pill-ok">On</span>' : '<span class="pill pill-muted">Off</span>' }
  ],
  rows: schedules
})}
<h3>Add a schedule</h3>
<form method="post" action="/reports/scheduled" data-testid="schedule-form">
${csrfField(ctx)}
${field({ name: 'reportId', label: 'Report', required: true, testId: 'schedule-report',
  options: [{ value: '', label: 'Choose a report' }, ...savedReports.map(r => ({ value: r.id, label: r.name }))] })}
${field({ name: 'frequency', label: 'Frequency', required: true, testId: 'schedule-frequency', options: ['daily', 'weekly', 'monthly'] })}
${field({ name: 'time', label: 'Time', type: 'time', required: true, value: '07:30', testId: 'schedule-time' })}
${field({ name: 'recipients', label: 'Recipients', required: true, testId: 'schedule-recipients',
  hint: 'Comma separated email addresses.' })}
<button class="btn" type="submit" data-testid="schedule-submit">Add schedule</button>
</form></div>`
    })
  });

  app.post('/reports/scheduled', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    const recipients = String(body.recipients ?? '').trim();
    if (!body.reportId || !recipients) {
      setFlash(ctx, 'error', 'Choose a report and at least one recipient.');
      return ctx.redirect('/reports/scheduled');
    }
    // Correct: each address is checked, so a typo does not silently never deliver.
    const invalid = recipients.split(',').map(a => a.trim()).filter(a => a && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
    if (invalid.length) {
      setFlash(ctx, 'error', `${invalid.length} recipient address(es) are not valid email addresses.`);
      return ctx.redirect('/reports/scheduled');
    }
    schedules.push({
      id: `sch-${schedules.length + 1}`, reportId: String(body.reportId),
      frequency: String(body.frequency), day: 'Monday', time: String(body.time),
      recipients, enabled: true
    });
    setFlash(ctx, 'success', 'Schedule added.');
    return ctx.redirect('/reports/scheduled');
  });

  definePage({
    path: '/reports/export', domain: 'reports', title: 'Export data', kind: 'form',
    view: (ctx) => ({
      title: 'Export data',
      breadcrumbs: [{ label: 'Reports', href: '/reports' }, { label: 'Export' }],
      body: `<div class="panel" style="max-width:560px">
<p class="hint">An export is generated and emailed. Exports containing customer contact details are audited.</p>
<form method="post" action="/reports/export" data-testid="export-form">
${csrfField(ctx)}
${field({ name: 'dataset', label: 'Dataset', required: true, testId: 'export-dataset',
  options: [{ value: '', label: 'Choose a dataset' }, 'shipments', 'orders', 'invoices', 'customers', 'claims', 'stock'] })}
${field({ name: 'format', label: 'Format', required: true, testId: 'export-format', options: ['CSV', 'XLSX', 'JSON'] })}
${field({ name: 'dateFrom', label: 'From date', type: 'date', required: true, testId: 'export-from' })}
${field({ name: 'dateTo', label: 'To date', type: 'date', required: true, testId: 'export-to' })}
${field({ name: 'includeContactDetails', label: 'Include customer contact details', type: 'checkbox', testId: 'export-contacts',
  hint: 'Including these writes an audit entry naming you.' })}
<button class="btn" type="submit" data-testid="export-submit">Generate export</button>
</form></div>`
    })
  });

  app.post('/reports/export', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const body = await ctx.body();
    if (!body.dataset) {
      setFlash(ctx, 'error', 'Choose a dataset to export.');
      return ctx.redirect('/reports/export');
    }
    if (body.dateFrom && body.dateTo && String(body.dateTo) < String(body.dateFrom)) {
      setFlash(ctx, 'error', 'The to date cannot be before the from date.');
      return ctx.redirect('/reports/export');
    }
    if (body.includeContactDetails === 'on') {
      state.auditEntries.unshift({
        id: `aud-${Date.now()}`, at: new Date().toISOString(), userId: user.id,
        action: 'report.exportedWithContacts', entityType: 'report', entityId: String(body.dataset),
        ipAddress: '203.0.113.17', correlationId: `cor-${Date.now() % 1_000_000}`, outcome: 'allowed'
      });
    }
    setFlash(ctx, 'success', `Export of ${body.dataset} queued. You will be emailed when it is ready.`);
    return ctx.redirect('/reports/export');
  });
}
