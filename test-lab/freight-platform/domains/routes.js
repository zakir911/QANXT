/**
 * Routes: planning, stops, dispatch and the live board.
 *
 * **Routed domain.** No anchor leads here.
 *
 *   FP_D26  the planner is fixed at 1100px, so the stop list is unreachable on a tablet
 */
import { h, table, field, statusPill, shortDate, dateTime, money, kv, tabs, stat } from '../ui/chrome.js';

export const SCREENS = [
  { path: '/routes', title: 'Routes', kind: 'list' },
  { path: '/routes/planner', title: 'Route planner', kind: 'form' },
  { path: '/routes/dispatch', title: 'Dispatch', kind: 'list' },
  { path: '/routes/board', title: 'Live route board', kind: 'dashboard' },
  { path: '/routes/history', title: 'Completed routes', kind: 'list' },
  { path: '/routes/:id', title: 'Route', kind: 'detail' },
  { path: '/routes/:id/stops', title: 'Route stops', kind: 'list' },
  { path: '/routes/:id/optimise', title: 'Optimise a route', kind: 'form' }
];

export default function registerRoutes({ app, core, state, faults }) {
  const { definePage, csrfField, setFlash, can } = core;

  const vehicle = id => state.vehicles.find(v => v.id === id);
  const driver = id => state.drivers.find(d => d.id === id);
  const warehouse = id => state.warehouses.find(w => w.id === id);
  const shipment = id => state.shipments.find(s => s.id === id);
  const find = id => state.routePlans.find(r => r.id === id || r.reference === id);

  for (const screen of SCREENS) {
    if (screen.path.includes(':id')) screen.sample = screen.path.replace(':id', state.routePlans[0].id);
  }

  definePage({
    path: '/routes', domain: 'routes', title: 'Routes', kind: 'list',
    view: (ctx) => {
      const status = String(ctx.query.status ?? '');
      const rows = status ? state.routePlans.filter(r => r.status === status) : state.routePlans;
      return {
        title: 'Routes',
        actions: `<button class="btn" type="button" data-route="/routes/planner" data-testid="open-planner">Plan a route</button>
<button class="btn btn-secondary" type="button" data-route="/routes/board" data-testid="open-board">Live board</button>`,
        body: `${table({
          caption: 'Planned and completed routes', testId: 'routes-table', empty: 'No routes match.',
          columns: [
            { header: 'Route', cell: row => `<button type="button" class="btn btn-secondary" style="padding:2px 8px"
                data-route="/routes/${h(row.id)}" data-testid="open-route-${h(row.id)}">${h(row.reference)}</button>` },
            { header: 'Date', cell: row => shortDate(row.planDate) },
            { header: 'Depot', cell: row => h(warehouse(row.depotId)?.code ?? '—') },
            { header: 'Vehicle', cell: row => h(vehicle(row.vehicleId)?.registration ?? '—') },
            { header: 'Driver', cell: row => h(driver(row.driverId)?.name ?? '—') },
            { header: 'Stops', cell: row => String(row.stops.length) },
            { header: 'Distance', cell: row => `${row.plannedDistanceKm} km` },
            { header: 'Utilisation', cell: row => `<span class="pill pill-${row.utilisationPct > 90 ? 'ok' : row.utilisationPct > 60 ? 'info' : 'warn'}">${row.utilisationPct}%</span>` },
            { header: 'Status', cell: row => statusPill(row.status) }
          ],
          rows
        })}`
      };
    }
  });

  definePage({
    path: '/routes/planner', domain: 'routes', title: 'Route planner', kind: 'form',
    view: (ctx) => {
      const unassigned = state.shipments.filter(s => s.status === 'booked').slice(0, 14);
      const fixedWidth = faults.on('FP_D26_PLANNER_FIXED_WIDTH');

      // FP_D26 — an absolute width rather than a responsive grid, so below about 1100px
      // the stop list is simply off the side of the screen with no way to reach it.
      const plannerStyle = fixedWidth
        ? 'width:1100px;display:grid;grid-template-columns:420px 1fr;gap:16px'
        : 'display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px';

      return {
        title: 'Route planner',
        breadcrumbs: [{ label: 'Routes', href: '/routes' }, { label: 'Planner' }],
        body: `<div style="${plannerStyle}" data-testid="planner-grid">
<div class="panel"><h3 style="margin-top:0">Plan details</h3>
<form method="post" action="/routes/planner" data-testid="planner-form">
${csrfField(ctx)}
${field({ name: 'planDate', label: 'Plan date', type: 'date', required: true, testId: 'planner-date' })}
${field({ name: 'depotId', label: 'Depot', required: true, testId: 'planner-depot',
  options: [{ value: '', label: 'Choose a depot' }, ...state.warehouses.map(w => ({ value: w.id, label: w.name }))] })}
${field({ name: 'vehicleId', label: 'Vehicle', required: true, testId: 'planner-vehicle',
  options: [{ value: '', label: 'Choose a vehicle' }, ...state.vehicles.filter(v => v.status === 'available').map(v => ({ value: v.id, label: `${v.registration} — ${v.capacityPallets} pallets` }))] })}
${field({ name: 'driverId', label: 'Driver', required: true, testId: 'planner-driver',
  options: [{ value: '', label: 'Choose a driver' }, ...state.drivers.filter(d => d.status === 'available').map(d => ({ value: d.id, label: `${d.name} — ${d.hoursThisWeek}h this week` }))] })}
${field({ name: 'startTime', label: 'Depot departure', type: 'time', value: '07:00', required: true, testId: 'planner-start' })}
<button class="btn" type="submit" data-testid="planner-submit">Create route</button>
</div>
<div class="panel"><h3 style="margin-top:0">Consignments to load</h3>
<p class="hint">Tick the consignments this route will carry. The vehicle's capacity is checked.</p>
${table({
  caption: 'Booked consignments available to plan', testId: 'planner-shipments', empty: 'Nothing is waiting to be planned.',
  columns: [
    { header: '', cell: row => `<input type="checkbox" name="shipmentIds" value="${h(row.id)}" form="planner-form-el"
        data-testid="plan-${h(row.reference)}" aria-label="Include ${h(row.reference)}" style="width:auto" />` },
    { header: 'Reference', cell: row => h(row.reference) },
    { header: 'Destination', cell: row => h(`${row.destination.city}, ${row.destination.countryCode}`) },
    { header: 'Pieces', cell: row => String(row.pieces) },
    { header: 'Weight', cell: row => `${row.weightKg} kg` }
  ],
  rows: unassigned
})}
</form>
</div>
</div>`
      };
    }
  });

  app.post('/routes/planner', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const body = await ctx.body();
    if (!can(user, 'route:plan')) {
      setFlash(ctx, 'error', 'You do not have permission to plan routes.');
      return ctx.redirect('/routes');
    }
    const chosenVehicle = vehicle(String(body.vehicleId ?? ''));
    const chosenDriver = driver(String(body.driverId ?? ''));
    if (!chosenVehicle || !chosenDriver) {
      setFlash(ctx, 'error', 'Choose a vehicle and a driver.');
      return ctx.redirect('/routes/planner');
    }
    // Correct: a driver already at their weekly limit cannot be planned.
    if (chosenDriver.hoursThisWeek >= chosenDriver.maxWeeklyHours) {
      setFlash(ctx, 'error', `${chosenDriver.name} is at their weekly hours limit.`);
      return ctx.redirect('/routes/planner');
    }
    const ids = [].concat(body.shipmentIds ?? []);
    const index = state.routePlans.length;
    const created = {
      id: `rte-${String(index + 1).padStart(4, '0')}`,
      reference: `RT-${String(body.planDate ?? '').replace(/-/g, '')}-${String(index + 1).padStart(2, '0')}`,
      planDate: String(body.planDate), depotId: String(body.depotId),
      vehicleId: chosenVehicle.id, driverId: chosenDriver.id, status: 'planned',
      plannedDistanceKm: 60 + ids.length * 18, plannedDurationMinutes: 90 + ids.length * 25,
      utilisationPct: Math.min(100, Math.round((ids.length / chosenVehicle.capacityPallets) * 100)),
      stops: ids.map((shipmentId, stopIndex) => {
        const linked = shipment(shipmentId);
        return {
          id: `stop-${index + 1}-${stopIndex + 1}`, sequence: stopIndex + 1, shipmentId,
          type: 'delivery', address: linked?.destination ?? { city: '—', country: '—' },
          windowFrom: `${String(8 + stopIndex).padStart(2, '0')}:00`,
          windowTo: `${String(9 + stopIndex).padStart(2, '0')}:30`, status: 'pending'
        };
      })
    };
    state.routePlans.push(created);
    setFlash(ctx, 'success', `${created.reference} created with ${created.stops.length} stop(s).`);
    return ctx.redirect(`/routes/${created.id}`);
  });

  definePage({
    path: '/routes/:id', domain: 'routes', title: 'Route', kind: 'detail',
    view: (ctx, user) => {
      const route = find(ctx.params.id);
      if (!route) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty" data-testid="not-found">No such route.</div></div>' };
      const activeStops = route.stops.filter(stop => !['cancelled', 'completed'].includes(stop.status));
      return {
        title: `Route ${route.reference}`,
        breadcrumbs: [{ label: 'Routes', href: '/routes' }, { label: route.reference }],
        actions: `<button class="btn btn-secondary" type="button" data-route="/routes/${h(route.id)}/stops" data-testid="view-stops">Stops</button>
<button class="btn btn-secondary" type="button" data-route="/routes/${h(route.id)}/optimise" data-testid="optimise-route">Optimise</button>
${route.status === 'planned' && can(user, 'route:dispatch')
  ? `<form method="post" action="/routes/${h(route.id)}/dispatch" style="display:inline">${csrfField(ctx)}
     <button class="btn" type="submit" data-testid="dispatch-route">Dispatch</button></form>` : ''}`,
        body: `<div class="grid grid-4" style="margin-bottom:14px">
${stat(statusPill(route.status), 'Status', 'route-status')}
${stat(String(route.stops.length), 'Stops', 'route-stops')}
${stat(`${route.plannedDistanceKm} km`, 'Planned distance', 'route-distance')}
${stat(`${route.utilisationPct}%`, 'Utilisation', 'route-utilisation')}
</div>
<div class="grid grid-2">
<div class="panel"><h3 style="margin-top:0">Plan</h3>${kv([
  ['Reference', `<code>${h(route.reference)}</code>`],
  ['Date', shortDate(route.planDate)],
  ['Depot', h(warehouse(route.depotId)?.name ?? '—')],
  ['Vehicle', h(vehicle(route.vehicleId)?.registration ?? '—')],
  ['Driver', h(driver(route.driverId)?.name ?? '—')],
  ['Planned duration', `${Math.floor(route.plannedDurationMinutes / 60)}h ${route.plannedDurationMinutes % 60}m`],
  ['Active stops', String(activeStops.length)]
])}</div>
<div class="panel"><h3 style="margin-top:0">Stops</h3>
<ol style="margin:0;padding-left:20px;font-size:13.5px">
${route.stops.map(stop => {
  const linked = shipment(stop.shipmentId);
  return `<li style="margin-bottom:8px" data-testid="stop-${h(stop.id)}">
<strong>${h(stop.address.city ?? '—')}</strong> ${statusPill(stop.status)}<br />
<span style="color:var(--muted)">${h(stop.windowFrom)}–${h(stop.windowTo)} · ${h(stop.type)}
${linked ? ` · ${h(linked.reference)} (${h(linked.status)})` : ' · consignment missing'}</span></li>`;
}).join('')}
</ol></div></div>`
      };
    }
  });

  app.post('/routes/:id/dispatch', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const route = find(ctx.params.id);
    if (!route) return ctx.json(404, { error: 'not_found' });
    await ctx.body();
    if (!can(user, 'route:dispatch')) {
      setFlash(ctx, 'error', 'You do not have permission to dispatch routes.');
      return ctx.redirect(`/routes/${route.id}`);
    }
    route.status = 'dispatched';
    setFlash(ctx, 'success', `${route.reference} dispatched.`);
    return ctx.redirect(`/routes/${route.id}`);
  });

  definePage({
    path: '/routes/:id/stops', domain: 'routes', title: 'Route stops', kind: 'list',
    view: (ctx) => {
      const route = find(ctx.params.id);
      if (!route) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Stops — ${route.reference}`,
        breadcrumbs: [{ label: 'Routes', href: '/routes' }, { label: route.reference }, { label: 'Stops' }],
        body: `<div class="panel">${table({
          caption: 'Every stop on this route, in sequence', testId: 'stops-table',
          columns: [
            { header: '#', cell: row => String(row.sequence) },
            { header: 'Type', cell: row => h(row.type) },
            { header: 'Where', cell: row => h([row.address.line1, row.address.city, row.address.postcode].filter(Boolean).join(', ')) },
            { header: 'Window', cell: row => `${h(row.windowFrom)}–${h(row.windowTo)}` },
            { header: 'Consignment', cell: row => {
                const linked = shipment(row.shipmentId);
                return linked
                  ? `<a href="/shipments/${h(linked.id)}">${h(linked.reference)}</a> ${statusPill(linked.status)}`
                  : '<span class="pill pill-danger">Consignment missing</span>';
              } },
            { header: 'Stop status', cell: row => statusPill(row.status) }
          ],
          rows: route.stops
        })}
<p class="hint" style="margin-top:10px">A stop whose consignment has been cancelled should not stay pending: the driver would be sent for goods that no longer exist.</p>
</div>`
      };
    }
  });

  definePage({
    path: '/routes/:id/optimise', domain: 'routes', title: 'Optimise a route', kind: 'form',
    view: (ctx) => {
      const route = find(ctx.params.id);
      if (!route) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty">Not found.</div></div>' };
      return {
        title: `Optimise ${route.reference}`,
        breadcrumbs: [{ label: 'Routes', href: '/routes' }, { label: route.reference }, { label: 'Optimise' }],
        body: `<div class="panel" style="max-width:560px">
<p class="hint">Reorders the stops to reduce distance. Delivery windows are respected.</p>
<form method="post" action="/routes/${h(route.id)}/optimise" data-testid="optimise-form">
${csrfField(ctx)}
${field({ name: 'objective', label: 'Optimise for', required: true, testId: 'optimise-objective',
  options: ['Shortest distance', 'Shortest time', 'Fewest window breaches'] })}
${field({ name: 'respectWindows', label: 'Respect delivery windows', type: 'checkbox', value: true, testId: 'optimise-windows' })}
${field({ name: 'maxDetourKm', label: 'Maximum detour per stop (km)', type: 'number', value: 15, testId: 'optimise-detour',
  attrs: { min: '0', max: '200', step: '1' } })}
<button class="btn" type="submit" data-testid="optimise-submit">Optimise route</button>
</form></div>`
      };
    }
  });

  app.post('/routes/:id/optimise', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const route = find(ctx.params.id);
    if (!route) return ctx.json(404, { error: 'not_found' });
    await ctx.body();
    route.stops = route.stops
      .map((stop, index) => ({ ...stop, sequence: route.stops.length - index }))
      .sort((a, b) => a.sequence - b.sequence);
    route.plannedDistanceKm = Math.max(40, Math.round(route.plannedDistanceKm * 0.88));
    setFlash(ctx, 'success', `${route.reference} optimised: planned distance is now ${route.plannedDistanceKm} km.`);
    return ctx.redirect(`/routes/${route.id}`);
  });

  definePage({
    path: '/routes/dispatch', domain: 'routes', title: 'Dispatch', kind: 'list',
    view: (ctx) => {
      const rows = state.routePlans.filter(r => r.status === 'planned');
      return {
        title: 'Dispatch',
        breadcrumbs: [{ label: 'Routes', href: '/routes' }, { label: 'Dispatch' }],
        body: `<div class="panel">
<p class="hint">Routes planned and waiting to be released to a driver.</p>
${table({
  caption: 'Routes awaiting dispatch', testId: 'dispatch-table', empty: 'Nothing is waiting for dispatch.',
  columns: [
    { header: 'Route', cell: row => `<button type="button" class="btn btn-secondary" style="padding:2px 8px"
        data-route="/routes/${h(row.id)}" data-testid="dispatch-open-${h(row.id)}">${h(row.reference)}</button>` },
    { header: 'Date', cell: row => shortDate(row.planDate) },
    { header: 'Vehicle', cell: row => h(vehicle(row.vehicleId)?.registration ?? '—') },
    { header: 'Driver', cell: row => h(driver(row.driverId)?.name ?? '—') },
    { header: 'Stops', cell: row => String(row.stops.length) },
    { header: 'Cancelled consignments', cell: row => {
        const orphans = row.stops.filter(stop => {
          const linked = shipment(stop.shipmentId);
          return linked?.status === 'cancelled' && stop.status !== 'cancelled';
        });
        return orphans.length
          ? `<span class="pill pill-danger" data-testid="orphan-count-${h(row.id)}">${orphans.length}</span>`
          : '<span class="pill pill-ok">None</span>';
      } },
    { header: '', cell: row => `<form method="post" action="/routes/${h(row.id)}/dispatch" style="margin:0">${csrfField(ctx)}
        <button class="btn" type="submit" data-testid="dispatch-now-${h(row.id)}">Dispatch</button></form>` }
  ],
  rows
})}</div>`
      };
    }
  });

  definePage({
    path: '/routes/board', domain: 'routes', title: 'Live route board', kind: 'dashboard',
    view: () => {
      const live = state.routePlans.filter(r => ['dispatched', 'inProgress'].includes(r.status));
      return {
        title: 'Live route board',
        breadcrumbs: [{ label: 'Routes', href: '/routes' }, { label: 'Live board' }],
        body: `<div class="grid grid-3" data-testid="route-board">
${live.length === 0 ? '<div class="panel"><div class="empty">No routes are running.</div></div>' : live.map(route => {
  const done = route.stops.filter(s => s.status === 'completed').length;
  return `<div class="panel" data-testid="board-route-${h(route.id)}">
<h3 style="margin-top:0">${h(route.reference)} ${statusPill(route.status)}</h3>
${kv([
  ['Driver', h(driver(route.driverId)?.name ?? '—')],
  ['Vehicle', h(vehicle(route.vehicleId)?.registration ?? '—')],
  ['Progress', `${done} of ${route.stops.length} stops`],
  ['Distance', `${route.plannedDistanceKm} km`]
])}
<div style="background:#eef1f6;border-radius:999px;height:7px;margin-top:10px;overflow:hidden">
<div style="width:${route.stops.length ? Math.round((done / route.stops.length) * 100) : 0}%;background:var(--accent);height:100%"></div>
</div></div>`;
}).join('')}
</div>`
      };
    }
  });

  definePage({
    path: '/routes/history', domain: 'routes', title: 'Completed routes', kind: 'list',
    view: () => {
      const rows = state.routePlans.filter(r => r.status === 'completed');
      return {
        title: 'Completed routes',
        breadcrumbs: [{ label: 'Routes', href: '/routes' }, { label: 'History' }],
        body: `<div class="panel">${table({
          caption: 'Routes that have finished', testId: 'route-history-table', empty: 'No routes have completed.',
          columns: [
            { header: 'Route', cell: row => h(row.reference) },
            { header: 'Date', cell: row => shortDate(row.planDate) },
            { header: 'Driver', cell: row => h(driver(row.driverId)?.name ?? '—') },
            { header: 'Stops', cell: row => String(row.stops.length) },
            { header: 'Completed', cell: row => String(row.stops.filter(s => s.status === 'completed').length) },
            { header: 'Failed', cell: row => {
                const failed = row.stops.filter(s => s.status === 'failed').length;
                return failed ? `<span class="pill pill-danger">${failed}</span>` : '0';
              } },
            { header: 'Distance', cell: row => `${row.plannedDistanceKm} km` }
          ],
          rows
        })}</div>`
      };
    }
  });
}
