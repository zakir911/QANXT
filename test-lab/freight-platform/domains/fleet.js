/**
 * Fleet: vehicles, drivers, maintenance and compliance.
 *
 * **Routed domain.** Its nav control is a button that calls history.pushState, and its
 * screens are rendered client-side from /api/view. A deep link works; no anchor exists.
 *
 *   FP_D23  vehicle availability is conveyed by colour alone
 */
import { h, table, field, statusPill, shortDate, dateTime, money, kv, tabs, stat } from '../ui/chrome.js';

export const SCREENS = [
  { path: '/fleet', title: 'Fleet', kind: 'dashboard' },
  { path: '/fleet/vehicles', title: 'Vehicles', kind: 'list' },
  { path: '/fleet/vehicles/new', title: 'Add a vehicle', kind: 'form' },
  { path: '/fleet/vehicles/:id', title: 'Vehicle', kind: 'detail' },
  { path: '/fleet/drivers', title: 'Drivers', kind: 'list' },
  { path: '/fleet/drivers/new', title: 'Add a driver', kind: 'form' },
  { path: '/fleet/drivers/:id', title: 'Driver', kind: 'detail' },
  { path: '/fleet/maintenance', title: 'Maintenance', kind: 'list' },
  { path: '/fleet/inspections', title: 'Daily inspections', kind: 'form' },
  { path: '/fleet/compliance', title: 'Fleet compliance', kind: 'report' }
];

export default function registerFleet({ app, core, state, faults }) {
  const { definePage, csrfField, setFlash } = core;

  const warehouse = id => state.warehouses.find(w => w.id === id);
  const findVehicle = id => state.vehicles.find(v => v.id === id || v.registration === id);
  const findDriver = id => state.drivers.find(d => d.id === id || d.licenceNumber === id);

  for (const screen of SCREENS) {
    if (screen.path.startsWith('/fleet/vehicles/:id')) screen.sample = screen.path.replace(':id', state.vehicles[0].id);
    if (screen.path.startsWith('/fleet/drivers/:id')) screen.sample = screen.path.replace(':id', state.drivers[0].id);
  }

  /**
   * FP_D23 — the status cell is a coloured square with no text and no accessible name,
   * so available, in maintenance and off road are the same thing without colour vision.
   */
  const vehicleStatus = (status) => {
    if (!faults.on('FP_D23_STATUS_BY_COLOUR_ONLY')) return statusPill(status);
    const colour = { available: '#0f7a52', inMaintenance: '#9a6508', offRoad: '#b32020' }[status] ?? '#5d6b80';
    return `<span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:${colour}"></span>`;
  };

  definePage({
    path: '/fleet', domain: 'fleet', title: 'Fleet', kind: 'dashboard',
    view: () => {
      const available = state.vehicles.filter(v => v.status === 'available');
      const dueService = state.vehicles.filter(v => v.odometerKm - v.lastServiceOdometerKm > v.serviceIntervalKm * 0.9);
      const motSoon = state.vehicles.filter(v => Date.parse(v.motExpiresOn) < Date.parse('2026-04-01'));
      const licenceSoon = state.drivers.filter(d => Date.parse(d.licenceExpiresOn) < Date.parse('2026-04-01'));
      return {
        title: 'Fleet',
        actions: `<button class="btn" type="button" data-route="/fleet/vehicles/new" data-testid="add-vehicle">Add a vehicle</button>
<button class="btn btn-secondary" type="button" data-route="/fleet/compliance" data-testid="go-compliance">Compliance</button>`,
        body: `<div class="grid grid-4" style="margin-bottom:16px">
${stat(`${available.length} of ${state.vehicles.length}`, 'Vehicles available', 'stat-vehicles-available')}
${stat(String(dueService.length), 'Due a service', 'stat-due-service')}
${stat(String(motSoon.length), 'MOT expiring within the month', 'stat-mot-soon')}
${stat(String(licenceSoon.length), 'Driver licences expiring', 'stat-licence-soon')}
</div>
<div class="grid grid-2">
<div class="panel"><h2 style="margin-top:0">Vehicles</h2>
${table({
  caption: 'Fleet vehicles and their status', testId: 'fleet-vehicles-summary',
  columns: [
    { header: 'Registration', cell: row => `<button type="button" class="btn btn-secondary" style="padding:2px 8px"
        data-route="/fleet/vehicles/${h(row.id)}" data-testid="vehicle-${h(row.id)}">${h(row.registration)}</button>` },
    { header: 'Type', cell: row => h(row.type) },
    { header: 'Depot', cell: row => h(warehouse(row.depotId)?.code ?? '—') },
    { header: 'Status', cell: row => vehicleStatus(row.status) }
  ],
  rows: state.vehicles.slice(0, 8)
})}</div>
<div class="panel"><h2 style="margin-top:0">Drivers</h2>
${table({
  caption: 'Drivers and their hours', testId: 'fleet-drivers-summary',
  columns: [
    { header: 'Name', cell: row => `<button type="button" class="btn btn-secondary" style="padding:2px 8px"
        data-route="/fleet/drivers/${h(row.id)}" data-testid="driver-${h(row.id)}">${h(row.name)}</button>` },
    { header: 'Hours this week', cell: row => `${row.hoursThisWeek} of ${row.maxWeeklyHours}` },
    { header: 'ADR', cell: row => row.adrCertified ? 'Yes' : 'No' },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: state.drivers.slice(0, 8)
})}</div></div>`
      };
    }
  });

  definePage({
    path: '/fleet/vehicles', domain: 'fleet', title: 'Vehicles', kind: 'list',
    view: (ctx) => {
      const status = String(ctx.query.status ?? '');
      const rows = status ? state.vehicles.filter(v => v.status === status) : state.vehicles;
      return {
        title: 'Vehicles',
        breadcrumbs: [{ label: 'Fleet', href: '/fleet' }, { label: 'Vehicles' }],
        actions: `<button class="btn" type="button" data-route="/fleet/vehicles/new" data-testid="add-vehicle">Add a vehicle</button>`,
        body: `${table({
          caption: 'Every vehicle in the fleet', testId: 'vehicles-table', empty: 'No vehicles match.',
          columns: [
            { header: 'Registration', cell: row => `<button type="button" class="btn btn-secondary" style="padding:2px 8px"
                data-route="/fleet/vehicles/${h(row.id)}" data-testid="open-vehicle-${h(row.id)}">${h(row.registration)}</button>` },
            { header: 'Type', cell: row => h(row.type) },
            { header: 'Capacity', cell: row => `${row.capacityPallets} pallets` },
            { header: 'Chilled', cell: row => row.temperatureControlled ? 'Yes' : 'No' },
            { header: 'Depot', cell: row => h(warehouse(row.depotId)?.name ?? '—') },
            { header: 'Odometer', cell: row => `${row.odometerKm.toLocaleString('en-GB')} km` },
            { header: 'MOT expires', cell: row => shortDate(row.motExpiresOn) },
            { header: 'Status', cell: row => vehicleStatus(row.status) }
          ],
          rows
        })}`
      };
    }
  });

  definePage({
    path: '/fleet/vehicles/new', domain: 'fleet', title: 'Add a vehicle', kind: 'form',
    view: (ctx) => ({
      title: 'Add a vehicle',
      breadcrumbs: [{ label: 'Fleet', href: '/fleet' }, { label: 'Vehicles', href: '/fleet/vehicles' }, { label: 'Add' }],
      body: `<div class="panel" style="max-width:580px">
<form method="post" action="/fleet/vehicles/new" data-testid="new-vehicle-form">
${csrfField(ctx)}
${field({ name: 'registration', label: 'Registration', required: true, testId: 'vehicle-registration',
  attrs: { maxlength: '10' }, hint: 'As shown on the plate.' })}
${field({ name: 'type', label: 'Type', required: true, testId: 'vehicle-type',
  options: ['rigid7.5t', 'rigid18t', 'artic44t', 'van3.5t', 'reefer44t'] })}
${field({ name: 'capacityPallets', label: 'Capacity (pallets)', type: 'number', required: true, testId: 'vehicle-capacity',
  attrs: { min: '1', max: '40', step: '1' } })}
${field({ name: 'depotId', label: 'Home depot', required: true, testId: 'vehicle-depot',
  options: [{ value: '', label: 'Choose a depot' }, ...state.warehouses.map(w => ({ value: w.id, label: w.name }))] })}
${field({ name: 'odometerKm', label: 'Odometer (km)', type: 'number', required: true, testId: 'vehicle-odometer',
  attrs: { min: '0', max: '2000000', step: '1' } })}
${field({ name: 'motExpiresOn', label: 'MOT expires on', type: 'date', required: true, testId: 'vehicle-mot' })}
${field({ name: 'temperatureControlled', label: 'Temperature controlled', type: 'checkbox', testId: 'vehicle-chilled' })}
<button class="btn" type="submit" data-testid="vehicle-submit">Add vehicle</button>
</form></div>`
    })
  });

  app.post('/fleet/vehicles/new', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    const registration = String(body.registration ?? '').trim().toUpperCase();
    const capacity = Number(body.capacityPallets);
    if (!registration || !Number.isInteger(capacity) || capacity < 1) {
      setFlash(ctx, 'error', 'A registration and a whole capacity of at least 1 are required.');
      return ctx.redirect('/fleet/vehicles/new');
    }
    // Correct: the registration is checked for uniqueness.
    if (state.vehicles.some(v => v.registration === registration)) {
      setFlash(ctx, 'error', `${registration} is already in the fleet.`);
      return ctx.redirect('/fleet/vehicles/new');
    }
    const created = {
      id: `veh-${String(state.vehicles.length + 1).padStart(3, '0')}`,
      registration, type: String(body.type ?? 'rigid18t'), capacityPallets: capacity,
      temperatureControlled: body.temperatureControlled === 'on', status: 'available',
      depotId: String(body.depotId), odometerKm: Number(body.odometerKm ?? 0),
      motExpiresOn: String(body.motExpiresOn), taxExpiresOn: String(body.motExpiresOn),
      lastServiceOdometerKm: Number(body.odometerKm ?? 0), serviceIntervalKm: 25_000
    };
    state.vehicles.push(created);
    setFlash(ctx, 'success', `${created.registration} added to the fleet.`);
    return ctx.redirect(`/fleet/vehicles/${created.id}`);
  });

  definePage({
    path: '/fleet/vehicles/:id', domain: 'fleet', title: 'Vehicle', kind: 'detail',
    view: (ctx) => {
      const vehicle = findVehicle(ctx.params.id);
      if (!vehicle) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty" data-testid="not-found">No such vehicle.</div></div>' };
      const sinceService = vehicle.odometerKm - vehicle.lastServiceOdometerKm;
      const routes = state.routePlans.filter(r => r.vehicleId === vehicle.id);
      return {
        title: vehicle.registration,
        breadcrumbs: [{ label: 'Fleet', href: '/fleet' }, { label: 'Vehicles', href: '/fleet/vehicles' }, { label: vehicle.registration }],
        body: `<div class="grid grid-4" style="margin-bottom:14px">
${stat(statusPill(vehicle.status), 'Status', 'vehicle-status')}
${stat(`${vehicle.odometerKm.toLocaleString('en-GB')} km`, 'Odometer', 'vehicle-odometer')}
${stat(`${sinceService.toLocaleString('en-GB')} km`, `Since last service (interval ${vehicle.serviceIntervalKm.toLocaleString('en-GB')})`, 'vehicle-since-service')}
${stat(shortDate(vehicle.motExpiresOn), 'MOT expires', 'vehicle-mot')}
</div>
${sinceService > vehicle.serviceIntervalKm
  ? '<div class="flash flash-warn" role="status" data-testid="service-overdue">This vehicle is past its service interval.</div>' : ''}
${tabs('vehicle', [
  { key: 'summary', label: 'Summary', body: `<div class="panel">${kv([
    ['Registration', h(vehicle.registration)],
    ['Type', h(vehicle.type)],
    ['Capacity', `${vehicle.capacityPallets} pallets`],
    ['Temperature controlled', vehicle.temperatureControlled ? 'Yes' : 'No'],
    ['Home depot', h(warehouse(vehicle.depotId)?.name ?? '—')],
    ['MOT expires', shortDate(vehicle.motExpiresOn)],
    ['Tax expires', shortDate(vehicle.taxExpiresOn)]
  ])}</div>` },
  { key: 'routes', label: `Routes (${routes.length})`, body: `<div class="panel">${table({
    caption: 'Routes this vehicle is planned on', testId: 'vehicle-routes', empty: 'Not planned on any route.',
    columns: [
      { header: 'Route', cell: row => `<button type="button" class="btn btn-secondary" style="padding:2px 8px"
          data-route="/routes/${h(row.id)}" data-testid="vehicle-route-${h(row.id)}">${h(row.reference)}</button>` },
      { header: 'Date', cell: row => shortDate(row.planDate) },
      { header: 'Stops', cell: row => String(row.stops.length) },
      { header: 'Utilisation', cell: row => `${row.utilisationPct}%` },
      { header: 'Status', cell: row => statusPill(row.status) }
    ],
    rows: routes
  })}</div>` }
])}`
      };
    }
  });

  definePage({
    path: '/fleet/drivers', domain: 'fleet', title: 'Drivers', kind: 'list',
    view: () => ({
      title: 'Drivers',
      breadcrumbs: [{ label: 'Fleet', href: '/fleet' }, { label: 'Drivers' }],
      actions: `<button class="btn" type="button" data-route="/fleet/drivers/new" data-testid="add-driver">Add a driver</button>`,
      body: `${table({
        caption: 'Every driver', testId: 'drivers-table',
        columns: [
          { header: 'Name', cell: row => `<button type="button" class="btn btn-secondary" style="padding:2px 8px"
              data-route="/fleet/drivers/${h(row.id)}" data-testid="open-driver-${h(row.id)}">${h(row.name)}</button>` },
          { header: 'Licence', cell: row => `<code>${h(row.licenceNumber)}</code>` },
          { header: 'Categories', cell: row => row.licenceCategories.map(h).join(', ') },
          { header: 'Licence expires', cell: row => shortDate(row.licenceExpiresOn) },
          { header: 'ADR', cell: row => row.adrCertified ? '<span class="pill pill-ok">Certified</span>' : '<span class="pill pill-muted">No</span>' },
          { header: 'Hours', cell: row => {
              const pct = Math.round((row.hoursThisWeek / row.maxWeeklyHours) * 100);
              return `${row.hoursThisWeek} / ${row.maxWeeklyHours} <span class="pill pill-${pct > 90 ? 'danger' : pct > 75 ? 'warn' : 'ok'}">${pct}%</span>`;
            } },
          { header: 'Depot', cell: row => h(warehouse(row.depotId)?.code ?? '—') },
          { header: 'Status', cell: row => statusPill(row.status) }
        ],
        rows: state.drivers
      })}`
    })
  });

  definePage({
    path: '/fleet/drivers/new', domain: 'fleet', title: 'Add a driver', kind: 'form',
    view: (ctx) => ({
      title: 'Add a driver',
      breadcrumbs: [{ label: 'Fleet', href: '/fleet' }, { label: 'Drivers', href: '/fleet/drivers' }, { label: 'Add' }],
      body: `<div class="panel" style="max-width:580px">
<form method="post" action="/fleet/drivers/new" data-testid="new-driver-form">
${csrfField(ctx)}
${field({ name: 'name', label: 'Full name', required: true, testId: 'driver-name', attrs: { maxlength: '100' } })}
${field({ name: 'licenceNumber', label: 'Licence number', required: true, testId: 'driver-licence', attrs: { maxlength: '20' } })}
${field({ name: 'licenceExpiresOn', label: 'Licence expires on', type: 'date', required: true, testId: 'driver-licence-expiry' })}
${field({ name: 'cpcExpiresOn', label: 'Driver CPC expires on', type: 'date', required: true, testId: 'driver-cpc-expiry' })}
${field({ name: 'depotId', label: 'Home depot', required: true, testId: 'driver-depot',
  options: [{ value: '', label: 'Choose a depot' }, ...state.warehouses.map(w => ({ value: w.id, label: w.name }))] })}
${field({ name: 'maxWeeklyHours', label: 'Maximum weekly hours', type: 'number', value: 56, required: true, testId: 'driver-max-hours',
  attrs: { min: '1', max: '60', step: '1' }, hint: 'Legal maximum is 60 in a single week.' })}
${field({ name: 'adrCertified', label: 'ADR certified for hazardous goods', type: 'checkbox', testId: 'driver-adr' })}
<button class="btn" type="submit" data-testid="driver-submit">Add driver</button>
</form></div>`
    })
  });

  app.post('/fleet/drivers/new', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    const name = String(body.name ?? '').trim();
    const hours = Number(body.maxWeeklyHours);
    if (!name || !Number.isInteger(hours) || hours < 1 || hours > 60) {
      setFlash(ctx, 'error', 'A name and a weekly hours limit between 1 and 60 are required.');
      return ctx.redirect('/fleet/drivers/new');
    }
    const created = {
      id: `drv-${String(state.drivers.length + 1).padStart(3, '0')}`,
      name, licenceNumber: String(body.licenceNumber ?? ''),
      licenceCategories: ['C'], licenceExpiresOn: String(body.licenceExpiresOn),
      cpcExpiresOn: String(body.cpcExpiresOn), adrCertified: body.adrCertified === 'on',
      status: 'available', depotId: String(body.depotId), hoursThisWeek: 0, maxWeeklyHours: hours
    };
    state.drivers.push(created);
    setFlash(ctx, 'success', `${created.name} added.`);
    return ctx.redirect(`/fleet/drivers/${created.id}`);
  });

  definePage({
    path: '/fleet/drivers/:id', domain: 'fleet', title: 'Driver', kind: 'detail',
    view: (ctx) => {
      const driver = findDriver(ctx.params.id);
      if (!driver) return { status: 404, title: 'Not found', body: '<div class="panel"><div class="empty" data-testid="not-found">No such driver.</div></div>' };
      const routes = state.routePlans.filter(r => r.driverId === driver.id);
      const hoursPct = Math.round((driver.hoursThisWeek / driver.maxWeeklyHours) * 100);
      return {
        title: driver.name,
        breadcrumbs: [{ label: 'Fleet', href: '/fleet' }, { label: 'Drivers', href: '/fleet/drivers' }, { label: driver.name }],
        body: `<div class="grid grid-4" style="margin-bottom:14px">
${stat(statusPill(driver.status), 'Status', 'driver-status')}
${stat(`${driver.hoursThisWeek} / ${driver.maxWeeklyHours}`, `Hours this week (${hoursPct}%)`, 'driver-hours')}
${stat(shortDate(driver.licenceExpiresOn), 'Licence expires', 'driver-licence-expiry')}
${stat(driver.adrCertified ? 'Yes' : 'No', 'ADR certified', 'driver-adr')}
</div>
<div class="panel">${kv([
  ['Licence number', `<code>${h(driver.licenceNumber)}</code>`],
  ['Categories', driver.licenceCategories.map(h).join(', ')],
  ['Licence expires', shortDate(driver.licenceExpiresOn)],
  ['CPC expires', shortDate(driver.cpcExpiresOn)],
  ['Home depot', h(warehouse(driver.depotId)?.name ?? '—')]
])}</div>
<div class="panel"><h3 style="margin-top:0">Routes</h3>
${table({
  caption: 'Routes this driver is planned on', testId: 'driver-routes', empty: 'Not planned on any route.',
  columns: [
    { header: 'Route', cell: row => `<button type="button" class="btn btn-secondary" style="padding:2px 8px"
        data-route="/routes/${h(row.id)}" data-testid="driver-route-${h(row.id)}">${h(row.reference)}</button>` },
    { header: 'Date', cell: row => shortDate(row.planDate) },
    { header: 'Distance', cell: row => `${row.plannedDistanceKm} km` },
    { header: 'Duration', cell: row => `${Math.floor(row.plannedDurationMinutes / 60)}h ${row.plannedDurationMinutes % 60}m` },
    { header: 'Status', cell: row => statusPill(row.status) }
  ],
  rows: routes
})}</div>`
      };
    }
  });

  definePage({
    path: '/fleet/maintenance', domain: 'fleet', title: 'Maintenance', kind: 'list',
    view: () => {
      const rows = state.vehicles.map(vehicle => ({
        vehicle,
        sinceService: vehicle.odometerKm - vehicle.lastServiceOdometerKm,
        overdue: vehicle.odometerKm - vehicle.lastServiceOdometerKm > vehicle.serviceIntervalKm
      })).sort((a, b) => b.sinceService - a.sinceService);
      return {
        title: 'Maintenance',
        breadcrumbs: [{ label: 'Fleet', href: '/fleet' }, { label: 'Maintenance' }],
        body: `<div class="panel">${table({
          caption: 'Vehicles ordered by distance since their last service', testId: 'maintenance-table',
          columns: [
            { header: 'Vehicle', cell: row => h(row.vehicle.registration) },
            { header: 'Type', cell: row => h(row.vehicle.type) },
            { header: 'Odometer', cell: row => `${row.vehicle.odometerKm.toLocaleString('en-GB')} km` },
            { header: 'Since service', cell: row => `${row.sinceService.toLocaleString('en-GB')} km` },
            { header: 'Interval', cell: row => `${row.vehicle.serviceIntervalKm.toLocaleString('en-GB')} km` },
            { header: 'Service', cell: row => row.overdue
              ? '<span class="pill pill-danger">Overdue</span>'
              : row.sinceService > row.vehicle.serviceIntervalKm * 0.9
                ? '<span class="pill pill-warn">Due soon</span>'
                : '<span class="pill pill-ok">In interval</span>' },
            { header: 'Status', cell: row => statusPill(row.vehicle.status) }
          ],
          rows
        })}</div>`
      };
    }
  });

  definePage({
    path: '/fleet/inspections', domain: 'fleet', title: 'Daily inspections', kind: 'form',
    view: (ctx) => ({
      title: 'Daily inspections',
      breadcrumbs: [{ label: 'Fleet', href: '/fleet' }, { label: 'Inspections' }],
      body: `<div class="panel" style="max-width:580px">
<p class="hint">A walk-round check is required before a vehicle leaves the depot. A defect takes it off road.</p>
<form method="post" action="/fleet/inspections" data-testid="inspection-form">
${csrfField(ctx)}
${field({ name: 'vehicleId', label: 'Vehicle', required: true, testId: 'inspection-vehicle',
  options: [{ value: '', label: 'Choose a vehicle' }, ...state.vehicles.map(v => ({ value: v.id, label: v.registration }))] })}
${field({ name: 'driverId', label: 'Inspected by', required: true, testId: 'inspection-driver',
  options: [{ value: '', label: 'Choose a driver' }, ...state.drivers.map(d => ({ value: d.id, label: d.name }))] })}
${field({ name: 'tyres', label: 'Tyres and wheels satisfactory', type: 'checkbox', testId: 'inspection-tyres' })}
${field({ name: 'lights', label: 'Lights and indicators satisfactory', type: 'checkbox', testId: 'inspection-lights' })}
${field({ name: 'brakes', label: 'Brakes satisfactory', type: 'checkbox', testId: 'inspection-brakes' })}
${field({ name: 'bodywork', label: 'Bodywork and load security satisfactory', type: 'checkbox', testId: 'inspection-bodywork' })}
${field({ name: 'defects', label: 'Defects found', type: 'textarea', testId: 'inspection-defects',
  attrs: { maxlength: '600' }, hint: 'Leave blank if none. Anything here takes the vehicle off road.' })}
<button class="btn" type="submit" data-testid="inspection-submit">Record inspection</button>
</form></div>`
    })
  });

  app.post('/fleet/inspections', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    const body = await ctx.body();
    const vehicle = findVehicle(String(body.vehicleId ?? ''));
    if (!vehicle) {
      setFlash(ctx, 'error', 'Choose a vehicle.');
      return ctx.redirect('/fleet/inspections');
    }
    const defects = String(body.defects ?? '').trim();
    // Correct: a recorded defect takes the vehicle off road rather than being filed away.
    if (defects) {
      vehicle.status = 'offRoad';
      setFlash(ctx, 'warn', `${vehicle.registration} has been taken off road: a defect was recorded.`);
    } else {
      const checks = ['tyres', 'lights', 'brakes', 'bodywork'].filter(key => body[key] !== 'on');
      if (checks.length) {
        setFlash(ctx, 'error', `${checks.length} check(s) were not confirmed. Record a defect or confirm every item.`);
        return ctx.redirect('/fleet/inspections');
      }
      setFlash(ctx, 'success', `${vehicle.registration} passed its walk-round check.`);
    }
    return ctx.redirect('/fleet/inspections');
  });

  definePage({
    path: '/fleet/compliance', domain: 'fleet', title: 'Fleet compliance', kind: 'report',
    view: () => {
      const cutoff = Date.parse('2026-04-01');
      return {
        title: 'Fleet compliance',
        breadcrumbs: [{ label: 'Fleet', href: '/fleet' }, { label: 'Compliance' }],
        body: `<div class="panel"><h2 style="margin-top:0">Vehicle documents</h2>
${table({
  caption: 'MOT and tax expiry by vehicle', testId: 'vehicle-compliance',
  columns: [
    { header: 'Vehicle', cell: row => h(row.registration) },
    { header: 'MOT expires', cell: row => shortDate(row.motExpiresOn) },
    { header: 'Tax expires', cell: row => shortDate(row.taxExpiresOn) },
    { header: 'MOT', cell: row => Date.parse(row.motExpiresOn) < cutoff
      ? '<span class="pill pill-danger">Expiring</span>' : '<span class="pill pill-ok">Valid</span>' }
  ],
  rows: state.vehicles
})}</div>
<div class="panel"><h2 style="margin-top:0">Driver documents</h2>
${table({
  caption: 'Licence and CPC expiry by driver', testId: 'driver-compliance',
  columns: [
    { header: 'Driver', cell: row => h(row.name) },
    { header: 'Licence expires', cell: row => shortDate(row.licenceExpiresOn) },
    { header: 'CPC expires', cell: row => shortDate(row.cpcExpiresOn) },
    { header: 'Hours', cell: row => `${row.hoursThisWeek} / ${row.maxWeeklyHours}` },
    { header: 'Licence', cell: row => Date.parse(row.licenceExpiresOn) < cutoff
      ? '<span class="pill pill-danger">Expiring</span>' : '<span class="pill pill-ok">Valid</span>' }
  ],
  rows: state.drivers
})}</div>`
      };
    }
  });
}
