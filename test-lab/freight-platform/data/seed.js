/**
 * Meridian Freight — seeded domain data.
 *
 * Deterministic: a pseudo-random generator with a fixed seed, so every run of the platform
 * produces byte-identical data. A test lab whose data moves is a test lab that cannot tell
 * a regression from a Tuesday.
 *
 * Synthetic: every identifier follows a documentation-reserved or obviously-invented
 * pattern. Company names are invented, the IBANs are not valid, the HS codes are real
 * chapter numbers used against invented goods, and no address resolves to a real building.
 * Nothing here can be mistaken for, or used against, a real freight operation.
 */

/** Mulberry32 — small, fast, and identical on every platform. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(0x4D455249); // "MERI"
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (low, high) => low + Math.floor(random() * (high - low + 1));
const money = (low, high) => Math.round((low + random() * (high - low)) * 100) / 100;

/** A fixed clock. Every date in the lab is relative to this instant, never to "now". */
export const EPOCH = Date.parse('2026-03-02T08:00:00Z');
const day = 86_400_000;
const at = (offsetDays, hours = 9) =>
  new Date(EPOCH + offsetDays * day + hours * 3_600_000).toISOString();
const dateOnly = (offsetDays) => at(offsetDays).slice(0, 10);

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export const COUNTRIES = [
  { code: 'GB', name: 'United Kingdom', eu: false, currency: 'GBP' },
  { code: 'NL', name: 'Netherlands', eu: true, currency: 'EUR' },
  { code: 'DE', name: 'Germany', eu: true, currency: 'EUR' },
  { code: 'FR', name: 'France', eu: true, currency: 'EUR' },
  { code: 'ES', name: 'Spain', eu: true, currency: 'EUR' },
  { code: 'PL', name: 'Poland', eu: true, currency: 'PLN' },
  { code: 'IE', name: 'Ireland', eu: true, currency: 'EUR' },
  { code: 'US', name: 'United States', eu: false, currency: 'USD' },
  { code: 'CN', name: 'China', eu: false, currency: 'CNY' },
  { code: 'IN', name: 'India', eu: false, currency: 'INR' }
];

export const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];

export const SERVICE_LEVELS = [
  { code: 'ECON', name: 'Economy', transitDays: 6, surchargePct: 0 },
  { code: 'STD', name: 'Standard', transitDays: 4, surchargePct: 8 },
  { code: 'EXP', name: 'Express', transitDays: 2, surchargePct: 22 },
  { code: 'NDAY', name: 'Next day', transitDays: 1, surchargePct: 45 },
  { code: 'TEMP', name: 'Temperature controlled', transitDays: 3, surchargePct: 60 }
];

export const HS_CODES = [
  { code: '8471.30', description: 'Portable data-processing machines', dutyPct: 0 },
  { code: '6109.10', description: 'T-shirts, cotton, knitted', dutyPct: 12 },
  { code: '9403.20', description: 'Other metal furniture', dutyPct: 2.7 },
  { code: '3304.99', description: 'Beauty or make-up preparations', dutyPct: 6.5 },
  { code: '8708.29', description: 'Parts and accessories of motor vehicle bodies', dutyPct: 4.5 },
  { code: '2208.70', description: 'Liqueurs and cordials', dutyPct: 0, excise: true },
  { code: '3002.15', description: 'Immunological products, in doses', dutyPct: 0, controlled: true },
  { code: '8517.13', description: 'Smartphones', dutyPct: 0 },
  { code: '0406.90', description: 'Cheese, other', dutyPct: 14.5, perishable: true },
  { code: '7113.19', description: 'Jewellery of other precious metal', dutyPct: 2.5, highValue: true }
];

export const SHIPMENT_STATUSES = [
  'draft', 'booked', 'collected', 'inTransit', 'customsHold', 'outForDelivery',
  'delivered', 'exception', 'cancelled'
];

const CITY_BY_COUNTRY = {
  GB: ['Felixstowe', 'Manchester', 'Bristol', 'Leeds', 'Glasgow'],
  NL: ['Rotterdam', 'Eindhoven', 'Tilburg'],
  DE: ['Hamburg', 'Duisburg', 'Munich'],
  FR: ['Le Havre', 'Lyon', 'Lille'],
  ES: ['Valencia', 'Zaragoza'],
  PL: ['Gdansk', 'Poznan'],
  IE: ['Dublin', 'Cork'],
  US: ['Newark', 'Savannah', 'Houston'],
  CN: ['Ningbo', 'Shenzhen', 'Qingdao'],
  IN: ['Mundra', 'Chennai']
};

const addressFor = (countryCode, index) => {
  const country = COUNTRIES.find(c => c.code === countryCode);
  const city = CITY_BY_COUNTRY[countryCode][index % CITY_BY_COUNTRY[countryCode].length];
  return {
    line1: `Unit ${between(1, 80)}, ${pick(['Dock', 'Quay', 'Freight', 'Transit', 'Cargo'])} ${pick(['Road', 'Way', 'Park', 'Estate'])}`,
    line2: pick(['', '', `Building ${pick('ABCDEF')}`]),
    city,
    postcode: countryCode === 'GB'
      ? `${pick(['IP11', 'M17', 'BS11', 'LS10', 'G51'])} ${between(1, 9)}${pick('ABDEFGHJLNPQRSTUWXYZ')}${pick('ABDEFGHJLNPQRSTUWXYZ')}`
      : String(between(10000, 99999)),
    countryCode,
    country: country.name
  };
};

// ---------------------------------------------------------------------------
// People and access
// ---------------------------------------------------------------------------

/**
 * Passwords are stored and compared in clear text. This is a lab: the point is that a test
 * can sign in, not that the sign-in is well built. Nothing here is a credential for
 * anything that exists.
 */
export const users = [
  { id: 'usr-001', username: 'ops.lead', password: 'Freight!2026', displayName: 'Rowan Vasquez', email: 'ops.lead@meridian.test', role: 'operations', team: 'Control tower', status: 'active', mfa: false, lastSeenAt: at(-1) },
  { id: 'usr-002', username: 'warehouse', password: 'Freight!2026', displayName: 'Jun Park', email: 'warehouse@meridian.test', role: 'warehouse', team: 'Felixstowe DC', status: 'active', mfa: false, lastSeenAt: at(-1, 6) },
  { id: 'usr-003', username: 'finance', password: 'Freight!2026', displayName: 'Marta Oyelaran', email: 'finance@meridian.test', role: 'finance', team: 'Revenue', status: 'active', mfa: true, lastSeenAt: at(-2) },
  { id: 'usr-004', username: 'customs', password: 'Freight!2026', displayName: 'Tomas Linde', email: 'customs@meridian.test', role: 'customs', team: 'Compliance', status: 'active', mfa: false, lastSeenAt: at(-3) },
  { id: 'usr-005', username: 'admin', password: 'Freight!2026', displayName: 'Sasha Bright', email: 'admin@meridian.test', role: 'administrator', team: 'Platform', status: 'active', mfa: false, lastSeenAt: at(0, 7) },
  { id: 'usr-006', username: 'readonly', password: 'Freight!2026', displayName: 'Audit Viewer', email: 'readonly@meridian.test', role: 'viewer', team: 'Internal audit', status: 'active', mfa: false, lastSeenAt: at(-9) },
  { id: 'usr-007', username: 'suspended', password: 'Freight!2026', displayName: 'Dana Cruz', email: 'suspended@meridian.test', role: 'operations', team: 'Control tower', status: 'suspended', mfa: false, lastSeenAt: at(-40) },
  { id: 'usr-008', username: 'driver.ops', password: 'Freight!2026', displayName: 'Ife Adeyemi', email: 'driver.ops@meridian.test', role: 'fleet', team: 'Fleet', status: 'active', mfa: false, lastSeenAt: at(-1, 5) }
];

export const roles = [
  { id: 'role-operations', name: 'Operations', description: 'Books and tracks shipments, resolves exceptions.', userCount: 2 },
  { id: 'role-warehouse', name: 'Warehouse', description: 'Receives, puts away, picks and packs stock.', userCount: 1 },
  { id: 'role-finance', name: 'Finance', description: 'Invoices, credit notes, disputes and rates.', userCount: 1 },
  { id: 'role-customs', name: 'Customs', description: 'Declarations, classifications and holds.', userCount: 1 },
  { id: 'role-fleet', name: 'Fleet', description: 'Vehicles, drivers, maintenance and assignment.', userCount: 1 },
  { id: 'role-administrator', name: 'Administrator', description: 'Everything, including user management.', userCount: 1 },
  { id: 'role-viewer', name: 'Viewer', description: 'Reads everything, changes nothing.', userCount: 1 }
];

export const PERMISSIONS = [
  'shipment:read', 'shipment:write', 'shipment:cancel',
  'order:read', 'order:write', 'order:approve',
  'stock:read', 'stock:adjust', 'stock:transfer',
  'carrier:read', 'carrier:write', 'carrier:rates',
  'fleet:read', 'fleet:write',
  'route:read', 'route:plan', 'route:dispatch',
  'customer:read', 'customer:write', 'customer:credit',
  'invoice:read', 'invoice:write', 'invoice:credit',
  'customs:read', 'customs:write', 'customs:release',
  'claim:read', 'claim:write', 'claim:settle',
  'admin:users', 'admin:roles', 'admin:settings', 'admin:audit'
];

/** Which permissions each role holds. The matrix screen renders this, and the journey
 *  that checks a viewer cannot settle a claim depends on it. */
export const rolePermissions = {
  'role-operations': ['shipment:read', 'shipment:write', 'shipment:cancel', 'order:read', 'stock:read', 'carrier:read', 'route:read', 'route:plan', 'customer:read', 'claim:read', 'claim:write', 'customs:read'],
  'role-warehouse': ['stock:read', 'stock:adjust', 'stock:transfer', 'shipment:read', 'order:read', 'fleet:read'],
  'role-finance': ['invoice:read', 'invoice:write', 'invoice:credit', 'customer:read', 'customer:credit', 'carrier:read', 'carrier:rates', 'claim:read', 'claim:settle', 'shipment:read', 'order:read'],
  'role-customs': ['customs:read', 'customs:write', 'customs:release', 'shipment:read', 'order:read'],
  'role-fleet': ['fleet:read', 'fleet:write', 'route:read', 'route:dispatch', 'shipment:read'],
  'role-administrator': [...PERMISSIONS],
  'role-viewer': PERMISSIONS.filter(p => p.endsWith(':read'))
};

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const CUSTOMER_NAMES = [
  'Halvorsen Components', 'Brightwater Foods', 'Pennine Textiles', 'Ardent Pharma',
  'Northgate Electronics', 'Verity Cosmetics', 'Castlereagh Spirits', 'Lumen Furnishings',
  'Quayside Seafood', 'Orrin Automotive', 'Bellweather Toys', 'Sable & Finch Jewellery'
];

export const customers = CUSTOMER_NAMES.map((name, index) => {
  const countryCode = pick(['GB', 'GB', 'GB', 'NL', 'DE', 'FR', 'IE']);
  const creditLimit = [25_000, 50_000, 100_000, 250_000, 500_000][index % 5];
  const balance = money(0, creditLimit * 0.9);
  return {
    id: `cus-${String(index + 1).padStart(3, '0')}`,
    reference: `MC${String(4100 + index * 7)}`,
    name,
    status: index === 9 ? 'onHold' : index === 11 ? 'prospect' : 'active',
    tier: ['bronze', 'silver', 'gold', 'platinum'][index % 4],
    vatNumber: `${countryCode}${between(100000000, 999999999)}`,
    address: addressFor(countryCode, index),
    creditLimit,
    creditUsed: Math.round(balance * 100) / 100,
    paymentTermsDays: [14, 30, 30, 45, 60][index % 5],
    accountManagerId: users[index % 3].id,
    slaOnTimePct: 92 + (index % 8),
    createdAt: at(-400 + index * 11),
    contacts: [
      { id: `con-${index + 1}-a`, name: `${pick(['Alex', 'Priya', 'Mo', 'Kat', 'Sam'])} ${pick(['Reyes', 'Nowak', 'Hassan', 'Byrne', 'Osei'])}`, role: 'Logistics manager', email: `logistics${index + 1}@${name.toLowerCase().replace(/[^a-z]/g, '')}.test`, phone: `+44 20 7946 ${String(1000 + index).padStart(4, '0')}`, primary: true },
      { id: `con-${index + 1}-b`, name: `${pick(['Jo', 'Lena', 'Ravi', 'Erik'])} ${pick(['Doyle', 'Kaur', 'Mbeki', 'Lund'])}`, role: 'Accounts payable', email: `ap${index + 1}@${name.toLowerCase().replace(/[^a-z]/g, '')}.test`, phone: `+44 20 7946 ${String(2000 + index).padStart(4, '0')}`, primary: false }
    ],
    addresses: [
      { id: `adr-${index + 1}-1`, label: 'Head office', ...addressFor(countryCode, index), isDefault: true },
      { id: `adr-${index + 1}-2`, label: 'Distribution centre', ...addressFor(countryCode, index + 3), isDefault: false }
    ]
  };
});

// ---------------------------------------------------------------------------
// Carriers
// ---------------------------------------------------------------------------

const CARRIER_NAMES = [
  'Tyne Haulage', 'EuroLink Freight', 'Baltic Road', 'Meridian Own Fleet',
  'Cascade Air Cargo', 'Southern Cross Sea', 'Pinnacle Express', 'Dunmore Logistics'
];

export const carriers = CARRIER_NAMES.map((name, index) => ({
  id: `car-${String(index + 1).padStart(3, '0')}`,
  code: name.split(' ').map(w => w[0]).join('').toUpperCase() + String(index + 1),
  name,
  mode: ['road', 'road', 'road', 'road', 'air', 'sea', 'road', 'road'][index],
  status: index === 7 ? 'suspended' : 'active',
  ownFleet: index === 3,
  scacCode: `MF${String(index + 10)}`,
  contactEmail: `bookings@${name.toLowerCase().replace(/[^a-z]/g, '')}.test`,
  contactPhone: `+44 161 496 ${String(1000 + index).padStart(4, '0')}`,
  onTimePct: 88 + (index % 11),
  damageRatePct: Math.round((0.2 + (index % 5) * 0.3) * 10) / 10,
  claimsOpen: index % 4,
  insuranceExpiry: dateOnly(index === 2 ? 11 : 120 + index * 15),
  contracts: [
    {
      id: `ctr-${index + 1}`,
      reference: `CT-${2026}-${String(index + 1).padStart(3, '0')}`,
      startsOn: dateOnly(-300),
      endsOn: dateOnly(index === 2 ? 20 : 180),
      status: index === 7 ? 'expired' : 'active',
      minimumVolumePerMonth: between(20, 200),
      penaltyPerLateDeliveryGbp: money(15, 80)
    }
  ],
  serviceLevels: SERVICE_LEVELS.filter((_, i) => (i + index) % 3 !== 0).map(s => s.code)
}));

// ---------------------------------------------------------------------------
// Warehouses, zones, bins, stock
// ---------------------------------------------------------------------------

export const warehouses = [
  { id: 'wh-fxt', code: 'FXT', name: 'Felixstowe DC', countryCode: 'GB', capacityPallets: 12_000, usedPallets: 9_380, temperatureControlled: true, bondedStore: true },
  { id: 'wh-mcr', code: 'MCR', name: 'Manchester Hub', countryCode: 'GB', capacityPallets: 7_500, usedPallets: 4_120, temperatureControlled: false, bondedStore: false },
  { id: 'wh-rtm', code: 'RTM', name: 'Rotterdam Crossdock', countryCode: 'NL', capacityPallets: 5_000, usedPallets: 4_890, temperatureControlled: true, bondedStore: true },
  { id: 'wh-dub', code: 'DUB', name: 'Dublin Satellite', countryCode: 'IE', capacityPallets: 2_000, usedPallets: 410, temperatureControlled: false, bondedStore: false }
];

export const zones = warehouses.flatMap(wh =>
  ['Receiving', 'Bulk', 'Pick face', 'Despatch', ...(wh.temperatureControlled ? ['Chilled'] : [])].map((zoneName, i) => ({
    id: `zone-${wh.code.toLowerCase()}-${i + 1}`,
    warehouseId: wh.id,
    code: `${wh.code}-Z${i + 1}`,
    name: zoneName,
    binCount: between(20, 120),
    temperatureMinC: zoneName === 'Chilled' ? 2 : null,
    temperatureMaxC: zoneName === 'Chilled' ? 8 : null
  }))
);

export const skus = HS_CODES.map((hs, index) => ({
  id: `sku-${String(index + 1).padStart(3, '0')}`,
  code: `MF-${String(1000 + index * 37)}`,
  description: hs.description,
  hsCode: hs.code,
  customerId: customers[index % customers.length].id,
  unitOfMeasure: pick(['each', 'case', 'pallet']),
  weightKg: Math.round((0.2 + random() * 24) * 100) / 100,
  volumeM3: Math.round((0.001 + random() * 1.4) * 1000) / 1000,
  hazardous: index === 5,
  perishable: Boolean(hs.perishable),
  highValue: Boolean(hs.highValue),
  controlled: Boolean(hs.controlled),
  unitValueGbp: money(4, 900)
}));

export const stock = [];
for (const wh of warehouses) {
  for (const sku of skus) {
    if (random() < 0.35) continue;
    const zone = zones.filter(z => z.warehouseId === wh.id)[between(0, 2)];
    const onHand = between(0, 2400);
    const allocated = Math.min(onHand, between(0, 400));
    stock.push({
      id: `stk-${wh.code.toLowerCase()}-${sku.id}`,
      warehouseId: wh.id,
      zoneId: zone.id,
      bin: `${zone.code}-${String(between(1, 60)).padStart(3, '0')}`,
      skuId: sku.id,
      onHand,
      allocated,
      available: onHand - allocated,
      reorderPoint: between(50, 300),
      lastCountedAt: at(-between(1, 120)),
      batchNumber: `B${between(10000, 99999)}`,
      expiresOn: sku.perishable ? dateOnly(between(5, 90)) : null
    });
  }
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

export const vehicles = Array.from({ length: 14 }, (_, index) => ({
  id: `veh-${String(index + 1).padStart(3, '0')}`,
  registration: `MF${between(10, 99)} ${pick('ABCDEFGHJKLMNOPRSTUVWXYZ')}${pick('ABCDEFGHJKLMNOPRSTUVWXYZ')}${pick('ABCDEFGHJKLMNOPRSTUVWXYZ')}`,
  type: ['rigid18t', 'artic44t', 'van3.5t', 'rigid7.5t', 'reefer44t'][index % 5],
  capacityPallets: [10, 26, 4, 8, 24][index % 5],
  temperatureControlled: index % 5 === 4,
  status: index === 3 ? 'inMaintenance' : index === 11 ? 'offRoad' : 'available',
  depotId: warehouses[index % warehouses.length].id,
  odometerKm: between(40_000, 480_000),
  motExpiresOn: dateOnly(index === 6 ? 9 : between(40, 330)),
  taxExpiresOn: dateOnly(between(30, 300)),
  lastServiceOdometerKm: between(30_000, 440_000),
  serviceIntervalKm: 25_000
}));

export const drivers = Array.from({ length: 12 }, (_, index) => ({
  id: `drv-${String(index + 1).padStart(3, '0')}`,
  name: `${pick(['Niamh', 'Tomasz', 'Yusuf', 'Carla', 'Dmitri', 'Grace', 'Bilal', 'Ewa'])} ${pick(['Quinn', 'Zielinski', 'Farah', 'Mendez', 'Volkov', 'Appiah', 'Rahman', 'Nowicka'])}`,
  licenceNumber: `MERID${String(600000 + index * 137)}`,
  licenceCategories: pick([['C', 'CE'], ['C'], ['C1'], ['C', 'CE', 'ADR']]),
  licenceExpiresOn: dateOnly(index === 4 ? 14 : between(90, 900)),
  cpcExpiresOn: dateOnly(between(60, 800)),
  adrCertified: index % 4 === 0,
  status: index === 9 ? 'onLeave' : 'available',
  depotId: warehouses[index % warehouses.length].id,
  hoursThisWeek: Math.round((random() * 48) * 10) / 10,
  maxWeeklyHours: 56
}));

// ---------------------------------------------------------------------------
// Orders, shipments, routes
// ---------------------------------------------------------------------------

export const salesOrders = Array.from({ length: 26 }, (_, index) => {
  const customer = customers[index % customers.length];
  const lineCount = between(1, 4);
  const lines = Array.from({ length: lineCount }, (_, lineIndex) => {
    const sku = skus[(index + lineIndex) % skus.length];
    const quantity = between(1, 180);
    return {
      id: `sol-${index + 1}-${lineIndex + 1}`,
      skuId: sku.id,
      skuCode: sku.code,
      description: sku.description,
      quantity,
      unitPriceGbp: sku.unitValueGbp,
      lineTotalGbp: Math.round(quantity * sku.unitValueGbp * 100) / 100
    };
  });
  const total = Math.round(lines.reduce((sum, l) => sum + l.lineTotalGbp, 0) * 100) / 100;
  return {
    id: `so-${String(index + 1).padStart(4, '0')}`,
    reference: `SO-2026-${String(1200 + index)}`,
    customerId: customer.id,
    status: ['draft', 'awaitingApproval', 'approved', 'allocated', 'dispatched', 'invoiced', 'cancelled'][index % 7],
    placedAt: at(-between(1, 60)),
    requestedDeliveryOn: dateOnly(between(1, 30)),
    incoterm: pick(INCOTERMS),
    serviceLevel: pick(SERVICE_LEVELS).code,
    deliveryAddressId: customer.addresses[index % 2].id,
    currency: 'GBP',
    lines,
    subtotalGbp: total,
    vatGbp: Math.round(total * 0.2 * 100) / 100,
    totalGbp: Math.round(total * 1.2 * 100) / 100,
    requiresApproval: total > 50_000,
    approvedByUserId: index % 7 >= 2 ? users[0].id : null,
    notes: index % 5 === 0 ? 'Customer asked for a delivery window before 11:00.' : ''
  };
});

export const purchaseOrders = Array.from({ length: 18 }, (_, index) => {
  const lineCount = between(1, 3);
  const lines = Array.from({ length: lineCount }, (_, lineIndex) => {
    const sku = skus[(index * 2 + lineIndex) % skus.length];
    const quantity = between(50, 900);
    return {
      id: `pol-${index + 1}-${lineIndex + 1}`,
      skuId: sku.id,
      skuCode: sku.code,
      description: sku.description,
      quantityOrdered: quantity,
      quantityReceived: index % 4 === 0 ? between(0, quantity) : 0,
      unitCostGbp: Math.round(sku.unitValueGbp * 0.6 * 100) / 100
    };
  });
  return {
    id: `po-${String(index + 1).padStart(4, '0')}`,
    reference: `PO-2026-${String(800 + index)}`,
    supplierName: pick(['Kestrel Supply Co', 'Arnside Materials', 'Fairview Imports', 'Holt & Grange']),
    warehouseId: warehouses[index % warehouses.length].id,
    status: ['draft', 'sent', 'partiallyReceived', 'received', 'closed'][index % 5],
    raisedAt: at(-between(5, 90)),
    expectedOn: dateOnly(between(-10, 25)),
    lines,
    totalGbp: Math.round(lines.reduce((s, l) => s + l.quantityOrdered * l.unitCostGbp, 0) * 100) / 100
  };
});

export const shipments = Array.from({ length: 40 }, (_, index) => {
  const customer = customers[index % customers.length];
  const carrier = carriers[index % carriers.length];
  const origin = warehouses[index % warehouses.length];
  const status = SHIPMENT_STATUSES[index % SHIPMENT_STATUSES.length];
  const serviceLevel = SERVICE_LEVELS[index % SERVICE_LEVELS.length];
  const pieces = between(1, 28);
  const weightKg = Math.round((pieces * (4 + random() * 60)) * 10) / 10;
  const collectedOffset = -between(1, 25);
  return {
    id: `shp-${String(index + 1).padStart(4, '0')}`,
    reference: `MF${String(770_000 + index * 13)}`,
    trackingNumber: `1Z${String(index).padStart(3, '0')}MERIDIAN${String(index * 7919 % 100000).padStart(5, '0')}`,
    customerId: customer.id,
    salesOrderId: index < salesOrders.length ? salesOrders[index].id : null,
    carrierId: carrier.id,
    status,
    serviceLevel: serviceLevel.code,
    incoterm: pick(INCOTERMS),
    originWarehouseId: origin.id,
    destination: customer.addresses[index % 2],
    pieces,
    weightKg,
    volumeM3: Math.round(pieces * (0.08 + random() * 0.9) * 1000) / 1000,
    declaredValueGbp: money(500, 85_000),
    hazardous: index % 11 === 5,
    temperatureControlled: serviceLevel.code === 'TEMP',
    bookedAt: at(collectedOffset - 1),
    collectedAt: ['draft', 'booked', 'cancelled'].includes(status) ? null : at(collectedOffset),
    estimatedDeliveryOn: dateOnly(collectedOffset + serviceLevel.transitDays),
    deliveredAt: status === 'delivered' ? at(collectedOffset + serviceLevel.transitDays, 14) : null,
    podSignatory: status === 'delivered' ? pick(['A. Reyes', 'M. Fitz', 'Goods In', 'K. Osei']) : null,
    freightChargeGbp: money(80, 2_400),
    fuelSurchargePct: 11.5,
    customsDeclarationId: ['NL', 'DE', 'FR', 'ES', 'PL', 'IE', 'US', 'CN', 'IN'].includes(customer.address.countryCode) ? `dec-${String(index + 1).padStart(4, '0')}` : null,
    exceptionCode: status === 'exception' ? pick(['DAMAGED', 'REFUSED', 'ADDRESS_INVALID', 'MISSING_PIECES']) : null,
    events: buildTrackingEvents(status, collectedOffset, serviceLevel.transitDays)
  };
});

function buildTrackingEvents(status, collectedOffset, transitDays) {
  const events = [{ at: at(collectedOffset - 1), code: 'BOOKED', description: 'Booking confirmed', location: 'Meridian control tower' }];
  if (['draft', 'booked', 'cancelled'].includes(status)) {
    if (status === 'cancelled') events.push({ at: at(collectedOffset), code: 'CANCELLED', description: 'Booking cancelled by customer', location: 'Meridian control tower' });
    return events;
  }
  events.push({ at: at(collectedOffset), code: 'COLLECTED', description: 'Collected from origin', location: 'Origin depot' });
  events.push({ at: at(collectedOffset + 1), code: 'IN_TRANSIT', description: 'Departed sorting hub', location: 'Hub' });
  if (status === 'customsHold') events.push({ at: at(collectedOffset + 2), code: 'CUSTOMS_HOLD', description: 'Held pending customs documentation', location: 'Border' });
  if (['outForDelivery', 'delivered', 'exception'].includes(status)) {
    events.push({ at: at(collectedOffset + transitDays, 8), code: 'OUT_FOR_DELIVERY', description: 'Out for delivery', location: 'Delivery depot' });
  }
  if (status === 'delivered') events.push({ at: at(collectedOffset + transitDays, 14), code: 'DELIVERED', description: 'Delivered and signed for', location: 'Destination' });
  if (status === 'exception') events.push({ at: at(collectedOffset + transitDays, 13), code: 'EXCEPTION', description: 'Delivery exception raised', location: 'Destination' });
  return events;
}

export const routePlans = Array.from({ length: 16 }, (_, index) => {
  const vehicle = vehicles[index % vehicles.length];
  const driver = drivers[index % drivers.length];
  const depot = warehouses[index % warehouses.length];
  const stopCount = between(3, 9);
  return {
    id: `rte-${String(index + 1).padStart(4, '0')}`,
    reference: `RT-${dateOnly(index % 7).replace(/-/g, '')}-${String(index + 1).padStart(2, '0')}`,
    planDate: dateOnly(index % 7),
    depotId: depot.id,
    vehicleId: vehicle.id,
    driverId: driver.id,
    status: ['planned', 'dispatched', 'inProgress', 'completed'][index % 4],
    plannedDistanceKm: between(60, 540),
    plannedDurationMinutes: between(90, 620),
    utilisationPct: between(42, 99),
    stops: Array.from({ length: stopCount }, (_, stopIndex) => ({
      id: `stop-${index + 1}-${stopIndex + 1}`,
      sequence: stopIndex + 1,
      shipmentId: shipments[(index * 3 + stopIndex) % shipments.length].id,
      type: stopIndex === 0 ? 'collection' : 'delivery',
      address: customers[(index + stopIndex) % customers.length].addresses[0],
      windowFrom: `${String(8 + stopIndex).padStart(2, '0')}:00`,
      windowTo: `${String(9 + stopIndex).padStart(2, '0')}:30`,
      status: ['pending', 'arrived', 'completed', 'failed'][(index + stopIndex) % 4]
    }))
  };
});

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export const invoices = Array.from({ length: 30 }, (_, index) => {
  const customer = customers[index % customers.length];
  const shipment = shipments[index % shipments.length];
  const net = money(120, 9_400);
  const vat = Math.round(net * 0.2 * 100) / 100;
  const issuedOffset = -between(2, 120);
  const dueOffset = issuedOffset + customer.paymentTermsDays;
  const status = ['draft', 'issued', 'paid', 'overdue', 'disputed', 'creditNoted'][index % 6];
  return {
    id: `inv-${String(index + 1).padStart(4, '0')}`,
    reference: `INV-2026-${String(5000 + index)}`,
    customerId: customer.id,
    shipmentId: shipment.id,
    status,
    issuedOn: dateOnly(issuedOffset),
    dueOn: dateOnly(dueOffset),
    paidOn: status === 'paid' ? dateOnly(dueOffset - between(0, 10)) : null,
    currency: 'GBP',
    netGbp: net,
    vatGbp: vat,
    totalGbp: Math.round((net + vat) * 100) / 100,
    daysOverdue: status === 'overdue' ? between(1, 75) : 0,
    lines: [
      { id: `invl-${index}-1`, description: `Freight — ${shipment.reference}`, quantity: 1, unitPriceGbp: net * 0.78, totalGbp: Math.round(net * 0.78 * 100) / 100 },
      { id: `invl-${index}-2`, description: 'Fuel surcharge 11.5%', quantity: 1, unitPriceGbp: net * 0.115, totalGbp: Math.round(net * 0.115 * 100) / 100 },
      { id: `invl-${index}-3`, description: 'Handling', quantity: 1, unitPriceGbp: net * 0.105, totalGbp: Math.round(net * 0.105 * 100) / 100 }
    ]
  };
});

export const creditNotes = Array.from({ length: 8 }, (_, index) => ({
  id: `crn-${String(index + 1).padStart(4, '0')}`,
  reference: `CN-2026-${String(300 + index)}`,
  invoiceId: invoices[index * 3 % invoices.length].id,
  customerId: customers[index % customers.length].id,
  reason: pick(['Service failure', 'Rating error', 'Goodwill', 'Duplicate invoice', 'Claim settlement']),
  amountGbp: money(40, 1_800),
  status: ['draft', 'approved', 'applied'][index % 3],
  raisedAt: at(-between(1, 60)),
  raisedByUserId: users[2].id
}));

export const rateCards = carriers.map((carrier, index) => ({
  id: `rc-${carrier.id}`,
  carrierId: carrier.id,
  name: `${carrier.name} ${2026} standard`,
  effectiveFrom: dateOnly(-200),
  effectiveTo: dateOnly(index === 2 ? 15 : 200),
  currency: 'GBP',
  minimumChargeGbp: money(28, 95),
  bands: [
    { fromKg: 0, toKg: 50, ratePerKgGbp: money(1.8, 3.4) },
    { fromKg: 50, toKg: 250, ratePerKgGbp: money(1.1, 2.2) },
    { fromKg: 250, toKg: 1000, ratePerKgGbp: money(0.7, 1.5) },
    { fromKg: 1000, toKg: 99999, ratePerKgGbp: money(0.4, 0.95) }
  ],
  surcharges: [
    { code: 'FUEL', name: 'Fuel', percent: 11.5 },
    { code: 'RESI', name: 'Residential delivery', flatGbp: 8.5 },
    { code: 'HAZ', name: 'Hazardous goods', flatGbp: 42 },
    { code: 'TAIL', name: 'Tail lift', flatGbp: 15 }
  ]
}));

// ---------------------------------------------------------------------------
// Customs and claims
// ---------------------------------------------------------------------------

export const declarations = shipments
  .filter(s => s.customsDeclarationId)
  .map((shipment, index) => {
    const hs = HS_CODES[index % HS_CODES.length];
    const value = shipment.declaredValueGbp;
    return {
      id: shipment.customsDeclarationId,
      reference: `DEC-2026-${String(9000 + index)}`,
      shipmentId: shipment.id,
      direction: index % 3 === 0 ? 'import' : 'export',
      status: ['draft', 'submitted', 'accepted', 'held', 'released', 'rejected'][index % 6],
      procedureCode: pick(['4000', '4200', '3151', '1040']),
      hsCode: hs.code,
      goodsDescription: hs.description,
      countryOfOrigin: pick(['CN', 'IN', 'DE', 'GB']),
      declaredValueGbp: value,
      dutyRatePct: hs.dutyPct,
      dutyGbp: Math.round(value * (hs.dutyPct / 100) * 100) / 100,
      vatGbp: Math.round(value * 0.2 * 100) / 100,
      controlled: Boolean(hs.controlled),
      excise: Boolean(hs.excise),
      submittedAt: at(-between(1, 40)),
      holdReason: index % 6 === 3 ? pick(['Documentation incomplete', 'Valuation query', 'Licence required']) : null,
      documents: [
        { id: `doc-${index}-1`, type: 'commercialInvoice', filename: `invoice-${index}.pdf`, uploadedAt: at(-between(1, 30)), sizeKb: between(40, 900) },
        { id: `doc-${index}-2`, type: 'packingList', filename: `packing-${index}.pdf`, uploadedAt: at(-between(1, 30)), sizeKb: between(20, 400) }
      ]
    };
  });

export const claims = Array.from({ length: 14 }, (_, index) => {
  const shipment = shipments[(index * 3) % shipments.length];
  return {
    id: `clm-${String(index + 1).padStart(4, '0')}`,
    reference: `CL-2026-${String(400 + index)}`,
    shipmentId: shipment.id,
    customerId: shipment.customerId,
    carrierId: shipment.carrierId,
    type: ['damage', 'loss', 'delay', 'shortage'][index % 4],
    status: ['submitted', 'investigating', 'awaitingEvidence', 'approved', 'rejected', 'settled'][index % 6],
    claimedAmountGbp: money(60, 12_000),
    settledAmountGbp: index % 6 === 5 ? money(40, 9_000) : null,
    raisedAt: at(-between(2, 90)),
    raisedByUserId: users[index % users.length].id,
    assignedToUserId: users[(index + 2) % users.length].id,
    carrierLiable: index % 3 === 0,
    description: pick([
      'Two pallets arrived with crushed corners and shrink wrap torn.',
      'Consignment short by six cartons against the packing list.',
      'Delivered four days after the agreed window, customer refused.',
      'Temperature excursion recorded in transit on a chilled load.'
    ]),
    evidence: index % 6 >= 2 ? [
      { id: `ev-${index}-1`, type: 'photograph', filename: `damage-${index}-1.jpg`, uploadedAt: at(-between(1, 40)), sizeKb: between(300, 4200) },
      { id: `ev-${index}-2`, type: 'pod', filename: `pod-${index}.pdf`, uploadedAt: at(-between(1, 40)), sizeKb: between(50, 300) }
    ] : []
  };
});

// ---------------------------------------------------------------------------
// Audit and notifications
// ---------------------------------------------------------------------------

export const auditEntries = Array.from({ length: 120 }, (_, index) => ({
  id: `aud-${String(index + 1).padStart(5, '0')}`,
  at: at(-Math.floor(index / 4), 8 + (index % 10)),
  userId: users[index % users.length].id,
  action: pick([
    'shipment.created', 'shipment.cancelled', 'invoice.issued', 'invoice.credited',
    'stock.adjusted', 'route.dispatched', 'user.roleChanged', 'customs.released',
    'claim.settled', 'settings.updated', 'carrier.rateCardChanged', 'order.approved'
  ]),
  entityType: pick(['shipment', 'invoice', 'stock', 'route', 'user', 'declaration', 'claim', 'setting']),
  entityId: `ent-${between(1000, 9999)}`,
  ipAddress: `203.0.113.${between(2, 250)}`,
  correlationId: `cor-${String(index * 7919 % 1000000).padStart(6, '0')}`,
  outcome: index % 17 === 0 ? 'denied' : 'allowed'
}));

export const settings = {
  general: {
    organisationName: 'Meridian Freight Group',
    defaultCurrency: 'GBP',
    defaultWeightUnit: 'kg',
    timezone: 'Europe/London',
    financialYearStartMonth: 4
  },
  operations: {
    autoAllocateStock: true,
    allowBackorders: true,
    defaultServiceLevel: 'STD',
    bookingCutoffTime: '16:00',
    exceptionEscalationHours: 4
  },
  billing: {
    fuelSurchargePct: 11.5,
    vatRatePct: 20,
    invoiceNumberPrefix: 'INV-2026-',
    autoIssueOnDelivery: false,
    creditHoldThresholdPct: 90
  },
  notifications: {
    exceptionEmail: 'control.tower@meridian.test',
    dailySummaryTime: '07:30',
    webhookUrl: 'http://127.0.0.1:4360/hooks/meridian',
    notifyOnCustomsHold: true
  }
};

export const integrations = [
  { id: 'int-1', name: 'Customs gateway (CDS)', kind: 'customs', status: 'connected', lastSyncAt: at(0, 6), failureCount: 0 },
  { id: 'int-2', name: 'Carrier EDI hub', kind: 'edi', status: 'connected', lastSyncAt: at(0, 7), failureCount: 2 },
  { id: 'int-3', name: 'Accounting ledger', kind: 'finance', status: 'degraded', lastSyncAt: at(-2), failureCount: 31 },
  { id: 'int-4', name: 'Telematics feed', kind: 'fleet', status: 'disconnected', lastSyncAt: at(-14), failureCount: 402 }
];

export const apiKeys = [
  { id: 'key-1', name: 'Customer portal', prefix: 'mfk_live_a41c', createdAt: at(-200), lastUsedAt: at(0, 6), scopes: ['shipment:read', 'invoice:read'], status: 'active' },
  { id: 'key-2', name: 'Warehouse scanner', prefix: 'mfk_live_77de', createdAt: at(-120), lastUsedAt: at(0, 7), scopes: ['stock:read', 'stock:adjust'], status: 'active' },
  { id: 'key-3', name: 'Legacy ETL', prefix: 'mfk_live_0b92', createdAt: at(-700), lastUsedAt: at(-240), scopes: [...PERMISSIONS], status: 'active' }
];

/** Everything the application serves, in one object, so a handler takes one dependency. */
export const seed = {
  EPOCH, COUNTRIES, INCOTERMS, SERVICE_LEVELS, HS_CODES, SHIPMENT_STATUSES, PERMISSIONS,
  users, roles, rolePermissions, customers, carriers, warehouses, zones, skus, stock,
  vehicles, drivers, salesOrders, purchaseOrders, shipments, routePlans, invoices,
  creditNotes, rateCards, declarations, claims, auditEntries, settings, integrations, apiKeys
};

export default seed;
