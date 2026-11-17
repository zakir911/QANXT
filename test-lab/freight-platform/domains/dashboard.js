/**
 * The control tower: what an operations lead looks at first thing.
 *
 * Linked navigation throughout. Deliberately free of planted defects, so that a scan which
 * reports findings here is reporting a false positive and the lab can say so.
 */
import { h, table, stat, statusPill, shortDate, dateTime, money, tabs, kv } from '../ui/chrome.js';

export const SCREENS = [
  { path: '/dashboard', title: 'Control tower', kind: 'dashboard' },
  { path: '/dashboard/exceptions', title: 'Open exceptions', kind: 'list' },
  { path: '/dashboard/sla', title: 'Service level performance', kind: 'report' },
  { path: '/dashboard/capacity', title: 'Capacity and utilisation', kind: 'report' },
  { path: '/dashboard/today', title: 'Today at a glance', kind: 'dashboard' }
];

export default function registerDashboard({ core, state }) {
  const { definePage } = core;

  const customerName = id => state.customers.find(c => c.id === id)?.name ?? 'Unknown';
  const carrierName = id => state.carriers.find(c => c.id === id)?.name ?? 'Unknown';

  definePage({
    path: '/dashboard', domain: 'dashboard', title: 'Control tower', kind: 'dashboard',
    view: (ctx, user) => {
      const open = state.shipments.filter(s => !['delivered', 'cancelled'].includes(s.status));
      const exceptions = state.shipments.filter(s => s.status === 'exception');
      const held = state.shipments.filter(s => s.status === 'customsHold');
      const overdueInvoices = state.invoices.filter(i => i.status === 'overdue');
      const delivered = state.shipments.filter(s => s.status === 'delivered');
      const onTime = delivered.filter(s => s.deliveredAt && s.deliveredAt.slice(0, 10) <= s.estimatedDeliveryOn);
      const onTimePct = delivered.length ? Math.round((onTime.length / delivered.length) * 1000) / 10 : 0;

      return {
        title: `Good morning, ${user.displayName.split(' ')[0]}`,
        actions: `<a class="btn" href="/shipments/new" data-testid="book-shipment">Book a shipment</a>
                  <a class="btn btn-secondary" href="/reports" data-testid="go-reports">Reports</a>`,
        body: `
<div class="grid grid-4" style="margin-bottom:16px">
${stat(open.length, 'Shipments in play', 'stat-open')}
${stat(exceptions.length, 'Open exceptions', 'stat-exceptions')}
${stat(held.length, 'Held at customs', 'stat-held')}
${stat(`${onTimePct}%`, 'Delivered on time', 'stat-ontime')}
</div>

<div class="grid grid-2">
<div class="panel">
<h2 style="margin-top:0">Needs attention now</h2>
${table({
  caption: 'Shipments with an open exception or customs hold', testId: 'attention-table',
  empty: 'Nothing needs attention.',
  columns: [
    { header: 'Reference', cell: row => `<a href="/shipments/${h(row.id)}" data-testid="attention-${h(row.reference)}">${h(row.reference)}</a>` },
    { header: 'Customer', cell: row => h(customerName(row.customerId)) },
    { header: 'Status', cell: row => statusPill(row.status) },
    { header: 'Reason', cell: row => h(row.exceptionCode ?? 'Documentation') }
  ],
  rows: [...exceptions, ...held].slice(0, 8)
})}
</div>

<div class="panel">
<h2 style="margin-top:0">Money at risk</h2>
${table({
  caption: 'Overdue invoices', testId: 'overdue-table', empty: 'Nothing overdue.',
  columns: [
    { header: 'Invoice', cell: row => `<a href="/billing/invoices/${h(row.id)}">${h(row.reference)}</a>` },
    { header: 'Customer', cell: row => h(customerName(row.customerId)) },
    { header: 'Due', cell: row => shortDate(row.dueOn) },
    { header: 'Days', cell: row => `<span class="pill pill-${row.daysOverdue > 30 ? 'danger' : 'warn'}">${row.daysOverdue}</span>` },
    { header: 'Amount', cell: row => money(row.totalGbp) }
  ],
  rows: overdueInvoices.slice(0, 8)
})}
</div>
</div>

<div class="panel">
<h2 style="margin-top:0">Collections and deliveries today</h2>
${table({
  caption: 'Routes planned for today', testId: 'today-routes',
  columns: [
    { header: 'Route', cell: row => h(row.reference) },
    { header: 'Depot', cell: row => h(state.warehouses.find(w => w.id === row.depotId)?.name ?? '—') },
    { header: 'Driver', cell: row => h(state.drivers.find(d => d.id === row.driverId)?.name ?? '—') },
    { header: 'Stops', cell: row => String(row.stops.length) },
    { header: 'Utilisation', cell: row => `${row.utilisationPct}%` },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: state.routePlans.slice(0, 6)
})}
</div>`
      };
    }
  });

  definePage({
    path: '/dashboard/exceptions', domain: 'dashboard', title: 'Open exceptions', kind: 'list',
    view: () => {
      const rows = state.shipments.filter(s => s.status === 'exception' || s.status === 'customsHold');
      return {
        title: 'Open exceptions',
        breadcrumbs: [{ label: 'Dashboard', href: '/dashboard' }, { label: 'Open exceptions' }],
        body: `<div class="panel">
<p class="hint">Exceptions escalate to the control tower after ${h(state.settings.operations.exceptionEscalationHours)} hours.</p>
${table({
  caption: 'Every open exception and customs hold', testId: 'exceptions-table',
  empty: 'No open exceptions.',
  columns: [
    { header: 'Reference', cell: row => `<a href="/shipments/${h(row.id)}">${h(row.reference)}</a>` },
    { header: 'Customer', cell: row => h(customerName(row.customerId)) },
    { header: 'Carrier', cell: row => h(carrierName(row.carrierId)) },
    { header: 'Raised', cell: row => dateTime(row.events.at(-1)?.at) },
    { header: 'Code', cell: row => h(row.exceptionCode ?? 'CUSTOMS') },
    { header: 'Status', cell: row => statusPill(row.status) },
    { header: '', cell: row => `<a class="btn btn-secondary" href="/claims/new?shipment=${h(row.id)}" data-testid="raise-claim-${h(row.reference)}">Raise claim</a>` }
  ],
  rows
})}</div>`
      };
    }
  });

  definePage({
    path: '/dashboard/sla', domain: 'dashboard', title: 'Service level performance', kind: 'report',
    view: () => {
      const byService = state.SERVICE_LEVELS.map(level => {
        const forLevel = state.shipments.filter(s => s.serviceLevel === level.code);
        const delivered = forLevel.filter(s => s.status === 'delivered');
        const onTime = delivered.filter(s => s.deliveredAt && s.deliveredAt.slice(0, 10) <= s.estimatedDeliveryOn);
        return {
          ...level,
          total: forLevel.length,
          delivered: delivered.length,
          onTimePct: delivered.length ? Math.round((onTime.length / delivered.length) * 1000) / 10 : null
        };
      });
      return {
        title: 'Service level performance',
        breadcrumbs: [{ label: 'Dashboard', href: '/dashboard' }, { label: 'Service levels' }],
        body: `<div class="panel">
${table({
  caption: 'On-time performance by service level', testId: 'sla-table',
  columns: [
    { header: 'Service', cell: row => h(row.name) },
    { header: 'Code', cell: row => `<code>${h(row.code)}</code>` },
    { header: 'Transit days', cell: row => String(row.transitDays) },
    { header: 'Shipments', cell: row => String(row.total) },
    { header: 'Delivered', cell: row => String(row.delivered) },
    { header: 'On time', cell: row => row.onTimePct === null
      ? '<span class="pill pill-muted">No deliveries yet</span>'
      : `<span class="pill pill-${row.onTimePct >= 95 ? 'ok' : row.onTimePct >= 85 ? 'warn' : 'danger'}">${row.onTimePct}%</span>` }
  ],
  rows: byService
})}
<p class="hint" style="margin-top:10px">A service level with no completed deliveries shows no percentage rather than 0%, because nothing has been measured.</p>
</div>

<div class="panel">
<h2 style="margin-top:0">Carrier performance</h2>
${table({
  caption: 'Carrier on-time and damage rates', testId: 'carrier-performance',
  columns: [
    { header: 'Carrier', cell: row => `<a href="/carriers/${h(row.id)}">${h(row.name)}</a>` },
    { header: 'Mode', cell: row => h(row.mode) },
    { header: 'On time', cell: row => `${row.onTimePct}%` },
    { header: 'Damage rate', cell: row => `${row.damageRatePct}%` },
    { header: 'Open claims', cell: row => String(row.claimsOpen) },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: state.carriers
})}
</div>`
      };
    }
  });

  definePage({
    path: '/dashboard/capacity', domain: 'dashboard', title: 'Capacity and utilisation', kind: 'report',
    view: () => ({
      title: 'Capacity and utilisation',
      breadcrumbs: [{ label: 'Dashboard', href: '/dashboard' }, { label: 'Capacity' }],
      body: `<div class="grid grid-4" style="margin-bottom:16px">
${state.warehouses.map(wh => stat(
  `${Math.round((wh.usedPallets / wh.capacityPallets) * 100)}%`,
  `${wh.name} — ${wh.usedPallets.toLocaleString('en-GB')} of ${wh.capacityPallets.toLocaleString('en-GB')} pallets`,
  `capacity-${wh.code}`
)).join('')}
</div>
<div class="panel">
<h2 style="margin-top:0">Vehicle utilisation on planned routes</h2>
${table({
  caption: 'Planned routes and how full each vehicle is', testId: 'utilisation-table',
  columns: [
    { header: 'Route', cell: row => h(row.reference) },
    { header: 'Vehicle', cell: row => h(state.vehicles.find(v => v.id === row.vehicleId)?.registration ?? '—') },
    { header: 'Distance', cell: row => `${row.plannedDistanceKm} km` },
    { header: 'Duration', cell: row => `${Math.floor(row.plannedDurationMinutes / 60)}h ${row.plannedDurationMinutes % 60}m` },
    { header: 'Utilisation', cell: row => `<span class="pill pill-${row.utilisationPct > 90 ? 'ok' : row.utilisationPct > 60 ? 'info' : 'warn'}">${row.utilisationPct}%</span>` }
  ],
  rows: state.routePlans
})}
</div>`
    })
  });

  definePage({
    path: '/dashboard/today', domain: 'dashboard', title: 'Today at a glance', kind: 'dashboard',
    view: () => {
      const booked = state.shipments.filter(s => s.status === 'booked');
      const inTransit = state.shipments.filter(s => s.status === 'inTransit');
      const out = state.shipments.filter(s => s.status === 'outForDelivery');
      return {
        title: 'Today at a glance',
        breadcrumbs: [{ label: 'Dashboard', href: '/dashboard' }, { label: 'Today' }],
        body: tabs('today', [
          {
            key: 'collections', label: `Collections (${booked.length})`,
            body: table({
              caption: 'Shipments booked and awaiting collection', testId: 'today-collections',
              empty: 'Nothing awaiting collection.',
              columns: [
                { header: 'Reference', cell: row => `<a href="/shipments/${h(row.id)}">${h(row.reference)}</a>` },
                { header: 'Customer', cell: row => h(customerName(row.customerId)) },
                { header: 'Pieces', cell: row => String(row.pieces) },
                { header: 'Weight', cell: row => `${row.weightKg} kg` }
              ],
              rows: booked
            })
          },
          {
            key: 'transit', label: `In transit (${inTransit.length})`,
            body: table({
              caption: 'Shipments in transit', testId: 'today-transit',
              empty: 'Nothing in transit.',
              columns: [
                { header: 'Reference', cell: row => `<a href="/shipments/${h(row.id)}">${h(row.reference)}</a>` },
                { header: 'Carrier', cell: row => h(carrierName(row.carrierId)) },
                { header: 'Due', cell: row => shortDate(row.estimatedDeliveryOn) }
              ],
              rows: inTransit
            })
          },
          {
            key: 'delivering', label: `Out for delivery (${out.length})`,
            body: table({
              caption: 'Shipments out for delivery', testId: 'today-delivering',
              empty: 'Nothing out for delivery.',
              columns: [
                { header: 'Reference', cell: row => `<a href="/shipments/${h(row.id)}">${h(row.reference)}</a>` },
                { header: 'Destination', cell: row => h(`${row.destination.city}, ${row.destination.country}`) },
                { header: 'Due', cell: row => shortDate(row.estimatedDeliveryOn) }
              ],
              rows: out
            })
          }
        ])
      };
    }
  });
}
